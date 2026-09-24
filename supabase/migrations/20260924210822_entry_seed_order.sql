-- Manual seeding: organizers order the approved field before the draw. The
-- order feeds every generator that already reads entries.seed_order (manual
-- bracket draw, group snake distribution); a random draw ignores it. Entries
-- stay writable through status only, so the order goes through one RPC that
-- checks the caller, the field and the tournament stage.
-- Safe to re-run: both functions are replaced and grants restated.
create or replace function public.set_entry_seed_order(p_tournament_id uuid, p_entry_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status tournament_status;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  select status into v_status from tournaments where id = p_tournament_id for update;
  if v_status is null then
    raise exception 'Tournament not found';
  end if;
  if v_status in ('in_progress', 'completed') then
    raise exception using errcode = '22023', message = 'seeding.locked';
  end if;
  if coalesce(array_length(p_entry_ids, 1), 0) <> (select count(distinct x) from unnest(p_entry_ids) x) then
    raise exception using errcode = '22023', message = 'seeding.duplicate';
  end if;
  if exists (
    select 1 from unnest(p_entry_ids) x
    where not exists (select 1 from entries e where e.id = x and e.tournament_id = p_tournament_id and e.status = 'approved')
  ) then
    raise exception using errcode = '22023', message = 'seeding.foreignEntry';
  end if;

  update entries set seed_order = null
  where tournament_id = p_tournament_id and seed_order is not null and not (id = any(p_entry_ids));
  update entries e set seed_order = o.ord
  from unnest(p_entry_ids) with ordinality as o(id, ord)
  where e.id = o.id and e.seed_order is distinct from o.ord;
end;
$$;
revoke execute on function public.set_entry_seed_order(uuid, uuid[]) from public, anon;
grant execute on function public.set_entry_seed_order(uuid, uuid[]) to authenticated;

-- The CAS view of entries (pairing saves compare against it) must describe an
-- entry exactly like the snapshot the client sends back, seed_order included.
create or replace function tournament_entry_snapshot(p_tournament_id uuid)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,'seed_order',e.seed_order,
  'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,'member_name',em.member_name,'member_order',em.member_order) order by em.member_order) from entry_members em where em.entry_id=e.id),'[]'::jsonb)) order by e.id),'[]')
 from entries e where e.tournament_id=p_tournament_id;
$$;

-- The snapshot now carries seed_order so the admin list shows the draw order.
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
   'access_password_set',tournament_password_set(t.id)),
  'registration', tournament_registration_state(t.id),
  'entries', coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,
   'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,'seed_order',e.seed_order,
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
   else '{}'::jsonb end
 ) from tournaments t where t.id=p_tournament_id;
$$;

notify pgrst, 'reload schema';
