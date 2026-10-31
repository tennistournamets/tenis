-- =============================================
-- CHECK-IN
-- =============================================
-- On the tournament day organizers (owners, editors) mark who came
-- (entries.checked_in_at). The absent ones are then dealt with in one step:
-- before the start their entries are rejected without an email, so the draw
-- leaves them out; while the tournament runs they withdraw (unplayed matches
-- become walkovers). At least one participant must be checked in, so an
-- unused check-in never empties the field. Safe to re-run.

alter table public.entries add column if not exists checked_in_at timestamptz;
grant select (checked_in_at) on public.entries to anon, authenticated;

create or replace function public.set_entry_checked_in(p_entry_id uuid, p_checked_in boolean)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  e entries%rowtype;
  v_status tournament_status;
begin
  select * into e from entries where id = p_entry_id for update;
  if e.id is null then raise exception 'entryEdit.notFound'; end if;
  if not is_tournament_admin(e.tournament_id) then raise exception 'Not allowed'; end if;
  select status into v_status from tournaments where id = e.tournament_id;
  if v_status = 'completed' then raise exception 'checkIn.completed'; end if;
  if e.status <> 'approved' then raise exception 'checkIn.notApproved'; end if;
  update entries
     set checked_in_at = case when coalesce(p_checked_in, false) then coalesce(checked_in_at, now()) end
   where id = e.id
  returning checked_in_at into e.checked_in_at;
  return e.checked_in_at;
end;
$$;
revoke execute on function public.set_entry_checked_in(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_entry_checked_in(uuid, boolean) to authenticated;

-- Rejects (before the start) or withdraws (while it runs) every approved
-- participant who is not checked in. Returns how many.
create or replace function public.remove_absent_entries(p_tournament_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  t tournaments%rowtype;
  r record;
  n integer := 0;
begin
  if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
  select * into t from tournaments where id = p_tournament_id for update;
  if t.id is null then raise exception 'Tournament not found'; end if;
  if t.status = 'completed' then raise exception 'checkIn.completed'; end if;
  if not exists (select 1 from entries where tournament_id = t.id and status = 'approved' and checked_in_at is not null) then
    raise exception 'checkIn.noneChecked';
  end if;

  if t.status <> 'in_progress' then
    perform set_config('bracketa.quiet_entries', 'on', true);
    update entries set status = 'rejected'
     where tournament_id = t.id and status = 'approved' and checked_in_at is null;
    get diagnostics n = row_count;
    perform set_config('bracketa.quiet_entries', '', true);
    return n;
  end if;

  for r in
    select id from entries
    where tournament_id = t.id and status = 'approved' and checked_in_at is null and withdrawn_at is null
    order by seed_order nulls last, created_at, id
  loop
    perform set_entry_withdrawn(r.id, true);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.remove_absent_entries(uuid) from public, anon, authenticated;
grant execute on function public.remove_absent_entries(uuid) to authenticated;

-- The snapshots carry checked_in_at (pair editor CAS and sync state agree).
create or replace function tournament_entry_snapshot(p_tournament_id uuid)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,'seed_order',e.seed_order,
  'withdrawn_at',e.withdrawn_at,'checked_in_at',e.checked_in_at,
  'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,'member_name',em.member_name,'member_order',em.member_order) order by em.member_order) from entry_members em where em.entry_id=e.id),'[]'::jsonb)) order by e.id),'[]')
 from entries e where e.tournament_id=p_tournament_id;
$$;

create or replace function get_tournament_sync_state(p_tournament_id uuid)
returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object(
  'tournament', jsonb_build_object('id',t.id,'name',t.name,'slug',t.slug,'description',t.description,
   'sport',t.sport,'format',t.format,'category',t.category,'status',t.status,'set_format',t.set_format,
   'is_public',t.is_public,'doubles_pairing_mode',t.doubles_pairing_mode,'format_config',t.format_config,
   'scoring_config',t.scoring_config,'settings_revision',t.settings_revision,
   'publish_contact',coalesce((tournament_public_contact(t.id)->>'published')::boolean,false),
   'contact_phone',tournament_public_contact(t.id)->>'phone','contact_email',tournament_public_contact(t.id)->>'email',
   'registration_capacity',t.registration_capacity,'capacity_public',t.capacity_public,'registration_deadline',t.registration_deadline,
   'entry_fee_mode',t.entry_fee_mode,'entry_fee_minor',t.entry_fee_minor,'entry_fee_currency',t.entry_fee_currency,'entry_fee_unit',t.entry_fee_unit,
   'waitlist_enabled',t.waitlist_enabled,'schedule_config',t.schedule_config,'schedule_published_at',t.schedule_published_at,'visibility',t.visibility,
   'venue_address',t.venue_address,'venue_lat',t.venue_lat,'venue_lng',t.venue_lng,
   'access_password_set',tournament_password_set(t.id),'player_rating',t.player_rating),
  'registration', tournament_registration_state(t.id),
  'entries', coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,
   'entry_type',e.entry_type,'status',e.status,'withdrawn_at',e.withdrawn_at,'checked_in_at',e.checked_in_at,'created_at',e.created_at,'seed_order',e.seed_order,
   'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,
    'member_name',em.member_name,'member_order',em.member_order) order by em.member_order,em.id)
    from entry_members em where em.entry_id=e.id),'[]'::jsonb)) order by e.created_at,e.id)
   from entries e where e.tournament_id=t.id),'[]'::jsonb),
  'matches',coalesce((select jsonb_agg(to_jsonb(m) order by m.round_number,m.match_number,m.id)
   from matches m where m.tournament_id=t.id),'[]'::jsonb),
  'sets',coalesce((select jsonb_agg(to_jsonb(s) order by s.match_id,s.set_index)
   from match_sets s join matches m on m.id=s.match_id where m.tournament_id=t.id),'[]'::jsonb),
  'live',coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from live_scores l where l.tournament_id=t.id),'[]'::jsonb),
  'groups',coalesce((select jsonb_agg(to_jsonb(g) order by g.group_index,g.id)
   from groups g where g.tournament_id=t.id),'[]'::jsonb),
  'courts',coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.name,c.id) from courts c where c.tournament_id=t.id),'[]'::jsonb),
  'schedule',coalesce((select jsonb_agg(to_jsonb(s) order by s.state,s.match_id) from match_schedule s where s.tournament_id=t.id),'[]'::jsonb),
  'standings',case when t.format='round_robin' then
   coalesce((select jsonb_agg(to_jsonb(s) order by s.rank,s.entry_id) from get_standings(t.id,null) s),'[]'::jsonb)
   else '[]'::jsonb end,
  'group_standings',case when t.format='groups_playoff' then
   coalesce((select jsonb_object_agg(g.id,coalesce((select jsonb_agg(to_jsonb(s) order by s.rank,s.entry_id)
    from get_standings(t.id,g.id) s),'[]'::jsonb)) from groups g where g.tournament_id=t.id),'{}'::jsonb)
   else '{}'::jsonb end,
  'points_standings',case when format_is_points(t.format) then
   coalesce((select jsonb_agg(to_jsonb(s) order by s.rank,s.entry_id) from get_points_standings(t.id) s),'[]'::jsonb)
   else '[]'::jsonb end
 ) from tournaments t where t.id=p_tournament_id;
$$;

notify pgrst, 'reload schema';
