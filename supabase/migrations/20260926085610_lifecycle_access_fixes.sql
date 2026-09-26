-- Lifecycle, access and entries fixes (QA stream C). Safe to re-run: functions
-- are replaced, tables and columns are created only when missing, grants are
-- restated.
--
-- 1. A completed tournament cannot be moved back to an earlier status.
-- 2. Page-password attempts are counted per client (hashed IP + browser id),
--    so one visitor guessing passwords no longer locks the page for everyone;
--    the tournament-wide counter only slows attempts down for a minute.
-- 3. Adding an assistant who is already on the team no longer changes their
--    role silently, and an unknown email gets a neutral translated error.
-- 4. Organizers (owner, editor) read applicants' contacts through one RPC.
-- 5. Entries added by an organizer go through an RPC with the same contact
--    normalisation and duplicate check as the public registration.
-- 6. Validation: participant name length, a pair made of the same player,
--    organizer phone/email, waitlist without a limit, fee unit and zero fee.

-- ---------------------------------------------------------------------------
-- Shared entry validation
-- ---------------------------------------------------------------------------

-- A name compared the way a person reads it: case and repeated spaces ignored.
create or replace function public.entry_name_key(p_name text)
returns text language sql immutable set search_path=public as $$
 select lower(regexp_replace(btrim(coalesce(p_name,'')),'\s+',' ','g'));
$$;
revoke execute on function public.entry_name_key(text) from public, anon, authenticated;

create or replace function public.validate_entry_names(p_entry_type tournament_category, p_member_one text, p_member_two text, p_display_name text)
returns void language plpgsql immutable set search_path=public as $$
begin
 if length(btrim(coalesce(p_member_one,'')))>100 or length(btrim(coalesce(p_member_two,'')))>100
    or length(btrim(coalesce(p_display_name,'')))>160 then
  raise exception 'registration.nameTooLong';
 end if;
 if p_entry_type='doubles' and nullif(btrim(coalesce(p_member_two,'')),'') is not null
    and entry_name_key(p_member_one)=entry_name_key(p_member_two) then
  raise exception 'registration.samePlayer';
 end if;
end;
$$;
revoke execute on function public.validate_entry_names(tournament_category,text,text,text) from public, anon, authenticated;

-- One duplicate rule for every way an entry is added: the same legacy
-- contact, the same email (case-insensitive) or the same phone digits among
-- active entries of the tournament.
create or replace function public.entry_contact_taken(p_tournament_id uuid, p_contact text, p_phone text, p_email text)
returns boolean language sql stable set search_path=public as $$
 select exists (
  select 1 from entries e
  where e.tournament_id=p_tournament_id
    and e.status in ('pending','approved','waitlisted')
    and (
      (p_contact is not null and e.phone_or_email=p_contact)
      or (p_email is not null and e.contact_email=lower(p_email))
      or (p_phone is not null and e.contact_phone is not null
          and regexp_replace(e.contact_phone,'\D','','g')=regexp_replace(p_phone,'\D','','g'))
    )
 );
$$;
revoke execute on function public.entry_contact_taken(uuid,text,text,text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public registration: same signature, plus name validation and the shared
-- duplicate check.
-- ---------------------------------------------------------------------------
create or replace function register_entry(
  p_slug text,
  p_entry_type tournament_category,
  p_phone_or_email text default null,
  p_member_one text default null,
  p_member_two text default null,
  p_display_name text default null,
  p_access_token text default null,
  p_phone text default null,
  p_email text default null
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
  v_phone text;
  v_email text;
  v_legacy text;
  v_contact text;
  v_member_one text := btrim(coalesce(p_member_one, ''));
  v_member_two text := nullif(btrim(coalesce(p_member_two, '')), '');
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

  if p_entry_type = 'singles' and v_member_one = '' then
    raise exception 'Single entry requires one participant';
  end if;

  if p_entry_type = 'doubles' then
    if v_member_one = '' then
      raise exception 'Double entry requires at least one participant';
    end if;
    if v_tournament.doubles_pairing_mode <> 'pick_random' and v_member_two is null then
      raise exception 'Double entry requires two participants';
    end if;
  end if;

  perform validate_entry_names(p_entry_type, v_member_one, v_member_two, p_display_name);

  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_email := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_legacy := nullif(btrim(coalesce(p_phone_or_email, '')), '');

  if v_phone is null and v_email is null then
    -- A caller that still sends one combined contact: classify it by shape.
    if v_legacy is null then
      raise exception 'Contact info is required';
    end if;
    if v_legacy ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_email := lower(v_legacy);
    elsif v_legacy ~ '^\+?[0-9\s\-\(\)]{7,20}$' then
      v_phone := v_legacy;
    else
      raise exception 'Invalid phone number or email';
    end if;
  else
    -- Both fields are mandatory once either of them is sent.
    if v_phone is null then
      raise exception 'registration.phoneRequired';
    end if;
    if v_email is null then
      raise exception 'registration.emailRequired';
    end if;
    if v_phone !~ '^\+?[0-9\s\-\(\)]{7,20}$' then
      raise exception 'registration.invalidPhone';
    end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'registration.invalidEmail';
    end if;
  end if;

  -- The legacy column keeps one value: the email when there is one.
  v_contact := coalesce(v_email, v_phone);

  if entry_contact_taken(v_tournament.id, v_contact, v_phone, v_email) then
    raise exception 'Registration already exists for this contact';
  end if;

  if p_display_name is not null and btrim(p_display_name) <> '' then
    v_display_name := btrim(p_display_name);
  elsif p_entry_type = 'singles' then
    v_display_name := v_member_one;
  elsif v_member_two is not null then
    v_display_name := v_member_one || ' / ' || v_member_two;
  else
    v_display_name := v_member_one;
  end if;

  insert into entries (
    tournament_id,
    entry_type,
    display_name,
    phone_or_email,
    contact_phone,
    contact_email,
    status
  ) values (
    v_tournament.id,
    p_entry_type,
    v_display_name,
    v_contact,
    v_phone,
    v_email,
    v_status
  )
  returning id into v_entry_id;

  insert into entry_members (entry_id, member_name, member_order)
  values (v_entry_id, v_member_one, 1);

  if p_entry_type = 'doubles' and v_member_two is not null then
    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_id, v_member_two, 2);
  end if;

  return jsonb_build_object('id', v_entry_id, 'status', v_status);
end;
$$;
revoke execute on function register_entry(text, tournament_category, text, text, text, text, text, text, text) from public;
grant execute on function register_entry(text, tournament_category, text, text, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Entries added by an organizer. The contact is optional (a placeholder keeps
-- the legacy unique column filled); when given it is classified, normalised and
-- checked for duplicates exactly like a public registration.
-- ---------------------------------------------------------------------------
create or replace function public.add_manual_entry(
  p_tournament_id uuid,
  p_member_one text,
  p_member_two text default null,
  p_display_name text default null,
  p_contact text default null,
  p_status registration_status default 'approved'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t tournaments%rowtype;
  v_member_one text := btrim(coalesce(p_member_one, ''));
  v_member_two text := nullif(btrim(coalesce(p_member_two, '')), '');
  v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
  v_phone text;
  v_email text;
  v_display text;
  v_id uuid;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  select * into v_t from tournaments where id = p_tournament_id for update;
  if v_t.id is null then
    raise exception 'Tournament not found';
  end if;
  if v_t.status in ('in_progress', 'completed') then
    raise exception 'drafts.rulesLocked';
  end if;
  if p_status is null or p_status not in ('approved', 'pending') then
    raise exception 'Invalid entry status';
  end if;

  if v_t.category = 'singles' and v_member_one = '' then
    raise exception 'Single entry requires one participant';
  end if;
  if v_t.category = 'doubles' then
    if v_member_one = '' then
      raise exception 'Double entry requires at least one participant';
    end if;
    if coalesce(v_t.doubles_pairing_mode::text, 'pre_agreed') <> 'pick_random' and v_member_two is null then
      raise exception 'Double entry requires two participants';
    end if;
  else
    v_member_two := null;
  end if;
  perform validate_entry_names(v_t.category, v_member_one, v_member_two, p_display_name);

  if v_contact is null then
    v_contact := 'admin-entry-' || gen_random_uuid()::text || '@local.tenis';
  elsif v_contact ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    v_email := lower(v_contact);
    v_contact := v_email;
  elsif v_contact ~ '^\+?[0-9\s\-\(\)]{7,20}$' then
    v_phone := v_contact;
  else
    raise exception 'Invalid phone number or email';
  end if;

  if entry_contact_taken(p_tournament_id, v_contact, v_phone, v_email) then
    raise exception 'Registration already exists for this contact';
  end if;

  v_display := coalesce(nullif(btrim(coalesce(p_display_name, '')), ''),
    case when v_member_two is not null then v_member_one || ' / ' || v_member_two else v_member_one end);

  insert into entries (tournament_id, entry_type, display_name, phone_or_email, contact_phone, contact_email, status)
  values (p_tournament_id, v_t.category, v_display, v_contact, v_phone, v_email, p_status)
  returning id into v_id;

  insert into entry_members (entry_id, member_name, member_order) values (v_id, v_member_one, 1);
  if v_member_two is not null then
    insert into entry_members (entry_id, member_name, member_order) values (v_id, v_member_two, 2);
  end if;

  return jsonb_build_object('id', v_id, 'status', p_status);
end;
$$;
revoke execute on function public.add_manual_entry(uuid, text, text, text, text, registration_status) from public, anon, authenticated;
grant execute on function public.add_manual_entry(uuid, text, text, text, text, registration_status) to authenticated;

-- Contacts of applicants for the organizers who process the entries. Owners
-- and editors only: a results-only counter and the public get nothing, and the
-- contact columns themselves stay closed to every API role.
create or replace function public.get_entry_contacts(p_tournament_id uuid)
returns table (entry_id uuid, contact_phone text, contact_email text)
language sql
stable
security definer
set search_path = public
as $$
 select e.id, e.contact_phone, e.contact_email
 from entries e
 where is_tournament_admin(p_tournament_id)
   and e.tournament_id = p_tournament_id
   and (e.contact_phone is not null or e.contact_email is not null)
 order by e.created_at, e.id;
$$;
revoke execute on function public.get_entry_contacts(uuid) from public, anon, authenticated;
grant execute on function public.get_entry_contacts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Assistants
-- ---------------------------------------------------------------------------
-- p_only_new: the "add assistant" form refuses a person who is already on the
-- team (the detail carries their role) instead of changing it silently; the
-- role selector keeps calling without it. An unknown email gets a code, not
-- the address echoed back in English.
drop function if exists add_tournament_admin_by_email(uuid, text, text);
create or replace function add_tournament_admin_by_email(
  p_tournament_id uuid,
  p_email text,
  p_role text default 'editor',
  p_only_new boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_caller text;
  v_current text;
  v_owners integer;
begin
  v_caller := get_my_tournament_role(p_tournament_id);
  if v_caller is null or v_caller not in ('owner', 'editor') then
    raise exception 'Not authorized';
  end if;
  if p_role is null or p_role not in ('owner', 'editor', 'counter') then
    raise exception 'access.invalidRole';
  end if;

  select id into v_user_id
  from auth.users
  where email = lower(trim(coalesce(p_email, '')));

  if v_user_id is null then
    raise exception 'access.userNotFound';
  end if;

  perform 1 from tournaments where id = p_tournament_id for update;
  select role into v_current from tournament_admins where tournament_id = p_tournament_id and user_id = v_user_id;
  if coalesce(p_only_new, false) and v_current is not null then
    raise exception 'access.alreadyMember' using detail = v_current;
  end if;
  -- Only an owner grants ownership or changes another owner's role.
  if (p_role = 'owner' or v_current = 'owner') and v_caller <> 'owner' then
    raise exception 'access.ownerOnly';
  end if;
  if v_current = 'owner' and p_role <> 'owner' then
    select count(*) into v_owners from tournament_admins where tournament_id = p_tournament_id and role = 'owner';
    if v_owners <= 1 then
      raise exception 'access.lastOwner';
    end if;
  end if;

  insert into tournament_admins (tournament_id, user_id, role)
  values (p_tournament_id, v_user_id, p_role)
  on conflict (tournament_id, user_id)
  do update set role = excluded.role;

  return jsonb_build_object('user_id', v_user_id, 'role', p_role, 'previous_role', v_current);
end;
$$;
revoke execute on function add_tournament_admin_by_email(uuid, text, text, boolean) from public, anon;
grant execute on function add_tournament_admin_by_email(uuid, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Page password: per-client attempt counting
-- ---------------------------------------------------------------------------
-- One row per (tournament, hashed client key). Two keys per visitor: the IP
-- with the browser id (locks after 10 failures) and the IP alone (locks after
-- 30, so rotating the browser id does not help). A count older than 15 quiet
-- minutes starts over. Only hashes are stored.
create table if not exists public.tournament_unlock_client_attempts (
  tournament_id uuid not null references tournaments (id) on delete cascade,
  client_hash text not null,
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tournament_id, client_hash)
);
alter table public.tournament_unlock_client_attempts enable row level security;
revoke all on public.tournament_unlock_client_attempts from public, anon, authenticated;

-- The tournament-wide row becomes a one-minute rate window: failures from all
-- clients are counted per window and, above the limit, attempts wait for the
-- window to end. Rows from the old global lockout carry no window and are
-- dropped, which also lifts any lockout they still hold.
alter table public.tournament_unlock_attempts add column if not exists window_started_at timestamptz;
delete from public.tournament_unlock_attempts where window_started_at is null;

-- Client IP as PostgREST passes it in the request headers; empty outside HTTP.
create or replace function public.request_client_ip()
returns text language plpgsql stable set search_path=public as $$
declare v_headers jsonb; v_ip text;
begin
 begin
  v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
 exception when others then
  v_headers := null;
 end;
 if v_headers is null or jsonb_typeof(v_headers) <> 'object' then return ''; end if;
 v_ip := coalesce(nullif(btrim(v_headers->>'cf-connecting-ip'), ''),
  nullif(btrim(v_headers->>'x-real-ip'), ''),
  nullif(btrim(split_part(coalesce(v_headers->>'x-forwarded-for', ''), ',', 1)), ''));
 return left(coalesce(v_ip, ''), 64);
end;
$$;
revoke execute on function public.request_client_ip() from public, anon, authenticated;

-- The previous two-argument version is replaced, not overloaded: an older
-- client calling with p_slug and p_password keeps working through the default.
drop function if exists public.unlock_tournament(text, text);
create or replace function public.unlock_tournament(p_slug text, p_password text, p_client_id text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_t tournaments%rowtype;
 v_global tournament_unlock_attempts%rowtype;
 v_ip text;
 v_client_key text;
 v_ip_key text;
 v_locked timestamptz;
 v_token text;
 v_expires timestamptz;
begin
 select * into v_t from tournaments where slug=p_slug for update;
 if v_t.id is null or v_t.visibility<>'password' or v_t.access_password_hash is null then return jsonb_build_object('ok',false,'error','access.noPassword'); end if;

 v_ip := request_client_ip();
 v_ip_key := encode(extensions.digest('ip|'||v_t.id::text||'|'||v_ip,'sha256'),'hex');
 v_client_key := encode(extensions.digest('client|'||v_t.id::text||'|'||v_ip||'|'||left(btrim(coalesce(p_client_id,'')),128),'sha256'),'hex');

 -- Forget idle counters so the table does not grow with every visitor.
 delete from tournament_unlock_client_attempts
  where tournament_id=v_t.id and updated_at<now()-interval '1 day' and (locked_until is null or locked_until<=now());

 select * into v_global from tournament_unlock_attempts where tournament_id=v_t.id for update;
 if v_global.locked_until is not null and v_global.locked_until>now() then
  return jsonb_build_object('ok',false,'error','access.rateLimited','retry_at',v_global.locked_until);
 end if;

 select max(locked_until) into v_locked from tournament_unlock_client_attempts
  where tournament_id=v_t.id and client_hash in (v_client_key, v_ip_key) and locked_until>now();
 if v_locked is not null then
  return jsonb_build_object('ok',false,'error','access.locked','locked_until',v_locked);
 end if;

 if p_password is null or extensions.crypt(p_password,v_t.access_password_hash)<>v_t.access_password_hash then
  insert into tournament_unlock_client_attempts as a (tournament_id,client_hash,failed_count,locked_until,updated_at)
   values (v_t.id,v_client_key,1,null,now()),(v_t.id,v_ip_key,1,null,now())
   on conflict (tournament_id,client_hash) do update set
    failed_count=case when (case when a.updated_at<=now()-interval '15 minutes' then 1 else a.failed_count+1 end)
      >=(case when a.client_hash=v_ip_key then 30 else 10 end) then 0
     else (case when a.updated_at<=now()-interval '15 minutes' then 1 else a.failed_count+1 end) end,
    locked_until=case when (case when a.updated_at<=now()-interval '15 minutes' then 1 else a.failed_count+1 end)
      >=(case when a.client_hash=v_ip_key then 30 else 10 end) then now()+interval '15 minutes' else null end,
    updated_at=now();
  insert into tournament_unlock_attempts as g (tournament_id,failed_count,locked_until,updated_at,window_started_at)
   values (v_t.id,1,null,now(),now())
   on conflict (tournament_id) do update set
    failed_count=case when g.window_started_at is null or g.window_started_at<=now()-interval '1 minute' then 1 else g.failed_count+1 end,
    window_started_at=case when g.window_started_at is null or g.window_started_at<=now()-interval '1 minute' then now() else g.window_started_at end,
    locked_until=case when g.window_started_at is not null and g.window_started_at>now()-interval '1 minute' and g.failed_count+1>=60
     then g.window_started_at+interval '1 minute' else null end,
    updated_at=now();
  return jsonb_build_object('ok',false,'error','access.wrongPassword');
 end if;

 -- The browser that got in starts over; the address keeps its count (it may be
 -- shared with someone still guessing) and forgets it after 15 quiet minutes.
 delete from tournament_unlock_client_attempts where tournament_id=v_t.id and client_hash=v_client_key;
 delete from tournament_access_grants where tournament_id=v_t.id and expires_at<=now();
 v_token:=encode(extensions.gen_random_bytes(32),'hex');
 v_expires:=now()+interval '12 hours';
 insert into tournament_access_grants(tournament_id,token_hash,password_version,expires_at)
  values(v_t.id,encode(extensions.digest(v_token,'sha256'),'hex'),v_t.access_password_version,v_expires);
 return jsonb_build_object('ok',true,'tournament_id',v_t.id,'token',v_token,'expires_at',v_expires);
end;
$$;
revoke execute on function public.unlock_tournament(text,text,text) from public;
grant execute on function public.unlock_tournament(text,text,text) to anon, authenticated;

-- A new password starts every counter from zero, per client and per page.
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
  update tournaments set access_password_hash=null,access_password_plain=null,
   access_password_version=access_password_version+1 where id=p_tournament_id returning * into v_t;
 else
  if length(p_password)<4 or length(p_password)>72 then raise exception 'access.passwordTooShort'; end if;
  update tournaments set access_password_hash=extensions.crypt(p_password,extensions.gen_salt('bf',10)),
   access_password_plain=p_password,
   access_password_version=access_password_version+1 where id=p_tournament_id returning * into v_t;
 end if;
 -- Every change invalidates issued tokens.
 delete from tournament_access_grants where tournament_id=p_tournament_id;
 delete from tournament_unlock_attempts where tournament_id=p_tournament_id;
 delete from tournament_unlock_client_attempts where tournament_id=p_tournament_id;
 return jsonb_build_object('password_set',v_t.access_password_hash is not null,'settings_revision',v_t.settings_revision);
end;
$$;
revoke execute on function public.set_tournament_password(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.set_tournament_password(uuid,text,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Settings: completed is final; stricter contact and registration rules
-- ---------------------------------------------------------------------------
create or replace function update_tournament_settings(p_tournament_id uuid,p_patch jsonb,p_expected_revision integer,p_expected_matches jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_old tournaments%rowtype; v_new tournaments%rowtype; k text; v_category_changed boolean; v_tz text; v_units text[];
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_old from tournaments where id=p_tournament_id for update;
 if v_old.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_old.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Invalid settings'; end if;
 for k in select jsonb_object_keys(p_patch) loop
  if k<>all(array['name','description','category','set_format','scoring_config','doubles_pairing_mode','status','is_public','contact_phone','contact_email','publish_contact',
   'registration_capacity','capacity_public','registration_deadline','entry_fee_mode','entry_fee_minor','entry_fee_currency','entry_fee_unit','waitlist_enabled',
   'schedule_config','visibility','venue_address','venue_lat','venue_lng']) then raise exception 'Unsupported settings field'; end if;
 end loop;
 v_new:=jsonb_populate_record(v_old,p_patch);
 -- A finished tournament stays finished: its results and champion are final.
 if v_old.status='completed' and v_new.status is distinct from 'completed' then raise exception 'lifecycle.completedLocked'; end if;
 if v_new.name is null or btrim(v_new.name)='' or v_new.is_public is null or v_new.scoring_config is null or v_new.publish_contact is null or v_new.capacity_public is null or v_new.waitlist_enabled is null then raise exception 'Invalid settings'; end if;
 -- Organizer contacts are checked when they change (older rows keep saving).
 if nullif(btrim(coalesce(v_new.contact_phone,'')),'') is distinct from nullif(btrim(coalesce(v_old.contact_phone,'')),'')
    and nullif(btrim(coalesce(v_new.contact_phone,'')),'') !~ '^\+?[0-9\s\-\(\)]{7,20}$' then raise exception 'registration.invalidPhone'; end if;
 if nullif(btrim(coalesce(v_new.contact_email,'')),'') is distinct from nullif(btrim(coalesce(v_old.contact_email,'')),'')
    and nullif(btrim(coalesce(v_new.contact_email,'')),'') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'registration.invalidEmail'; end if;
 if v_new.publish_contact and nullif(btrim(coalesce(v_new.contact_phone,'')),'') is null and nullif(btrim(coalesce(v_new.contact_email,'')),'') is null then raise exception 'Contact required'; end if;
 if v_new.registration_capacity is not null and v_new.registration_capacity<=0 then raise exception 'registration.invalidCapacity'; end if;
 -- Lowering the limit never removes approved participants silently.
 if v_new.registration_capacity is not null and v_new.registration_capacity is distinct from v_old.registration_capacity
    and v_new.registration_capacity<registration_occupancy(p_tournament_id,null) then raise exception 'registration.capacityBelowOccupied'; end if;
 -- A waitlist queues entries beyond the limit, so it needs one.
 if v_new.waitlist_enabled and v_new.registration_capacity is null
    and (v_new.waitlist_enabled,v_new.registration_capacity) is distinct from (v_old.waitlist_enabled,v_old.registration_capacity) then raise exception 'registration.waitlistNeedsCapacity'; end if;
 if v_new.entry_fee_mode is distinct from 'paid' then
  v_new.entry_fee_minor:=null; v_new.entry_fee_currency:=null; v_new.entry_fee_unit:=null;
  if v_new.entry_fee_mode is not null and v_new.entry_fee_mode<>'free' then raise exception 'registration.invalidFee'; end if;
 else
  v_new.entry_fee_currency:=upper(btrim(coalesce(v_new.entry_fee_currency,'')));
  if v_new.entry_fee_minor is null or v_new.entry_fee_minor<0 or v_new.entry_fee_currency!~'^[A-Z]{3}$'
     or v_new.entry_fee_unit is null or v_new.entry_fee_unit<>all(array['player','pair','team']) then raise exception 'registration.invalidFee'; end if;
  -- A newly set fee is a real amount per a unit that exists in this tournament.
  if (v_new.entry_fee_mode,v_new.entry_fee_minor,v_new.entry_fee_unit) is distinct from (v_old.entry_fee_mode,v_old.entry_fee_minor,v_old.entry_fee_unit) then
   if v_new.entry_fee_minor=0 then raise exception 'registration.zeroFee'; end if;
   v_units:=case when v_new.sport='football' then array['team','player'] when v_new.category='doubles' then array['pair','player'] else array['player'] end;
   if v_new.entry_fee_unit<>all(v_units) then raise exception 'registration.feeUnitMismatch'; end if;
  end if;
 end if;
 -- Venue: an address of sane length, and a point that is either complete or absent.
 v_new.venue_address:=nullif(btrim(coalesce(v_new.venue_address,'')),'');
 if v_new.venue_address is not null and length(v_new.venue_address)>300 then raise exception 'venue.invalidAddress'; end if;
 if (v_new.venue_lat is null)<>(v_new.venue_lng is null) then raise exception 'venue.invalidPoint'; end if;
 if v_new.venue_lat is not null and (v_new.venue_lat< -90 or v_new.venue_lat>90 or v_new.venue_lng< -180 or v_new.venue_lng>180) then raise exception 'venue.invalidPoint'; end if;
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
  waitlist_enabled=v_new.waitlist_enabled,schedule_config=v_new.schedule_config,visibility=v_new.visibility,
  venue_address=v_new.venue_address,venue_lat=v_new.venue_lat,venue_lng=v_new.venue_lng
 where id=p_tournament_id returning * into v_new;
 if v_category_changed then delete from matches where tournament_id=p_tournament_id; end if;
 return to_jsonb(v_new);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;

notify pgrst, 'reload schema';
