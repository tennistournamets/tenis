-- Stage A: registration rules. Capacity is consumed by approved entries only,
-- the deadline closes public intake, the fee is displayed (no payments).
-- NULL limits keep the previous behaviour for existing tournaments.
alter table public.tournaments
  add column if not exists registration_capacity integer,
  add column if not exists capacity_public boolean not null default true,
  add column if not exists registration_deadline timestamptz,
  add column if not exists entry_fee_mode text,
  add column if not exists entry_fee_minor integer,
  add column if not exists entry_fee_currency text,
  add column if not exists entry_fee_unit text;
do $$
begin
 if not exists (select 1 from pg_constraint where conname='tournaments_registration_capacity_check') then
  alter table public.tournaments add constraint tournaments_registration_capacity_check
   check (registration_capacity is null or registration_capacity > 0);
 end if;
 if not exists (select 1 from pg_constraint where conname='tournaments_entry_fee_check') then
  alter table public.tournaments add constraint tournaments_entry_fee_check check (
   (entry_fee_mode is null or entry_fee_mode in ('free','paid'))
   and (entry_fee_unit is null or entry_fee_unit in ('player','pair','team'))
   and (entry_fee_currency is null or entry_fee_currency ~ '^[A-Z]{3}$')
   and (entry_fee_minor is null or entry_fee_minor >= 0)
   and (case when entry_fee_mode = 'paid'
         then entry_fee_minor is not null and entry_fee_currency is not null and entry_fee_unit is not null
         else entry_fee_minor is null and entry_fee_currency is null and entry_fee_unit is null end));
 end if;
end $$;

-- Conditions are public information; contacts stay outside the grant.
revoke select on public.tournaments from anon, authenticated;
grant select (
  id, name, slug, description, sport, format, category, set_format, status,
  is_public, doubles_pairing_mode, format_config, scoring_config, created_by,
  created_at, updated_at, settings_revision, publish_contact,
  registration_capacity, capacity_public, registration_deadline,
  entry_fee_mode, entry_fee_minor, entry_fee_currency, entry_fee_unit
) on public.tournaments to anon, authenticated;

-- Seats are entries, except random-pairing doubles where every person counts.
create or replace function public.registration_occupancy(p_tournament_id uuid, p_exclude_entry uuid default null)
returns integer language sql stable set search_path=public as $$
 select case when t.category='doubles' and t.doubles_pairing_mode='pick_random'
  then coalesce((select count(*)::int from entry_members em join entries e on e.id=em.entry_id
    where e.tournament_id=t.id and e.status='approved' and (p_exclude_entry is null or e.id<>p_exclude_entry)),0)
  else coalesce((select count(*)::int from entries e
    where e.tournament_id=t.id and e.status='approved' and (p_exclude_entry is null or e.id<>p_exclude_entry)),0) end
 from tournaments t where t.id=p_tournament_id;
$$;
revoke execute on function public.registration_occupancy(uuid,uuid) from public, anon, authenticated;

-- Single source of truth for "is registration accepting" on the client and the server.
-- The numbers are public data (approved entries are visible anyway);
-- capacity_public only tells the public page whether to display them.
create or replace function public.tournament_registration_state(p_tournament_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare t tournaments%rowtype; v_occ integer; v_full boolean; v_deadline boolean; v_reason text;
begin
 select * into t from tournaments where id=p_tournament_id;
 if t.id is null then return null; end if;
 if not (t.is_public or is_tournament_admin(t.id) or can_live_score(t.id)) then return null; end if;
 v_occ:=registration_occupancy(t.id,null);
 v_full:=t.registration_capacity is not null and v_occ>=t.registration_capacity;
 v_deadline:=t.registration_deadline is not null and now()>=t.registration_deadline;
 v_reason:=case when t.status<>'registration_open' then 'status' when v_deadline then 'deadline' when v_full then 'full' end;
 return jsonb_build_object(
  'status',t.status,
  'accepting',v_reason is null,
  'closed_reason',v_reason,
  'capacity_unit',case when t.category='doubles' and t.doubles_pairing_mode='pick_random' then 'players' else 'entries' end,
  'capacity_public',t.capacity_public,
  'capacity',t.registration_capacity,
  'occupied',v_occ,
  'free',case when t.registration_capacity is not null then greatest(t.registration_capacity-v_occ,0) end,
  'is_full',v_full,
  'deadline_at',t.registration_deadline,
  'deadline_passed',v_deadline,
  'fee',case when t.entry_fee_mode is null then null else jsonb_build_object('mode',t.entry_fee_mode,
   'amount_minor',t.entry_fee_minor,'currency',t.entry_fee_currency,'unit',t.entry_fee_unit) end);
end;
$$;
revoke execute on function public.tournament_registration_state(uuid) from public;
grant execute on function public.tournament_registration_state(uuid) to anon, authenticated;

-- Re-created rather than replaced so the forward chain can be replayed after
-- later releases change its result type.
drop function if exists register_entry(text, tournament_category, text, text, text, text);
create function register_entry(
  p_slug text,
  p_entry_type tournament_category,
  p_phone_or_email text,
  p_member_one text,
  p_member_two text default null,
  p_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament tournaments;
  v_entry_id uuid;
  v_display_name text;
begin
  select *
    into v_tournament
  from tournaments
  where slug = p_slug
  limit 1;

  if v_tournament.id is null then
    raise exception 'Tournament not found';
  end if;

  if v_tournament.is_public is false then
    raise exception 'Tournament is private';
  end if;

  if v_tournament.status <> 'registration_open' then
    raise exception 'Registration is closed';
  end if;

  if v_tournament.registration_deadline is not null and now() >= v_tournament.registration_deadline then
    raise exception 'registration.deadlinePassed';
  end if;

  if v_tournament.registration_capacity is not null
     and registration_occupancy(v_tournament.id, null) >= v_tournament.registration_capacity then
    raise exception 'registration.full';
  end if;

  if v_tournament.category <> p_entry_type then
    raise exception 'Invalid category for tournament';
  end if;

  if p_entry_type = 'singles' and (p_member_one is null or btrim(p_member_one) = '') then
    raise exception 'Single entry requires one participant';
  end if;

  if p_entry_type = 'doubles' then
    if p_member_one is null or btrim(p_member_one) = '' then
      raise exception 'Double entry requires at least one participant';
    end if;
    if v_tournament.doubles_pairing_mode <> 'pick_random'
       and (p_member_two is null or btrim(p_member_two) = '') then
      raise exception 'Double entry requires two participants';
    end if;
  end if;

  if p_phone_or_email is null or btrim(p_phone_or_email) = '' then
    raise exception 'Contact info is required';
  end if;

  if btrim(p_phone_or_email) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     and btrim(p_phone_or_email) !~ '^\+?[0-9\s\-\(\)]{7,20}$' then
    raise exception 'Invalid phone number or email';
  end if;

  if exists (
    select 1
    from entries e
    where e.tournament_id = v_tournament.id
      and e.phone_or_email = p_phone_or_email
      and e.status in ('pending', 'approved')
  ) then
    raise exception 'Registration already exists for this contact';
  end if;

  if p_display_name is not null and btrim(p_display_name) <> '' then
    v_display_name := p_display_name;
  elsif p_entry_type = 'singles' then
    v_display_name := p_member_one;
  elsif p_member_two is not null and btrim(p_member_two) <> '' then
    v_display_name := p_member_one || ' / ' || p_member_two;
  else
    v_display_name := p_member_one;
  end if;

  insert into entries (
    tournament_id,
    entry_type,
    display_name,
    phone_or_email,
    status
  ) values (
    v_tournament.id,
    p_entry_type,
    v_display_name,
    p_phone_or_email,
    'pending'
  )
  returning id into v_entry_id;

  insert into entry_members (entry_id, member_name, member_order)
  values (v_entry_id, p_member_one, 1);

  if p_entry_type = 'doubles' and p_member_two is not null and btrim(p_member_two) <> '' then
    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_id, p_member_two, 2);
  end if;

  return v_entry_id;
end;
$$;
revoke execute on function register_entry(text, tournament_category, text, text, text, text) from public;
grant execute on function register_entry(text, tournament_category, text, text, text, text) to anon, authenticated;

-- Every path that makes an entry approved (RPC, direct UPDATE, bulk UPDATE,
-- manual INSERT) is checked here. The tournament row lock serialises
-- concurrent approvals so the last seat cannot be taken twice.
create or replace function public.enforce_entry_capacity()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_capacity integer; v_players boolean; v_size integer;
begin
 if new.status<>'approved' or (tg_op='UPDATE' and old.status='approved') then return new; end if;
 select registration_capacity, category='doubles' and doubles_pairing_mode='pick_random'
  into v_capacity, v_players from tournaments where id=new.tournament_id for update;
 if v_capacity is null then return new; end if;
 -- People of a random-pairing entry are counted when its members are written.
 v_size:=case when v_players then (select count(*)::int from entry_members where entry_id=new.id) else 1 end;
 if registration_occupancy(new.tournament_id,new.id)+v_size>v_capacity then raise exception 'registration.full'; end if;
 return new;
end;
$$;
revoke execute on function public.enforce_entry_capacity() from public, anon, authenticated;
drop trigger if exists trg_entries_capacity on entries;
create trigger trg_entries_capacity before insert or update of status on entries
 for each row execute function enforce_entry_capacity();

-- Pair formation moves members between entries inside one transaction, so the
-- per-person check is deferred to commit where the count is consistent again.
create or replace function public.enforce_member_capacity()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_tid uuid; v_approved boolean; v_capacity integer; v_players boolean;
begin
 select e.tournament_id, e.status='approved', t.registration_capacity, t.category='doubles' and t.doubles_pairing_mode='pick_random'
  into v_tid, v_approved, v_capacity, v_players
  from entries e join tournaments t on t.id=e.tournament_id where e.id=new.entry_id;
 if v_tid is null or not v_approved or v_capacity is null or not v_players then return null; end if;
 if registration_occupancy(v_tid,null)>v_capacity then raise exception 'registration.full'; end if;
 return null;
end;
$$;
revoke execute on function public.enforce_member_capacity() from public, anon, authenticated;
drop trigger if exists trg_entry_members_capacity on entry_members;
create constraint trigger trg_entry_members_capacity after insert or update of entry_id on entry_members
 deferrable initially deferred for each row execute function enforce_member_capacity();

-- "Approve all" keeps submission order and reports who did not fit.
create or replace function public.approve_pending_entries(p_tournament_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t tournaments%rowtype; e record; v_approved integer:=0; v_skipped integer:=0; v_size integer; v_players boolean;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into t from tournaments where id=p_tournament_id for update;
 if t.id is null then raise exception 'Tournament not found'; end if;
 v_players:=t.category='doubles' and t.doubles_pairing_mode='pick_random';
 for e in select id from entries where tournament_id=p_tournament_id and status='pending' order by created_at,id loop
  v_size:=case when v_players then greatest((select count(*)::int from entry_members where entry_id=e.id),1) else 1 end;
  if t.registration_capacity is null or registration_occupancy(p_tournament_id,null)+v_size<=t.registration_capacity then
   update entries set status='approved' where id=e.id;
   v_approved:=v_approved+1;
  else
   v_skipped:=v_skipped+1;
  end if;
 end loop;
 return jsonb_build_object('approved',v_approved,'skipped',v_skipped);
end;
$$;
revoke execute on function public.approve_pending_entries(uuid) from public, anon, authenticated;
grant execute on function public.approve_pending_entries(uuid) to authenticated;

create or replace function update_tournament_settings(p_tournament_id uuid,p_patch jsonb,p_expected_revision integer,p_expected_matches jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_old tournaments%rowtype; v_new tournaments%rowtype; k text; v_category_changed boolean;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_old from tournaments where id=p_tournament_id for update;
 if v_old.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_old.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Invalid settings'; end if;
 for k in select jsonb_object_keys(p_patch) loop
  if k<>all(array['name','description','category','set_format','scoring_config','doubles_pairing_mode','status','is_public','contact_phone','contact_email','publish_contact',
   'registration_capacity','capacity_public','registration_deadline','entry_fee_mode','entry_fee_minor','entry_fee_currency','entry_fee_unit']) then raise exception 'Unsupported settings field'; end if;
 end loop;
 v_new:=jsonb_populate_record(v_old,p_patch);
 if v_new.name is null or btrim(v_new.name)='' or v_new.is_public is null or v_new.scoring_config is null or v_new.publish_contact is null or v_new.capacity_public is null then raise exception 'Invalid settings'; end if;
 if v_new.publish_contact and nullif(btrim(coalesce(v_new.contact_phone,'')),'') is null and nullif(btrim(coalesce(v_new.contact_email,'')),'') is null then raise exception 'Contact required'; end if;
 if v_new.registration_capacity is not null and v_new.registration_capacity<=0 then raise exception 'registration.invalidCapacity'; end if;
 -- Lowering the limit never removes approved participants silently.
 if v_new.registration_capacity is not null and v_new.registration_capacity is distinct from v_old.registration_capacity
    and v_new.registration_capacity<registration_occupancy(p_tournament_id,null) then raise exception 'registration.capacityBelowOccupied'; end if;
 if v_new.entry_fee_mode is distinct from 'paid' then
  v_new.entry_fee_minor:=null; v_new.entry_fee_currency:=null; v_new.entry_fee_unit:=null;
  if v_new.entry_fee_mode is not null and v_new.entry_fee_mode<>'free' then raise exception 'registration.invalidFee'; end if;
 else
  v_new.entry_fee_currency:=upper(btrim(coalesce(v_new.entry_fee_currency,'')));
  if v_new.entry_fee_minor is null or v_new.entry_fee_minor<0 or v_new.entry_fee_currency!~'^[A-Z]{3}$'
     or v_new.entry_fee_unit is null or v_new.entry_fee_unit<>all(array['player','pair','team']) then raise exception 'registration.invalidFee'; end if;
 end if;
 v_category_changed:=v_old.category is distinct from v_new.category;
 if v_category_changed then
  if v_old.status in ('in_progress','completed') then raise exception 'drafts.rulesLocked'; end if;
  perform 1 from matches where tournament_id=p_tournament_id order by id for update nowait;
  if exists(select 1 from matches where tournament_id=p_tournament_id) and p_expected_matches is distinct from tournament_match_versions(p_tournament_id) then raise exception 'drafts.structureConflict'; end if;
  if exists(select 1 from matches where tournament_id=p_tournament_id and (status='finished' or winner_entry_id is not null))
    or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=p_tournament_id)
    or exists(select 1 from live_scores where tournament_id=p_tournament_id) then raise exception 'drafts.rulesLocked'; end if;
 end if;
 update tournaments set name=v_new.name,description=v_new.description,category=v_new.category,set_format=v_new.set_format,
  scoring_config=v_new.scoring_config,doubles_pairing_mode=v_new.doubles_pairing_mode,status=v_new.status,is_public=v_new.is_public,
  contact_phone=nullif(btrim(coalesce(v_new.contact_phone,'')),''),contact_email=nullif(btrim(coalesce(v_new.contact_email,'')),''),publish_contact=v_new.publish_contact,
  registration_capacity=v_new.registration_capacity,capacity_public=v_new.capacity_public,registration_deadline=v_new.registration_deadline,
  entry_fee_mode=v_new.entry_fee_mode,entry_fee_minor=v_new.entry_fee_minor,entry_fee_currency=v_new.entry_fee_currency,entry_fee_unit=v_new.entry_fee_unit
 where id=p_tournament_id returning * into v_new;
 if v_category_changed then delete from matches where tournament_id=p_tournament_id; end if;
 return to_jsonb(v_new);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
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
   'entry_fee_mode',t.entry_fee_mode,'entry_fee_minor',t.entry_fee_minor,'entry_fee_currency',t.entry_fee_currency,'entry_fee_unit',t.entry_fee_unit),
  'registration', tournament_registration_state(t.id),
  'entries', coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,
   'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,
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
