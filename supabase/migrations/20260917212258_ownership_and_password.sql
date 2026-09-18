-- Stage D+: ownership transfer and password-protected pages.
-- Transfer is atomic and journaled. A password never leaves the server: bcrypt
-- hash, short-lived access tokens (stored hashed), per-tournament lockout.
-- Password viewers read a public projection through a dedicated RPC; RLS still
-- hides the rows, so Realtime is unavailable to them and the client polls.

create table if not exists public.tournament_admin_events (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  actor_user_id uuid,
  action text not null,
  target_user_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_tournament_admin_events_tournament on tournament_admin_events (tournament_id, created_at);
alter table public.tournament_admin_events enable row level security;
drop policy if exists tournament_admin_events_select_admin on tournament_admin_events;
create policy tournament_admin_events_select_admin on tournament_admin_events
for select to authenticated using (is_tournament_admin(tournament_id));
revoke all on public.tournament_admin_events from public, anon, authenticated;
grant select on public.tournament_admin_events to authenticated;

create or replace function public.transfer_tournament_ownership(p_tournament_id uuid, p_new_owner_email text, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_t tournaments%rowtype; v_target uuid; v_caller uuid:=auth.uid();
begin
 if get_my_tournament_role(p_tournament_id) is distinct from 'owner' then raise exception 'Not allowed'; end if;
 select * into v_t from tournaments where id=p_tournament_id for update;
 if v_t.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_t.settings_revision then raise exception 'drafts.conflict'; end if;
 select id into v_target from auth.users where email=lower(trim(coalesce(p_new_owner_email,'')));
 if v_target is null then raise exception 'access.userNotFound'; end if;
 if v_target=v_caller then raise exception 'access.transferSelf'; end if;
 insert into tournament_admins(tournament_id,user_id,role) values(p_tournament_id,v_target,'owner')
  on conflict(tournament_id,user_id) do update set role='owner';
 update tournament_admins set role='editor' where tournament_id=p_tournament_id and user_id=v_caller;
 update tournaments set created_by=v_target where id=p_tournament_id returning * into v_t;
 insert into tournament_admin_events(tournament_id,actor_user_id,action,target_user_id,details)
  values(p_tournament_id,v_caller,'ownership_transferred',v_target,jsonb_build_object('previous_owner',v_caller));
 return jsonb_build_object('new_owner_user_id',v_target,'your_role','editor','settings_revision',v_t.settings_revision);
end;
$$;
revoke execute on function public.transfer_tournament_ownership(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.transfer_tournament_ownership(uuid,text,integer) to authenticated;

-- Fourth mode: the page opens only after the viewer enters the password.
alter table public.tournaments drop constraint if exists tournaments_visibility_check;
alter table public.tournaments add constraint tournaments_visibility_check check (visibility in ('public', 'link', 'private', 'password'));
alter table public.tournaments
  add column if not exists access_password_hash text,
  add column if not exists access_password_version integer not null default 0;

create or replace function public.sync_tournament_visibility()
returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op = 'INSERT' then
  if new.is_public is false and new.visibility not in ('private','password') then new.visibility := 'private'; end if;
 elsif new.visibility is distinct from old.visibility then
  null;
 elsif new.is_public is distinct from old.is_public then
  new.visibility := case when new.is_public then (case when old.visibility in ('private','password') then 'link' else old.visibility end) else 'private' end;
 end if;
 new.is_public := new.visibility not in ('private','password');
 return new;
end;
$$;

create table if not exists public.tournament_access_grants (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  token_hash text not null unique,
  password_version integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_tournament_access_grants_tournament on tournament_access_grants (tournament_id, expires_at);
create table if not exists public.tournament_unlock_attempts (
  tournament_id uuid primary key references tournaments (id) on delete cascade,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.tournament_access_grants enable row level security;
alter table public.tournament_unlock_attempts enable row level security;
revoke all on public.tournament_access_grants, public.tournament_unlock_attempts from public, anon, authenticated;

-- Organizers learn whether a password exists; nobody reads the hash.
create or replace function public.tournament_password_set(p_tournament_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select case when is_tournament_admin(t.id) then t.access_password_hash is not null end from tournaments t where t.id=p_tournament_id;
$$;
revoke execute on function public.tournament_password_set(uuid) from public;
grant execute on function public.tournament_password_set(uuid) to authenticated;

create or replace function public.set_tournament_password(p_tournament_id uuid, p_password text, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_t tournaments%rowtype;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_t from tournaments where id=p_tournament_id for update;
 if v_t.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_t.settings_revision then raise exception 'drafts.conflict'; end if;
 if p_password is null or btrim(p_password)='' then
  if v_t.visibility='password' then raise exception 'access.passwordRequired'; end if;
  update tournaments set access_password_hash=null,access_password_version=access_password_version+1 where id=p_tournament_id returning * into v_t;
 else
  if length(p_password)<4 or length(p_password)>72 then raise exception 'access.passwordTooShort'; end if;
  update tournaments set access_password_hash=extensions.crypt(p_password,extensions.gen_salt('bf',10)),
   access_password_version=access_password_version+1 where id=p_tournament_id returning * into v_t;
 end if;
 -- Every change invalidates issued tokens.
 delete from tournament_access_grants where tournament_id=p_tournament_id;
 delete from tournament_unlock_attempts where tournament_id=p_tournament_id;
 return jsonb_build_object('password_set',v_t.access_password_hash is not null,'settings_revision',v_t.settings_revision);
end;
$$;
revoke execute on function public.set_tournament_password(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.set_tournament_password(uuid,text,integer) to authenticated;

-- Tells an anonymous visitor that a hidden slug is a password page (nothing else).
create or replace function public.tournament_access_mode(p_slug text)
returns text language sql stable security definer set search_path=public as $$
 select case when t.visibility='password' and t.access_password_hash is not null then 'password' end from tournaments t where t.slug=p_slug;
$$;
revoke execute on function public.tournament_access_mode(text) from public;
grant execute on function public.tournament_access_mode(text) to anon, authenticated;

-- Returns {ok:false, error} instead of raising: a raised error would roll back
-- the failed-attempt counter that drives the lockout.
create or replace function public.unlock_tournament(p_slug text, p_password text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_t tournaments%rowtype; v_attempt tournament_unlock_attempts%rowtype; v_token text; v_expires timestamptz;
begin
 select * into v_t from tournaments where slug=p_slug for update;
 if v_t.id is null or v_t.visibility<>'password' or v_t.access_password_hash is null then return jsonb_build_object('ok',false,'error','access.noPassword'); end if;
 select * into v_attempt from tournament_unlock_attempts where tournament_id=v_t.id for update;
 if v_attempt.locked_until is not null and v_attempt.locked_until>now() then return jsonb_build_object('ok',false,'error','access.locked','locked_until',v_attempt.locked_until); end if;
 if p_password is null or extensions.crypt(p_password,v_t.access_password_hash)<>v_t.access_password_hash then
  insert into tournament_unlock_attempts(tournament_id,failed_count,locked_until,updated_at)
   values(v_t.id,1,null,now())
   on conflict(tournament_id) do update set
    failed_count=case when tournament_unlock_attempts.failed_count+1>=10 then 0 else tournament_unlock_attempts.failed_count+1 end,
    locked_until=case when tournament_unlock_attempts.failed_count+1>=10 then now()+interval '15 minutes' else null end,
    updated_at=now();
  return jsonb_build_object('ok',false,'error','access.wrongPassword');
 end if;
 delete from tournament_unlock_attempts where tournament_id=v_t.id;
 delete from tournament_access_grants where tournament_id=v_t.id and expires_at<=now();
 v_token:=encode(extensions.gen_random_bytes(32),'hex');
 v_expires:=now()+interval '12 hours';
 insert into tournament_access_grants(tournament_id,token_hash,password_version,expires_at)
  values(v_t.id,encode(extensions.digest(v_token,'sha256'),'hex'),v_t.access_password_version,v_expires);
 return jsonb_build_object('ok',true,'tournament_id',v_t.id,'token',v_token,'expires_at',v_expires);
end;
$$;
revoke execute on function public.unlock_tournament(text,text) from public;
grant execute on function public.unlock_tournament(text,text) to anon, authenticated;

create or replace function public.valid_access_token(p_tournament_id uuid, p_token text)
returns boolean language sql stable security definer set search_path=public as $$
 select p_token is not null and exists(
  select 1 from tournament_access_grants g join tournaments t on t.id=g.tournament_id
  where g.tournament_id=p_tournament_id and t.visibility='password'
    and g.token_hash=encode(extensions.digest(p_token,'sha256'),'hex')
    and g.expires_at>now() and g.password_version=t.access_password_version);
$$;
revoke execute on function public.valid_access_token(uuid,text) from public, anon, authenticated;

create or replace function public.tournament_registration_state(p_tournament_id uuid, p_trusted boolean)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare t tournaments%rowtype; v_occ integer; v_full boolean; v_deadline boolean; v_reason text; v_waitlist integer;
begin
 select * into t from tournaments where id=p_tournament_id;
 if t.id is null then return null; end if;
 if not p_trusted and not (t.is_public or is_tournament_admin(t.id) or can_live_score(t.id)) then return null; end if;
 v_occ:=registration_occupancy(t.id,null);
 v_full:=t.registration_capacity is not null and v_occ>=t.registration_capacity;
 v_deadline:=t.registration_deadline is not null and now()>=t.registration_deadline;
 v_reason:=case when t.status<>'registration_open' then 'status' when v_deadline then 'deadline' when v_full then 'full' end;
 select count(*)::int into v_waitlist from entries where tournament_id=t.id and status='waitlisted';
 return jsonb_build_object(
  'status',t.status,
  'accepting',v_reason is null,
  'closed_reason',v_reason,
  'waitlist_enabled',t.waitlist_enabled,
  'waitlist_open',v_reason='full' and t.waitlist_enabled,
  'waitlist_count',v_waitlist,
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
create or replace function public.tournament_registration_state(p_tournament_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select tournament_registration_state(p_tournament_id,false);
$$;
revoke execute on function public.tournament_registration_state(uuid,boolean) from public, anon, authenticated;
revoke execute on function public.tournament_registration_state(uuid) from public;
grant execute on function public.tournament_registration_state(uuid) to anon, authenticated;

-- Registration by access token for password pages; the previous signature is replaced.
drop function if exists register_entry(text, tournament_category, text, text, text, text);
drop function if exists register_entry(text, tournament_category, text, text, text, text, text);
create function register_entry(
  p_slug text,
  p_entry_type tournament_category,
  p_phone_or_email text,
  p_member_one text,
  p_member_two text default null,
  p_display_name text default null,
  p_access_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament tournaments;
  v_entry_id uuid;
  v_display_name text;
  v_status registration_status := 'pending';
begin
  select *
    into v_tournament
  from tournaments
  where slug = p_slug
  limit 1;

  if v_tournament.id is null then
    raise exception 'Tournament not found';
  end if;

  if v_tournament.is_public is false
     and not (v_tournament.visibility = 'password' and valid_access_token(v_tournament.id, p_access_token)) then
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
    if v_tournament.waitlist_enabled then
      v_status := 'waitlisted';
    else
      raise exception 'registration.full';
    end if;
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
      and e.status in ('pending', 'approved', 'waitlisted')
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
    v_status
  )
  returning id into v_entry_id;

  insert into entry_members (entry_id, member_name, member_order)
  values (v_entry_id, p_member_one, 1);

  if p_entry_type = 'doubles' and p_member_two is not null and btrim(p_member_two) <> '' then
    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_id, p_member_two, 2);
  end if;

  return jsonb_build_object('id', v_entry_id, 'status', v_status);
end;
$$;
revoke execute on function register_entry(text, tournament_category, text, text, text, text, text) from public;
grant execute on function register_entry(text, tournament_category, text, text, text, text, text) to anon, authenticated;

create or replace function update_tournament_settings(p_tournament_id uuid,p_patch jsonb,p_expected_revision integer,p_expected_matches jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_old tournaments%rowtype; v_new tournaments%rowtype; k text; v_category_changed boolean; v_tz text;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_old from tournaments where id=p_tournament_id for update;
 if v_old.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_old.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Invalid settings'; end if;
 for k in select jsonb_object_keys(p_patch) loop
  if k<>all(array['name','description','category','set_format','scoring_config','doubles_pairing_mode','status','is_public','contact_phone','contact_email','publish_contact',
   'registration_capacity','capacity_public','registration_deadline','entry_fee_mode','entry_fee_minor','entry_fee_currency','entry_fee_unit','waitlist_enabled',
   'schedule_config','visibility']) then raise exception 'Unsupported settings field'; end if;
 end loop;
 v_new:=jsonb_populate_record(v_old,p_patch);
 if v_new.name is null or btrim(v_new.name)='' or v_new.is_public is null or v_new.scoring_config is null or v_new.publish_contact is null or v_new.capacity_public is null or v_new.waitlist_enabled is null then raise exception 'Invalid settings'; end if;
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
 -- Schedule settings: a minimum rest in whole minutes and an IANA time zone name.
 if v_new.schedule_config is null or jsonb_typeof(v_new.schedule_config) is distinct from 'object' then raise exception 'schedule.invalidConfig'; end if;
 for k in select jsonb_object_keys(v_new.schedule_config) loop
  if k<>all(array['min_rest_minutes','timezone']) then raise exception 'schedule.invalidConfig'; end if;
 end loop;
 if v_new.schedule_config ? 'min_rest_minutes' and (jsonb_typeof(v_new.schedule_config->'min_rest_minutes') is distinct from 'number'
    or (v_new.schedule_config->>'min_rest_minutes')::numeric<0 or (v_new.schedule_config->>'min_rest_minutes')::numeric<>floor((v_new.schedule_config->>'min_rest_minutes')::numeric)) then
  raise exception 'schedule.invalidConfig';
 end if;
 if v_new.schedule_config ? 'timezone' then
  v_tz:=v_new.schedule_config->>'timezone';
  if jsonb_typeof(v_new.schedule_config->'timezone') is distinct from 'string' or v_tz!~'^[A-Za-z_]+(/[A-Za-z0-9_+\-]+)*$' or length(v_tz)>64 then raise exception 'schedule.invalidConfig'; end if;
 end if;
 if v_new.visibility is null or v_new.visibility<>all(array['public','link','private','password']) then raise exception 'access.invalidVisibility'; end if;
 if v_new.visibility='password' and v_old.access_password_hash is null then raise exception 'access.passwordRequired'; end if;
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
  entry_fee_mode=v_new.entry_fee_mode,entry_fee_minor=v_new.entry_fee_minor,entry_fee_currency=v_new.entry_fee_currency,entry_fee_unit=v_new.entry_fee_unit,
  waitlist_enabled=v_new.waitlist_enabled,schedule_config=v_new.schedule_config,visibility=v_new.visibility
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
   'entry_fee_mode',t.entry_fee_mode,'entry_fee_minor',t.entry_fee_minor,'entry_fee_currency',t.entry_fee_currency,'entry_fee_unit',t.entry_fee_unit,
   'waitlist_enabled',t.waitlist_enabled,'schedule_config',t.schedule_config,'schedule_published_at',t.schedule_published_at,'visibility',t.visibility,
   'access_password_set',tournament_password_set(t.id)),
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

-- Password viewers get the same snapshot reduced to its public projection.
create or replace function public.get_tournament_sync_state_with_token(p_tournament_id uuid, p_token text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
 if not valid_access_token(p_tournament_id,p_token) then raise exception 'access.tokenExpired'; end if;
 v:=get_tournament_sync_state(p_tournament_id);
 if v is null then return null; end if;
 v:=jsonb_set(v,'{entries}',coalesce((select jsonb_agg(e) from jsonb_array_elements(v->'entries') e where e->>'status'='approved'),'[]'::jsonb));
 v:=jsonb_set(v,'{schedule}',coalesce((select jsonb_agg(s) from jsonb_array_elements(v->'schedule') s where s->>'state'='published'),'[]'::jsonb));
 v:=jsonb_set(v,'{registration}',coalesce(tournament_registration_state(p_tournament_id,true),'null'::jsonb));
 v:=jsonb_set(v,'{tournament,access_password_set}','null'::jsonb);
 v:=jsonb_set(v,'{tournament,contact_phone}','null'::jsonb);
 v:=jsonb_set(v,'{tournament,contact_email}','null'::jsonb);
 v:=jsonb_set(v,'{tournament,publish_contact}','false'::jsonb);
 return v;
end;
$$;
revoke execute on function public.get_tournament_sync_state_with_token(uuid,text) from public;
grant execute on function public.get_tournament_sync_state_with_token(uuid,text) to anon, authenticated;
notify pgrst, 'reload schema';
