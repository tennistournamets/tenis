-- ---------------------------------------------------------------------------
-- Team ties (20261114200047_team_ties). Spec: docs/TEAM_FORMATS.md.
-- A team is an entry of category 'team' whose roster lives in entry_members.
-- A tie (team against team) is an ordinary matches row; its lines ("rubbers")
-- are child matches rows (parent_match_id, line_no, stage 'rubber') that mirror
-- the tie's two teams, so set scoring, live scoring and corrections work as for
-- any match. Players per line come from tie_lineups. A trigger recomputes the
-- tie after every line result: score = lines won (or games), winner, status and
-- propagation to the next round. Standings count ties only.
-- New enum values ('team', 'rubber') come from 20261114200046 and are compared
-- as text here, so this file also works when schema.sql runs in one transaction.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

insert into feature_flags (key, enabled, description) values
  ('feature.teams', false, 'Team tournaments: ties of singles, doubles and mixed lines')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.entry_members add column if not exists gender text;
alter table public.entry_members drop constraint if exists entry_members_gender_check;
alter table public.entry_members add constraint entry_members_gender_check
  check (gender is null or gender in ('male', 'female'));
-- A team roster holds up to 30 players; 31..60 is the scratch range used while
-- a roster is rewritten. Entries of other categories stay at 1..2 (trigger below).
alter table public.entry_members drop constraint if exists entry_members_member_order_check;
alter table public.entry_members add constraint entry_members_member_order_check
  check (member_order between 1 and 60);

alter table public.matches add column if not exists parent_match_id uuid references public.matches(id) on delete cascade;
alter table public.matches add column if not exists line_no integer;
alter table public.matches drop constraint if exists matches_line_no_check;
alter table public.matches add constraint matches_line_no_check check (
  (parent_match_id is null and line_no is null and stage::text <> 'rubber')
  or (parent_match_id is not null and line_no between 1 and 20 and stage::text = 'rubber')
);
create index if not exists idx_matches_parent on public.matches (parent_match_id) where parent_match_id is not null;
create unique index if not exists idx_matches_parent_line on public.matches (parent_match_id, line_no) where parent_match_id is not null;

-- ---------------------------------------------------------------------------
-- Tie template: format_config.tie
-- ---------------------------------------------------------------------------
create or replace function public.team_cfg_int(p_value jsonb, p_default integer, p_min integer, p_max integer)
returns integer language plpgsql immutable set search_path=public as $$
declare v numeric;
begin
  if p_value is null or p_value = 'null'::jsonb then return p_default; end if;
  if jsonb_typeof(p_value) <> 'number' then raise exception 'team.invalidTemplate'; end if;
  v := (p_value #>> '{}')::numeric;
  if v <> trunc(v) or v < p_min or v > p_max then raise exception 'team.invalidTemplate'; end if;
  return v::integer;
end;
$$;
revoke execute on function public.team_cfg_int(jsonb, integer, integer, integer) from public, anon, authenticated;

-- Normalized template with defaults; raises team.invalidTemplate.
-- Line types: MS men's singles, WS women's singles, XS any singles,
-- MD men's doubles, WD women's doubles, XD mixed doubles, AD any doubles.
create or replace function public.team_tie_config(p_tie jsonb)
returns jsonb language plpgsql immutable set search_path=public as $$
declare
  v_types text[] := array['MS','WS','XS','MD','WD','XD','AD'];
  v_tie jsonb := coalesce(nullif(p_tie, 'null'::jsonb), '{}'::jsonb);
  v_lines jsonb;
  v_line jsonb;
  v_out jsonb := '[]'::jsonb;
  v_type text;
  v_rule text;
  v_decider text;
  v_min integer;
  v_max integer;
begin
  if jsonb_typeof(v_tie) <> 'object' then raise exception 'team.invalidTemplate'; end if;
  v_lines := coalesce(nullif(v_tie->'lines', 'null'::jsonb), '[{"type":"XS"},{"type":"XS"},{"type":"AD"}]'::jsonb);
  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) not between 1 and 9 then
    raise exception 'team.invalidTemplate';
  end if;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_type := case jsonb_typeof(v_line) when 'string' then v_line #>> '{}' when 'object' then v_line->>'type' end;
    if v_type is null or v_type <> all(v_types) then raise exception 'team.invalidTemplate'; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('type', v_type));
  end loop;
  v_rule := coalesce(v_tie->>'win_rule', 'rubbers');
  if v_rule not in ('rubbers', 'games') then raise exception 'team.invalidTemplate'; end if;
  v_decider := coalesce(v_tie#>>'{decider,type}', 'AD');
  if v_decider <> all(v_types) then raise exception 'team.invalidTemplate'; end if;
  v_min := team_cfg_int(v_tie->'roster_min', 2, 1, 30);
  v_max := team_cfg_int(v_tie->'roster_max', 16, 1, 30);
  if v_min > v_max then raise exception 'team.invalidTemplate'; end if;
  return jsonb_build_object(
    'lines', v_out,
    'win_rule', v_rule,
    'decider', jsonb_build_object('type', v_decider),
    'max_lines_per_player', jsonb_build_object(
      'singles', team_cfg_int(v_tie#>'{max_lines_per_player,singles}', 1, 0, 9),
      'doubles', team_cfg_int(v_tie#>'{max_lines_per_player,doubles}', 1, 0, 9)),
    'roster_min', v_min,
    'roster_max', v_max);
end;
$$;
grant execute on function public.team_tie_config(jsonb) to anon, authenticated;

create or replace function public.tournament_is_team(p_tournament_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((select t.category::text = 'team' from tournaments t where t.id = p_tournament_id), false);
$$;
revoke execute on function public.tournament_is_team(uuid) from public;
grant execute on function public.tournament_is_team(uuid) to anon, authenticated;

-- Type of line p_line_no: template lines first, the decider after them.
create or replace function public.tie_line_type(p_tie jsonb, p_line_no integer)
returns text language sql immutable set search_path=public as $$
  select case when p_line_no <= jsonb_array_length(p_tie->'lines')
              then p_tie->'lines'->(p_line_no - 1)->>'type'
              else p_tie#>>'{decider,type}' end;
$$;
revoke execute on function public.tie_line_type(jsonb, integer) from public, anon, authenticated;

create or replace function public.tie_line_size(p_type text)
returns integer language sql immutable set search_path=public as $$
  select case when p_type in ('MS', 'WS', 'XS') then 1 else 2 end;
$$;
revoke execute on function public.tie_line_size(text) from public, anon, authenticated;

-- Genders of the players chosen so far for one side of a line.
create or replace function public.tie_line_genders_ok(p_type text, p_genders text[])
returns boolean language sql immutable set search_path=public as $$
  select case
    when coalesce(array_length(p_genders, 1), 0) = 0 then true
    when p_type in ('XS', 'AD') then true
    when array_position(p_genders, null) is not null then false
    when p_type in ('MS', 'MD') then 'male' = all(p_genders)
    when p_type in ('WS', 'WD') then 'female' = all(p_genders)
    when p_type = 'XD' then array_length(p_genders, 1) = 1 or (select count(distinct g) from unnest(p_genders) g) = 2
    else true end;
$$;
revoke execute on function public.tie_line_genders_ok(text, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tournament guard: tennis only, supported formats, normalized template
-- ---------------------------------------------------------------------------
create or replace function public.guard_team_category()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_tie jsonb;
begin
  if new.category::text = 'team' then
    if (tg_op = 'INSERT' or old.category::text <> 'team') and not is_feature_enabled('feature.teams') then
      raise exception using errcode = 'P0403', message = 'team.disabled';
    end if;
    if new.sport::text <> 'tennis' then raise exception 'team.sportNotSupported'; end if;
    if new.format::text not in ('round_robin', 'groups_playoff', 'single_elimination') then
      raise exception 'team.formatNotSupported';
    end if;
    new.doubles_pairing_mode := null;
    v_tie := team_tie_config(new.format_config->'tie');
    if tg_op = 'UPDATE' and old.category::text = 'team'
       and team_tie_config(old.format_config->'tie') is distinct from v_tie
       and exists (select 1 from matches where tournament_id = new.id) then
      raise exception 'team.templateLocked';
    end if;
    new.format_config := jsonb_set(coalesce(new.format_config, '{}'::jsonb), '{tie}', v_tie);
    if not (coalesce(new.scoring_config, '{}'::jsonb) ? 'points_win') then
      new.scoring_config := coalesce(new.scoring_config, '{}'::jsonb)
        || '{"points_win": 2, "points_draw": 1, "points_loss": 0}'::jsonb;
    end if;
  end if;
  if tg_op = 'UPDATE' and old.category is distinct from new.category
     and (old.category::text = 'team' or new.category::text = 'team')
     and exists (select 1 from entries where tournament_id = new.id) then
    raise exception 'team.categoryLocked';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_team_category() from public, anon, authenticated;
drop trigger if exists trg_guard_team_category on public.tournaments;
create trigger trg_guard_team_category before insert or update on public.tournaments
for each row execute function public.guard_team_category();

-- ---------------------------------------------------------------------------
-- Entries: team entries only through the team RPCs; rosters beyond two only
-- for teams
-- ---------------------------------------------------------------------------
create or replace function public.guard_team_entry()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.entry_type::text = 'team' then
    if tg_op = 'INSERT' and coalesce(current_setting('bracketa.team_entry', true), '') <> 'on' then
      raise exception 'team.useTeamForm';
    end if;
  elsif tournament_is_team(new.tournament_id) then
    raise exception 'Invalid category for tournament';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_team_entry() from public, anon, authenticated;
drop trigger if exists trg_guard_team_entry on public.entries;
create trigger trg_guard_team_entry before insert or update of entry_type on public.entries
for each row execute function public.guard_team_entry();

create or replace function public.guard_entry_member_count()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.member_order > 2 and not exists (
    select 1 from entries e where e.id = new.entry_id and e.entry_type::text = 'team'
  ) then
    raise exception 'Invalid member order';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_entry_member_count() from public, anon, authenticated;
drop trigger if exists trg_guard_entry_member_count on public.entry_members;
create trigger trg_guard_entry_member_count before insert or update of member_order, entry_id on public.entry_members
for each row execute function public.guard_entry_member_count();

-- ---------------------------------------------------------------------------
-- Captains
-- ---------------------------------------------------------------------------
create table if not exists public.team_captains (
  entry_id uuid not null references public.entries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (entry_id, user_id)
);
create index if not exists idx_team_captains_user on public.team_captains (user_id);

-- One open invitation per team; only its SHA-256 is stored. Single use, 30 days.
create table if not exists public.team_captain_invites (
  entry_id uuid primary key references public.entries(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.team_captains enable row level security;
alter table public.team_captain_invites enable row level security;
revoke all on public.team_captains, public.team_captain_invites from public, anon, authenticated;

create or replace function public.is_team_captain(p_entry_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and exists (
    select 1 from team_captains c where c.entry_id = p_entry_id and c.user_id = auth.uid()
  );
$$;
revoke execute on function public.is_team_captain(uuid) from public;
grant execute on function public.is_team_captain(uuid) to anon, authenticated;

-- Teams of a tournament that have a captain (no personal data) and the
-- caller's own teams; both go into the sync snapshot.
create or replace function public.team_captain_entries(p_tournament_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(distinct c.entry_id), '[]'::jsonb)
  from team_captains c join entries e on e.id = c.entry_id
  join tournaments t on t.id = e.tournament_id
  where e.tournament_id = p_tournament_id
    and (t.is_public or is_tournament_admin(t.id) or can_live_score(t.id)
      or coalesce(current_setting('tenis.access_tournament', true), '') = t.id::text);
$$;
create or replace function public.my_captain_entries(p_tournament_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(c.entry_id order by c.entry_id), '[]'::jsonb)
  from team_captains c join entries e on e.id = c.entry_id
  where e.tournament_id = p_tournament_id and c.user_id = auth.uid();
$$;
revoke execute on function public.team_captain_entries(uuid), public.my_captain_entries(uuid) from public;
grant execute on function public.team_captain_entries(uuid), public.my_captain_entries(uuid) to anon, authenticated;

create or replace function public.create_captain_invite(p_entry_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e entries%rowtype; v_status tournament_status; v_token text;
begin
  select * into e from entries where id = p_entry_id;
  if e.id is null then raise exception 'Entry not found'; end if;
  if not is_tournament_admin(e.tournament_id) then raise exception 'Not allowed'; end if;
  if e.entry_type::text <> 'team' then raise exception 'team.notTeam'; end if;
  if e.status = 'rejected' then raise exception 'team.inviteInvalid'; end if;
  select status into v_status from tournaments where id = e.tournament_id;
  if v_status = 'completed' then raise exception 'lifecycle.completedLocked'; end if;
  v_token := encode(extensions.gen_random_bytes(18), 'hex');
  insert into team_captain_invites (entry_id, token_hash, created_by)
  values (e.id, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  on conflict (entry_id) do update
    set token_hash = excluded.token_hash, created_by = excluded.created_by, created_at = now();
  return jsonb_build_object('entry_id', e.id, 'token', v_token);
end;
$$;
revoke execute on function public.create_captain_invite(uuid) from public, anon, authenticated;
grant execute on function public.create_captain_invite(uuid) to authenticated;

create or replace function public.claim_team_captain(p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare i team_captain_invites%rowtype; e entries%rowtype; t tournaments%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into i from team_captain_invites
  where token_hash = encode(extensions.digest(btrim(coalesce(p_token, '')), 'sha256'), 'hex')
  for update;
  if i.entry_id is null or i.created_at < now() - interval '30 days' then
    raise exception 'team.inviteInvalid';
  end if;
  select * into e from entries where id = i.entry_id;
  select * into t from tournaments where id = e.tournament_id;
  if e.status = 'rejected' or t.status = 'completed' then raise exception 'team.inviteInvalid'; end if;
  insert into team_captains (entry_id, user_id) values (e.id, auth.uid()) on conflict do nothing;
  delete from team_captain_invites where entry_id = e.id;
  -- Realtime nudge for open pages: the entries row changes.
  update entries set updated_at = now() where id = e.id;
  return jsonb_build_object('entry_id', e.id, 'tournament_id', t.id, 'slug', t.slug, 'team_name', e.display_name);
end;
$$;
revoke execute on function public.claim_team_captain(text) from public, anon, authenticated;
grant execute on function public.claim_team_captain(text) to authenticated;

-- The organizer removes a captain (all of a team's when p_user_id is null);
-- a captain may step down.
create or replace function public.remove_team_captain(p_entry_id uuid, p_user_id uuid default null)
returns integer language plpgsql security definer set search_path=public as $$
declare v_tid uuid; v_count integer;
begin
  select tournament_id into v_tid from entries where id = p_entry_id;
  if v_tid is null then raise exception 'Entry not found'; end if;
  if not (is_tournament_admin(v_tid) or (p_user_id is not null and p_user_id = auth.uid())) then
    raise exception 'Not allowed';
  end if;
  delete from team_captains where entry_id = p_entry_id and (p_user_id is null or user_id = p_user_id);
  get diagnostics v_count = row_count;
  if v_count > 0 then update entries set updated_at = now() where id = p_entry_id; end if;
  return v_count;
end;
$$;
revoke execute on function public.remove_team_captain(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_team_captain(uuid, uuid) to authenticated;

-- Captains with their account email, for the organizers (owner, editor).
create or replace function public.list_team_captains(p_tournament_id uuid)
returns table (entry_id uuid, user_id uuid, email text, name text)
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
  return query
  select c.entry_id, c.user_id, u.email::text,
         coalesce((select nullif(btrim(p.display_name), '') from players p where p.user_id = c.user_id and not p.is_deleted limit 1),
                  nullif(btrim(u.raw_user_meta_data->>'full_name'), ''), nullif(btrim(u.raw_user_meta_data->>'name'), ''))
  from team_captains c
  join entries e on e.id = c.entry_id
  join auth.users u on u.id = c.user_id
  where e.tournament_id = p_tournament_id
  order by c.entry_id, c.created_at;
end;
$$;
revoke execute on function public.list_team_captains(uuid) from public, anon, authenticated;
grant execute on function public.list_team_captains(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Rosters and team entries
-- ---------------------------------------------------------------------------
-- Replaces a team's roster with p_members = [{id?, name, gender?}], keeping
-- the ids it is given (lineups and ratings stay attached to them).
create or replace function public.team_write_members(p_entry_id uuid, p_members jsonb, p_max integer)
returns integer language plpgsql security definer set search_path=public as $$
declare
  v_item jsonb;
  v_keep uuid[] := '{}';
  v_keys text[] := '{}';
  v_name text;
  v_gender text;
  v_id uuid;
  v_i integer := 0;
  v_count integer;
begin
  if jsonb_typeof(p_members) is distinct from 'array' then raise exception 'team.invalidRoster'; end if;
  v_count := jsonb_array_length(p_members);
  if v_count < 1 then raise exception 'team.rosterEmpty'; end if;
  if v_count > p_max then raise exception 'team.rosterTooLarge'; end if;
  for v_item in select value from jsonb_array_elements(p_members) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'team.invalidRoster'; end if;
    v_name := btrim(coalesce(v_item->>'name', ''));
    if v_name = '' then raise exception 'team.memberNameRequired'; end if;
    if length(v_name) > 100 then raise exception 'registration.nameTooLong'; end if;
    v_gender := nullif(v_item->>'gender', '');
    if v_gender is not null and v_gender not in ('male', 'female') then raise exception 'team.invalidGender'; end if;
    if entry_name_key(v_name) = any(v_keys) then raise exception 'team.duplicateMember'; end if;
    v_keys := v_keys || entry_name_key(v_name);
    if nullif(v_item->>'id', '') is not null then
      begin
        v_id := (v_item->>'id')::uuid;
      exception when invalid_text_representation then
        raise exception 'team.invalidRoster';
      end;
      if v_id = any(v_keep) or not exists (select 1 from entry_members where id = v_id and entry_id = p_entry_id) then
        raise exception 'team.invalidRoster';
      end if;
      v_keep := v_keep || v_id;
    end if;
  end loop;

  if exists (
    select 1 from entry_members em
    join tie_lineups l on l.member_id = em.id
    join matches r on r.id = l.line_id
    where em.entry_id = p_entry_id and em.id <> all(v_keep)
      and (r.status = 'finished' or r.side_a_score is not null or r.side_b_score is not null
        or exists (select 1 from match_sets s where s.match_id = r.id)
        or exists (select 1 from live_scores lv where lv.match_id = r.id))
  ) then
    raise exception 'team.memberPlayed';
  end if;

  delete from entry_members where entry_id = p_entry_id and id <> all(v_keep);
  update entry_members set member_order = member_order + 30 where entry_id = p_entry_id;
  for v_item in select value from jsonb_array_elements(p_members) loop
    v_i := v_i + 1;
    v_name := btrim(v_item->>'name');
    v_gender := nullif(v_item->>'gender', '');
    if nullif(v_item->>'id', '') is not null then
      update entry_members set member_name = v_name, gender = v_gender, member_order = v_i
      where id = (v_item->>'id')::uuid;
    else
      insert into entry_members (entry_id, member_name, member_order, gender)
      values (p_entry_id, v_name, v_i, v_gender);
    end if;
  end loop;
  return v_count;
end;
$$;
revoke execute on function public.team_write_members(uuid, jsonb, integer) from public, anon, authenticated;

create or replace function public.team_name_valid(p_name text)
returns text language plpgsql immutable set search_path=public as $$
declare v text := btrim(coalesce(p_name, ''));
begin
  if v = '' then raise exception 'team.nameRequired'; end if;
  if length(v) > 80 then raise exception 'registration.nameTooLong'; end if;
  return v;
end;
$$;
revoke execute on function public.team_name_valid(text) from public, anon, authenticated;

-- The organizer adds a team (approved by default).
create or replace function public.add_team_entry(
  p_tournament_id uuid,
  p_team_name text,
  p_members jsonb,
  p_contact text default null,
  p_status registration_status default 'approved'
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  t tournaments%rowtype;
  v_name text := team_name_valid(p_team_name);
  v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
  v_phone text;
  v_email text;
  v_id uuid;
begin
  if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
  select * into t from tournaments where id = p_tournament_id for update;
  if t.id is null then raise exception 'Tournament not found'; end if;
  if t.category::text <> 'team' then raise exception 'Invalid category for tournament'; end if;
  if t.status in ('in_progress', 'completed') then raise exception 'drafts.rulesLocked'; end if;
  if p_status is null or p_status not in ('approved', 'pending') then raise exception 'Invalid entry status'; end if;
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
  perform set_config('bracketa.team_entry', 'on', true);
  insert into entries (tournament_id, entry_type, display_name, phone_or_email, contact_phone, contact_email, status)
  values (p_tournament_id, 'team', v_name, v_contact, v_phone, v_email, p_status)
  returning id into v_id;
  perform set_config('bracketa.team_entry', '', true);
  perform team_write_members(v_id, p_members, (team_tie_config(t.format_config->'tie')->>'roster_max')::integer);
  return jsonb_build_object('id', v_id, 'status', p_status);
end;
$$;
revoke execute on function public.add_team_entry(uuid, text, jsonb, text, registration_status) from public, anon, authenticated;
grant execute on function public.add_team_entry(uuid, text, jsonb, text, registration_status) to authenticated;

-- Public team registration: same intake rules as register_entry (visibility,
-- status, deadline, capacity and waitlist, both contacts, duplicates). A
-- signed-in registrant becomes the team's captain.
create or replace function public.register_team(
  p_slug text,
  p_team_name text,
  p_members jsonb,
  p_phone text,
  p_email text,
  p_access_token text default null
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  t tournaments%rowtype;
  v_tie jsonb;
  v_name text := team_name_valid(p_team_name);
  v_status registration_status := 'pending';
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
  v_id uuid;
begin
  select * into t from tournaments where slug = p_slug limit 1;
  if t.id is null then raise exception 'Tournament not found'; end if;
  if t.is_public is false
     and not (t.visibility = 'password' and valid_access_token(t.id, p_access_token)) then
    raise exception 'Tournament is private';
  end if;
  if t.category::text <> 'team' then raise exception 'Invalid category for tournament'; end if;
  if t.status <> 'registration_open' then raise exception 'Registration is closed'; end if;
  if t.registration_deadline is not null and now() >= t.registration_deadline then
    raise exception 'registration.deadlinePassed';
  end if;
  if t.registration_capacity is not null
     and registration_occupancy(t.id, null) >= t.registration_capacity then
    if t.waitlist_enabled then v_status := 'waitlisted'; else raise exception 'registration.full'; end if;
  end if;
  if v_phone is null then raise exception 'registration.phoneRequired'; end if;
  if v_email is null then raise exception 'registration.emailRequired'; end if;
  if v_phone !~ '^\+?[0-9\s\-\(\)]{7,20}$' then raise exception 'registration.invalidPhone'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'registration.invalidEmail'; end if;
  if entry_contact_taken(t.id, v_email, v_phone, v_email) then
    raise exception 'Registration already exists for this contact';
  end if;
  v_tie := team_tie_config(t.format_config->'tie');
  if jsonb_typeof(p_members) is distinct from 'array'
     or jsonb_array_length(p_members) < (v_tie->>'roster_min')::integer then
    raise exception 'team.rosterTooSmall';
  end if;
  perform set_config('bracketa.team_entry', 'on', true);
  insert into entries (tournament_id, entry_type, display_name, phone_or_email, contact_phone, contact_email, status)
  values (t.id, 'team', v_name, v_email, v_phone, v_email, v_status)
  returning id into v_id;
  perform set_config('bracketa.team_entry', '', true);
  perform team_write_members(v_id, p_members, (v_tie->>'roster_max')::integer);
  if auth.uid() is not null then
    insert into team_captains (entry_id, user_id) values (v_id, auth.uid()) on conflict do nothing;
  end if;
  return jsonb_build_object('id', v_id, 'status', v_status);
end;
$$;
revoke execute on function public.register_team(text, text, jsonb, text, text, text) from public;
grant execute on function public.register_team(text, text, jsonb, text, text, text) to anon, authenticated;

-- Roster edits: the organizer until the tournament is completed, a captain
-- until it starts. p_team_name renames the team when given.
create or replace function public.save_team_roster(p_entry_id uuid, p_members jsonb, p_team_name text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e entries%rowtype; t tournaments%rowtype; v_admin boolean; v_count integer;
begin
  select * into e from entries where id = p_entry_id for update;
  if e.id is null then raise exception 'Entry not found'; end if;
  select * into t from tournaments where id = e.tournament_id;
  if e.entry_type::text <> 'team' then raise exception 'team.notTeam'; end if;
  v_admin := is_tournament_admin(t.id);
  if not v_admin then
    if not is_team_captain(e.id) then raise exception 'Not allowed'; end if;
    if t.status in ('in_progress', 'completed') or e.status = 'rejected' then raise exception 'team.rosterLocked'; end if;
  elsif t.status = 'completed' then
    raise exception 'lifecycle.completedLocked';
  end if;
  v_count := team_write_members(e.id, p_members, (team_tie_config(t.format_config->'tie')->>'roster_max')::integer);
  update entries
    set display_name = case when p_team_name is null then display_name else team_name_valid(p_team_name) end,
        updated_at = now()
  where id = e.id;
  -- Removed players leave their lines: those lines wait for a new lineup.
  perform refresh_tie_line_status(m.id)
  from matches m where m.parent_match_id is null and m.tournament_id = t.id
    and e.id in (m.side_a_entry_id, m.side_b_entry_id);
  return jsonb_build_object('id', e.id, 'members', v_count);
end;
$$;

-- Template change before any tie exists (the guard refuses it afterwards).
create or replace function public.update_tie_template(p_tournament_id uuid, p_tie jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t tournaments%rowtype;
begin
  if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
  select * into t from tournaments where id = p_tournament_id for update;
  if t.id is null then raise exception 'Tournament not found'; end if;
  if t.category::text <> 'team' then raise exception 'team.notTeam'; end if;
  if t.status in ('in_progress', 'completed') then raise exception 'drafts.rulesLocked'; end if;
  update tournaments
    set format_config = jsonb_set(coalesce(format_config, '{}'::jsonb), '{tie}', team_tie_config(p_tie))
  where id = p_tournament_id;
  return (select format_config->'tie' from tournaments where id = p_tournament_id);
end;
$$;
revoke execute on function public.update_tie_template(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.update_tie_template(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Lineups
-- ---------------------------------------------------------------------------
create table if not exists public.tie_lineups (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  tie_id uuid not null references public.matches(id) on delete cascade,
  line_id uuid not null references public.matches(id) on delete cascade,
  side text not null check (side in ('A', 'B')),
  slot smallint not null check (slot in (1, 2)),
  member_id uuid not null references public.entry_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (line_id, side, slot)
);
create index if not exists idx_tie_lineups_tie on public.tie_lineups (tie_id);
create index if not exists idx_tie_lineups_tournament on public.tie_lineups (tournament_id);

create table if not exists public.tie_lineup_submissions (
  tie_id uuid not null references public.matches(id) on delete cascade,
  side text not null check (side in ('A', 'B')),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  submitted_by uuid references auth.users(id) on delete set null,
  primary key (tie_id, side)
);
create index if not exists idx_tie_lineup_submissions_tournament on public.tie_lineup_submissions (tournament_id);

-- Both sides of a line have their players.
create or replace function public.tie_line_complete(p_line_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((
    select (select count(*) from tie_lineups l where l.line_id = r.id and l.side = 'A') = tie_line_size(tie_line_type(team_tie_config(t.format_config->'tie'), r.line_no))
       and (select count(*) from tie_lineups l where l.line_id = r.id and l.side = 'B') = tie_line_size(tie_line_type(team_tie_config(t.format_config->'tie'), r.line_no))
    from matches r join tournaments t on t.id = r.tournament_id
    where r.id = p_line_id and r.parent_match_id is not null
  ), false);
$$;
revoke execute on function public.tie_line_complete(uuid) from public, anon, authenticated;

-- A line waits ('pending') until both lineups are in, then it is 'ready'.
create or replace function public.refresh_tie_line_status(p_tie_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  update matches r
    set status = case when tie_line_complete(r.id) then 'ready'::match_status else 'pending'::match_status end
  where r.parent_match_id = p_tie_id and r.status <> 'finished'
    and r.status is distinct from case when tie_line_complete(r.id) then 'ready'::match_status else 'pending'::match_status end;
end;
$$;
revoke execute on function public.refresh_tie_line_status(uuid) from public, anon, authenticated;

-- A line with any result or a live score: its players are fixed.
create or replace function public.tie_line_started(p_line_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from matches r where r.id = p_line_id
      and (r.status = 'finished' or r.winner_entry_id is not null or r.side_a_score is not null or r.side_b_score is not null
        or exists (select 1 from match_sets s where s.match_id = r.id)
        or exists (select 1 from live_scores l where l.match_id = r.id))
  );
$$;
revoke execute on function public.tie_line_started(uuid) from public, anon, authenticated;

-- Who sees one side's lineup: organizers and live scorers always, that team's
-- captain, everyone who can read the tournament once both sides submitted or
-- play has started. tenis.access_tournament marks a password viewer.
create or replace function public.tie_lineup_visible(p_tie_id uuid, p_side text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1 from matches m join tournaments t on t.id = m.tournament_id
    where m.id = p_tie_id and (
      is_tournament_admin(t.id) or can_live_score(t.id)
      or is_team_captain(case when p_side = 'A' then m.side_a_entry_id else m.side_b_entry_id end)
      or ((t.is_public or coalesce(current_setting('tenis.access_tournament', true), '') = t.id::text)
        and ((select count(*) from tie_lineup_submissions s where s.tie_id = m.id) = 2
          or exists (select 1 from matches r where r.parent_match_id = m.id and tie_line_started(r.id))))
    )
  );
$$;
revoke execute on function public.tie_lineup_visible(uuid, text) from public;
grant execute on function public.tie_lineup_visible(uuid, text) to anon, authenticated;

alter table public.tie_lineups enable row level security;
alter table public.tie_lineup_submissions enable row level security;
revoke all on public.tie_lineups, public.tie_lineup_submissions from public, anon, authenticated;
grant select on public.tie_lineups to anon, authenticated;
grant select (tie_id, side, tournament_id, submitted_at) on public.tie_lineup_submissions to anon, authenticated;
drop policy if exists tie_lineups_select on public.tie_lineups;
create policy tie_lineups_select on public.tie_lineups for select
using (tie_lineup_visible(tie_id, side));
drop policy if exists tie_lineup_submissions_select on public.tie_lineup_submissions;
create policy tie_lineup_submissions_select on public.tie_lineup_submissions for select
using (exists (
  select 1 from tournaments t where t.id = tie_lineup_submissions.tournament_id
    and (t.is_public or is_tournament_admin(t.id) or can_live_score(t.id))
));
drop policy if exists team_captains_select on public.team_captains;
create policy team_captains_select on public.team_captains for select to authenticated
using (user_id = auth.uid());
grant select on public.team_captains to authenticated;

-- Saves one side's lineup: p_lines = [{"line_no": 1, "members": [member uuid, ...]}].
-- Lines not listed are cleared unless play has started on them. Organizers and
-- live scorers may edit any side at any time before the line starts; a captain
-- edits their own side until it is submitted. p_submit marks the side as
-- submitted (every line must then be complete).
create or replace function public.save_tie_lineup(p_tie_id uuid, p_side text, p_lines jsonb, p_submit boolean default true)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  m matches%rowtype;
  t tournaments%rowtype;
  v_tie jsonb;
  v_entry uuid;
  v_admin boolean;
  v_line matches%rowtype;
  v_item jsonb;
  v_members uuid[];
  v_existing uuid[];
  v_type text;
  v_genders text[];
  v_given integer[] := '{}';
  v_line_no integer;
  v_m uuid;
  v_i integer;
  v_n integer;
begin
  if p_side is null or p_side not in ('A', 'B') then raise exception 'team.invalidSide'; end if;
  select * into m from matches where id = p_tie_id for update;
  if m.id is null or m.parent_match_id is not null then raise exception 'Match not found'; end if;
  select * into t from tournaments where id = m.tournament_id;
  if t.category::text <> 'team' then raise exception 'team.notTeam'; end if;
  if t.status = 'completed' then raise exception 'lifecycle.completedLocked'; end if;
  v_entry := case p_side when 'A' then m.side_a_entry_id else m.side_b_entry_id end;
  if v_entry is null then raise exception 'team.sideUnknown'; end if;
  v_admin := can_live_score(t.id);
  if not v_admin then
    if not is_team_captain(v_entry) then raise exception 'Not allowed'; end if;
    if exists (select 1 from tie_lineup_submissions where tie_id = m.id and side = p_side) then
      raise exception 'team.lineupSubmitted';
    end if;
    if exists (select 1 from matches x where x.parent_match_id = m.id and tie_line_started(x.id)) then
      raise exception 'team.lineupSubmitted';
    end if;
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'team.invalidLineup'; end if;
  v_tie := team_tie_config(t.format_config->'tie');
  v_n := jsonb_array_length(v_tie->'lines');

  for v_item in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item->'line_no') <> 'number'
       or jsonb_typeof(coalesce(v_item->'members', '[]'::jsonb)) <> 'array' then
      raise exception 'team.invalidLineup';
    end if;
    v_line_no := (v_item->>'line_no')::integer;
    if v_line_no = any(v_given) or not exists (select 1 from matches x where x.parent_match_id = m.id and x.line_no = v_line_no) then
      raise exception 'team.invalidLineup';
    end if;
    v_given := v_given || v_line_no;
  end loop;

  for v_line in select * from matches where parent_match_id = m.id order by line_no loop
    v_type := tie_line_type(v_tie, v_line.line_no);
    select coalesce(array_agg(l.member_id order by l.slot), '{}') into v_existing
    from tie_lineups l where l.line_id = v_line.id and l.side = p_side;
    select value into v_item from jsonb_array_elements(p_lines) where (value->>'line_no')::integer = v_line.line_no;
    if v_item is null then
      if not tie_line_started(v_line.id) then delete from tie_lineups where line_id = v_line.id and side = p_side; end if;
      continue;
    end if;
    begin
      select coalesce(array_agg(x::uuid order by o), '{}') into v_members
      from jsonb_array_elements_text(v_item->'members') with ordinality as a(x, o)
      where nullif(x, '') is not null;
    exception when invalid_text_representation then
      raise exception 'team.invalidLineup';
    end;
    v_item := null;
    if tie_line_started(v_line.id) then
      if v_members is distinct from v_existing then raise exception 'team.lineLocked'; end if;
      continue;
    end if;
    if coalesce(array_length(v_members, 1), 0) > tie_line_size(v_type)
       or (select count(distinct x) from unnest(v_members) x) <> coalesce(array_length(v_members, 1), 0) then
      raise exception 'team.invalidLineup';
    end if;
    if exists (select 1 from unnest(v_members) x
               where not exists (select 1 from entry_members em where em.id = x and em.entry_id = v_entry)) then
      raise exception 'team.notInRoster';
    end if;
    select coalesce(array_agg(em.gender order by array_position(v_members, em.id)), '{}') into v_genders
    from entry_members em where em.id = any(v_members);
    if not tie_line_genders_ok(v_type, v_genders) then raise exception 'team.genderMismatch'; end if;
    delete from tie_lineups where line_id = v_line.id and side = p_side;
    v_i := 0;
    foreach v_m in array v_members loop
      v_i := v_i + 1;
      insert into tie_lineups (tournament_id, tie_id, line_id, side, slot, member_id)
      values (t.id, m.id, v_line.id, p_side, v_i, v_m);
    end loop;
  end loop;

  -- Lines per player across the template lines (the decider is free).
  if exists (
    select 1 from tie_lineups l join matches r on r.id = l.line_id
    where l.tie_id = m.id and l.side = p_side and r.line_no <= v_n
    group by l.member_id
    having count(*) filter (where tie_line_size(tie_line_type(v_tie, r.line_no)) = 1) > (v_tie#>>'{max_lines_per_player,singles}')::integer
        or count(*) filter (where tie_line_size(tie_line_type(v_tie, r.line_no)) = 2) > (v_tie#>>'{max_lines_per_player,doubles}')::integer
  ) then
    raise exception 'team.playerLineLimit';
  end if;

  if p_submit then
    if exists (
      select 1 from matches r where r.parent_match_id = m.id
        and (select count(*) from tie_lineups l where l.line_id = r.id and l.side = p_side) <> tie_line_size(tie_line_type(v_tie, r.line_no))
    ) then
      raise exception 'team.lineupIncomplete';
    end if;
    insert into tie_lineup_submissions (tie_id, side, tournament_id, submitted_by)
    values (m.id, p_side, t.id, auth.uid())
    on conflict (tie_id, side) do update set submitted_at = now(), submitted_by = excluded.submitted_by;
  end if;

  perform refresh_tie_line_status(m.id);
  -- Realtime nudge: the tie row changes for every open page.
  update matches set updated_at = now() where id = m.id;
  return jsonb_build_object('tie_id', m.id, 'side', p_side,
    'submitted', exists (select 1 from tie_lineup_submissions where tie_id = m.id and side = p_side));
end;
$$;
revoke execute on function public.save_tie_lineup(uuid, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.save_tie_lineup(uuid, text, jsonb, boolean) to authenticated;

-- The organizer lets a captain edit a submitted lineup again.
create or replace function public.reopen_tie_lineup(p_tie_id uuid, p_side text)
returns void language plpgsql security definer set search_path=public as $$
declare v_tid uuid;
begin
  select tournament_id into v_tid from matches where id = p_tie_id and parent_match_id is null;
  if v_tid is null then raise exception 'Match not found'; end if;
  if not can_live_score(v_tid) then raise exception 'Not allowed'; end if;
  delete from tie_lineup_submissions where tie_id = p_tie_id and side = p_side;
  update matches set updated_at = now() where id = p_tie_id;
end;
$$;
revoke execute on function public.reopen_tie_lineup(uuid, text) from public, anon, authenticated;
grant execute on function public.reopen_tie_lineup(uuid, text) to authenticated;

-- save_team_roster (defined with the rosters) is granted here, after the
-- lineup helpers it calls.
revoke execute on function public.save_team_roster(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_team_roster(uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Lines of a tie
-- ---------------------------------------------------------------------------
create or replace function public.create_tie_rubbers(p_tie_id uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare m matches%rowtype; v_tie jsonb; v_next integer; v_n integer; v_no integer;
begin
  select * into m from matches where id = p_tie_id;
  if m.id is null or m.parent_match_id is not null or not tournament_is_team(m.tournament_id)
     or m.side_a_entry_id is null or m.side_b_entry_id is null
     or exists (select 1 from matches where parent_match_id = p_tie_id) then
    return 0;
  end if;
  select team_tie_config(format_config->'tie') into v_tie from tournaments where id = m.tournament_id;
  v_n := jsonb_array_length(v_tie->'lines');
  select coalesce(max(match_number), 0) into v_next from matches
  where tournament_id = m.tournament_id and stage::text = 'rubber';
  for v_no in 1 .. v_n loop
    insert into matches (tournament_id, stage, round_number, match_number, side_a_entry_id, side_b_entry_id,
                         status, parent_match_id, line_no)
    values (m.tournament_id, 'rubber', m.round_number, v_next + v_no, m.side_a_entry_id, m.side_b_entry_id,
            'pending', p_tie_id, v_no);
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.create_tie_rubbers(uuid) from public, anon, authenticated;

-- A tie gets its lines once both teams are known; a changed team before play
-- replaces them (and their lineups).
create or replace function public.team_tie_sides_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.parent_match_id is not null or not tournament_is_team(new.tournament_id) then return null; end if;
  if tg_op = 'UPDATE' then
    if old.side_a_entry_id is not distinct from new.side_a_entry_id
       and old.side_b_entry_id is not distinct from new.side_b_entry_id then
      return null;
    end if;
    if exists (select 1 from matches r where r.parent_match_id = new.id and tie_line_started(r.id)) then
      raise exception 'team.tieHasResults';
    end if;
    delete from tie_lineup_submissions where tie_id = new.id;
    delete from matches where parent_match_id = new.id;
  end if;
  perform create_tie_rubbers(new.id);
  return null;
end;
$$;
revoke execute on function public.team_tie_sides_changed() from public, anon, authenticated;
drop trigger if exists trg_team_tie_sides on public.matches;
create trigger trg_team_tie_sides after insert or update of side_a_entry_id, side_b_entry_id on public.matches
for each row execute function public.team_tie_sides_changed();

-- ---------------------------------------------------------------------------
-- Tie score
-- ---------------------------------------------------------------------------
-- Recomputes a tie from its lines. 'rubbers': score = lines won, decided once
-- a team has won more than half of the template lines. 'games': score = games
-- of finished lines (a deciding match tie-break counts as one game), decided
-- when every template line is finished. A level tie is a draw in a round robin
-- or group; in a knockout a decider line is added and decides. A changed
-- outcome clears and re-feeds the next rounds unless they already have results.
create or replace function public.recompute_tie(p_tie_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  m matches%rowtype;
  t tournaments%rowtype;
  v_tie jsonb;
  v_n integer;
  v_a integer;
  v_b integer;
  v_fin integer;
  v_any boolean;
  v_dec_id uuid;
  v_dec_winner uuid;
  v_dec_started boolean;
  v_ga integer;
  v_gb integer;
  v_sa integer;
  v_sb integer;
  v_draw_ok boolean;
  v_decided boolean := false;
  v_winner uuid;
  v_status match_status;
  v_next integer;
begin
  select * into m from matches where id = p_tie_id for update;
  if m.id is null or m.parent_match_id is not null then return; end if;
  select * into t from tournaments where id = m.tournament_id;
  if t.category::text <> 'team' then return; end if;
  v_tie := team_tie_config(t.format_config->'tie');
  v_n := jsonb_array_length(v_tie->'lines');
  v_draw_ok := t.format::text = 'round_robin' or m.stage::text = 'group';

  select count(*) filter (where r.status = 'finished' and r.winner_entry_id = m.side_a_entry_id),
         count(*) filter (where r.status = 'finished' and r.winner_entry_id = m.side_b_entry_id),
         count(*) filter (where r.status = 'finished' and r.line_no <= v_n),
         coalesce(bool_or(tie_line_started(r.id)), false)
    into v_a, v_b, v_fin, v_any
  from matches r where r.parent_match_id = m.id;
  select r.id, case when r.status = 'finished' then r.winner_entry_id end, tie_line_started(r.id)
    into v_dec_id, v_dec_winner, v_dec_started
  from matches r where r.parent_match_id = m.id and r.line_no > v_n
  order by r.line_no limit 1;

  select coalesce(sum(case when ms.score_kind = 'match_tiebreak'
                           then (coalesce(ms.side_a_tiebreak, 0) > coalesce(ms.side_b_tiebreak, 0))::integer
                           else ms.side_a_games end), 0)::integer,
         coalesce(sum(case when ms.score_kind = 'match_tiebreak'
                           then (coalesce(ms.side_b_tiebreak, 0) > coalesce(ms.side_a_tiebreak, 0))::integer
                           else ms.side_b_games end), 0)::integer
    into v_ga, v_gb
  from match_sets ms join matches r on r.id = ms.match_id
  where r.parent_match_id = m.id and r.status = 'finished';

  if v_tie->>'win_rule' = 'games' then
    v_sa := v_ga;
    v_sb := v_gb;
    if v_fin = v_n then
      if v_ga <> v_gb then
        v_decided := true;
        v_winner := case when v_ga > v_gb then m.side_a_entry_id else m.side_b_entry_id end;
      elsif v_draw_ok then
        v_decided := true;
      elsif v_dec_winner is not null then
        v_decided := true;
        v_winner := v_dec_winner;
      end if;
    end if;
  else
    v_sa := v_a;
    v_sb := v_b;
    if v_a * 2 > v_n or v_b * 2 > v_n then
      v_decided := true;
      v_winner := case when v_a > v_b then m.side_a_entry_id else m.side_b_entry_id end;
    elsif v_fin = v_n and v_draw_ok then
      v_decided := true;
    end if;
  end if;

  -- The decider exists exactly while a knockout tie is level after every line.
  if not v_decided and v_fin = v_n and not v_draw_ok and v_dec_id is null then
    select coalesce(max(match_number), 0) + 1 into v_next from matches
    where tournament_id = m.tournament_id and stage::text = 'rubber';
    insert into matches (tournament_id, stage, round_number, match_number, side_a_entry_id, side_b_entry_id,
                         status, parent_match_id, line_no)
    values (m.tournament_id, 'rubber', m.round_number, v_next, m.side_a_entry_id, m.side_b_entry_id,
            'pending', m.id, v_n + 1);
  elsif v_dec_id is not null and not v_dec_started and (v_fin < v_n or v_draw_ok or v_decided) then
    delete from matches where id = v_dec_id;
  end if;

  v_status := case
    when v_decided then 'finished'::match_status
    when m.side_a_entry_id is not null and m.side_b_entry_id is not null then 'ready'::match_status
    else 'pending'::match_status end;
  if not v_any then
    v_sa := null;
    v_sb := null;
  end if;

  if (m.side_a_score, m.side_b_score, m.winner_entry_id, m.status)
     is not distinct from (v_sa, v_sb, v_winner, v_status) then
    return;
  end if;
  if m.stage::text = 'group' and exists (
    select 1 from matches where tournament_id = m.tournament_id and stage::text = 'winners'
  ) then
    raise exception 'scoringFlow.downstreamStarted';
  end if;
  if m.winner_entry_id is not null and m.winner_entry_id is distinct from v_winner then
    perform assert_score_correction_safe(m.id);
    perform reset_correction_descendants(m.id);
  end if;
  update matches
    set side_a_score = v_sa, side_b_score = v_sb, winner_entry_id = v_winner, status = v_status
  where id = m.id;
  if v_winner is not null and v_winner is distinct from m.winner_entry_id then
    perform propagate_winner(m.id, v_winner);
  end if;
end;
$$;
revoke execute on function public.recompute_tie(uuid) from public, anon, authenticated;

create or replace function public.team_rubber_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if (old.status, old.winner_entry_id, old.side_a_score, old.side_b_score)
     is distinct from (new.status, new.winner_entry_id, new.side_a_score, new.side_b_score) then
    perform recompute_tie(new.parent_match_id);
  end if;
  return null;
end;
$$;
revoke execute on function public.team_rubber_changed() from public, anon, authenticated;
drop trigger if exists trg_team_rubber_changed on public.matches;
create trigger trg_team_rubber_changed after update of status, winner_entry_id, side_a_score, side_b_score on public.matches
for each row when (new.parent_match_id is not null) execute function public.team_rubber_changed();

-- A line result needs both lineups.
create or replace function public.guard_team_rubber_result()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if (new.status = 'finished' or new.winner_entry_id is not null or new.side_a_score is not null or new.side_b_score is not null)
     and (old.status, old.winner_entry_id, old.side_a_score, old.side_b_score)
         is distinct from (new.status, new.winner_entry_id, new.side_a_score, new.side_b_score)
     and not tie_line_complete(new.id) then
    raise exception 'team.lineupMissing';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_team_rubber_result() from public, anon, authenticated;
drop trigger if exists trg_guard_team_rubber_result on public.matches;
create trigger trg_guard_team_rubber_result before update of status, winner_entry_id, side_a_score, side_b_score on public.matches
for each row when (new.parent_match_id is not null) execute function public.guard_team_rubber_result();

-- The tie itself takes no sets and no live score: it is computed from its lines.
create or replace function public.guard_team_match_sets()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if exists (select 1 from matches m join tournaments t on t.id = m.tournament_id
             where m.id = new.match_id and m.parent_match_id is null and t.category::text = 'team') then
    raise exception 'team.tieComputed';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_team_match_sets() from public, anon, authenticated;
drop trigger if exists trg_guard_team_match_sets on public.match_sets;
create trigger trg_guard_team_match_sets before insert on public.match_sets
for each row execute function public.guard_team_match_sets();

create or replace function public.guard_team_live()
returns trigger language plpgsql security definer set search_path=public as $$
declare m matches%rowtype;
begin
  if new.status <> 'active' then return new; end if;
  select * into m from matches where id = new.match_id;
  if m.parent_match_id is not null then
    if not tie_line_complete(m.id) then raise exception 'team.lineupMissing'; end if;
  elsif tournament_is_team(m.tournament_id) then
    raise exception 'team.tieComputed';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_team_live() from public, anon, authenticated;
drop trigger if exists trg_guard_team_live on public.live_scores;
create trigger trg_guard_team_live before insert or update of status on public.live_scores
for each row execute function public.guard_team_live();

-- ---------------------------------------------------------------------------
-- Standings: ties only. Team ties carry lines won (or games) as their score;
-- sets and games come from the finished lines. Order: points, head-to-head,
-- score difference, sets difference (team ties), games difference, ...
-- ---------------------------------------------------------------------------
create or replace function public.standings_rows(p_tournament_id uuid, p_group_id uuid default null)
returns table (
  entry_id uuid,
  display_name text,
  played integer,
  won integer,
  drawn integer,
  lost integer,
  score_for integer,
  score_against integer,
  diff integer,
  points integer,
  rank integer,
  games_for integer,
  games_against integer,
  games_diff integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sport sport;
  v_cfg jsonb;
  v_team boolean;
  v_win integer;
  v_draw integer;
  v_loss integer;
begin
  select t.sport, coalesce(t.scoring_config, '{}'::jsonb), t.category::text = 'team'
    into v_sport, v_cfg, v_team
  from tournaments t
  where t.id = p_tournament_id;
  if v_sport is null then
    raise exception 'Tournament not found';
  end if;

  -- points defaults: goals sports use 3/1/0, sets sports 1/0/0 (teams 2/1/0, set
  -- at creation); scoring_config may override
  if v_sport in ('tennis', 'padel') then
    v_win := coalesce((v_cfg->>'points_win')::integer, 1);
    v_draw := coalesce((v_cfg->>'points_draw')::integer, 0);
    v_loss := coalesce((v_cfg->>'points_loss')::integer, 0);
  else
    v_win := coalesce((v_cfg->>'points_win')::integer, 3);
    v_draw := coalesce((v_cfg->>'points_draw')::integer, 1);
    v_loss := coalesce((v_cfg->>'points_loss')::integer, 0);
  end if;

  return query
  with participants as (
    select e.id, e.display_name, e.seed_order
    from entries e
    where e.tournament_id = p_tournament_id
      and e.status = 'approved'
      and (
        p_group_id is null
        or e.id in (select ge.entry_id from group_entries ge where ge.group_id = p_group_id)
      )
  ),
  played_matches as (
    select m.*
    from matches m
    where m.tournament_id = p_tournament_id
      and m.parent_match_id is null
      and m.status = 'finished'
      and (p_group_id is null or m.group_id = p_group_id)
      and m.side_a_entry_id is not null
      and m.side_b_entry_id is not null
  ),
  -- Games per match for the sets family (a team tie sums its finished lines).
  -- A deciding match tie-break counts as one game for its winner.
  match_games as (
    select coalesce(r.parent_match_id, r.id) as match_id,
           sum(case when ms.score_kind = 'match_tiebreak'
                    then case when coalesce(ms.side_a_tiebreak, 0) > coalesce(ms.side_b_tiebreak, 0) then 1 else 0 end
                    else ms.side_a_games end)::integer as a_games,
           sum(case when ms.score_kind = 'match_tiebreak'
                    then case when coalesce(ms.side_b_tiebreak, 0) > coalesce(ms.side_a_tiebreak, 0) then 1 else 0 end
                    else ms.side_b_games end)::integer as b_games
    from match_sets ms
    join matches r on r.id = ms.match_id
    where r.id in (select pm.id from played_matches pm)
       or (r.parent_match_id in (select pm.id from played_matches pm) and r.status = 'finished')
    group by coalesce(r.parent_match_id, r.id)
  ),
  -- Sets per team tie: sets won in its finished lines.
  match_sets_won as (
    select r.parent_match_id as match_id,
           sum(coalesce(r.side_a_score, 0))::integer as a_sets,
           sum(coalesce(r.side_b_score, 0))::integer as b_sets
    from matches r
    where v_team and r.parent_match_id in (select pm.id from played_matches pm) and r.status = 'finished'
    group by r.parent_match_id
  ),
  sides as (
    select pm.side_a_entry_id as eid,
           coalesce(pm.side_a_score, 0) as gf,
           coalesce(pm.side_b_score, 0) as ga,
           coalesce(g.a_games, 0) as games_f,
           coalesce(g.b_games, 0) as games_a,
           coalesce(sw.a_sets, 0) as sets_f,
           coalesce(sw.b_sets, 0) as sets_a,
           pm.winner_entry_id
    from played_matches pm
    left join match_games g on g.match_id = pm.id
    left join match_sets_won sw on sw.match_id = pm.id
    union all
    select pm.side_b_entry_id as eid,
           coalesce(pm.side_b_score, 0) as gf,
           coalesce(pm.side_a_score, 0) as ga,
           coalesce(g.b_games, 0) as games_f,
           coalesce(g.a_games, 0) as games_a,
           coalesce(sw.b_sets, 0) as sets_f,
           coalesce(sw.a_sets, 0) as sets_a,
           pm.winner_entry_id
    from played_matches pm
    left join match_games g on g.match_id = pm.id
    left join match_sets_won sw on sw.match_id = pm.id
  ),
  agg as (
    select s.eid,
           count(*)::integer as played,
           count(*) filter (where s.winner_entry_id = s.eid)::integer as won,
           count(*) filter (where s.winner_entry_id is null)::integer as drawn,
           count(*) filter (where s.winner_entry_id is not null and s.winner_entry_id <> s.eid)::integer as lost,
           coalesce(sum(s.gf), 0)::integer as score_for,
           coalesce(sum(s.ga), 0)::integer as score_against,
           coalesce(sum(s.games_f), 0)::integer as games_for,
           coalesce(sum(s.games_a), 0)::integer as games_against,
           coalesce(sum(s.sets_f), 0)::integer as sets_for,
           coalesce(sum(s.sets_a), 0)::integer as sets_against
    from sides s
    group by s.eid
  ),
  merged as (
    select p.id as entry_id,
           p.display_name,
           p.seed_order,
           coalesce(a.played, 0) as played,
           coalesce(a.won, 0) as won,
           coalesce(a.drawn, 0) as drawn,
           coalesce(a.lost, 0) as lost,
           coalesce(a.score_for, 0) as score_for,
           coalesce(a.score_against, 0) as score_against,
           (coalesce(a.score_for, 0) - coalesce(a.score_against, 0)) as diff,
           (coalesce(a.won, 0) * v_win + coalesce(a.drawn, 0) * v_draw + coalesce(a.lost, 0) * v_loss) as points,
           coalesce(a.games_for, 0) as games_for,
           coalesce(a.games_against, 0) as games_against,
           (coalesce(a.games_for, 0) - coalesce(a.games_against, 0)) as games_diff,
           (coalesce(a.sets_for, 0) - coalesce(a.sets_against, 0)) as sets_diff
    from participants p
    left join agg a on a.eid = p.id
  ),
  -- Head-to-head points, counting only matches between entries tied on total points.
  -- Breaks pairwise/group ties; a circular tie falls through to the differences.
  h2h as (
    select e.entry_id, coalesce(sum(e.pts), 0) as h2h_points
    from (
      select pm.side_a_entry_id as entry_id,
             case when pm.winner_entry_id = pm.side_a_entry_id then v_win
                  when pm.winner_entry_id is null then v_draw
                  else v_loss end as pts
      from played_matches pm
      join merged ma on ma.entry_id = pm.side_a_entry_id
      join merged mb on mb.entry_id = pm.side_b_entry_id
      where ma.points = mb.points
      union all
      select pm.side_b_entry_id as entry_id,
             case when pm.winner_entry_id = pm.side_b_entry_id then v_win
                  when pm.winner_entry_id is null then v_draw
                  else v_loss end as pts
      from played_matches pm
      join merged ma on ma.entry_id = pm.side_a_entry_id
      join merged mb on mb.entry_id = pm.side_b_entry_id
      where ma.points = mb.points
    ) e
    group by e.entry_id
  )
  select mg.entry_id,
         mg.display_name,
         mg.played,
         mg.won,
         mg.drawn,
         mg.lost,
         mg.score_for,
         mg.score_against,
         mg.diff,
         mg.points,
         (row_number() over (
            order by mg.points desc, coalesce(h.h2h_points, 0) desc,
                     mg.diff desc, mg.sets_diff desc, mg.games_diff desc, mg.score_for desc, mg.games_for desc,
                     mg.seed_order asc nulls last, mg.display_name asc, mg.entry_id asc
         ))::integer as rank,
         mg.games_for,
         mg.games_against,
         mg.games_diff
  from merged mg
  left join h2h h on h.entry_id = mg.entry_id
  order by rank;
end;
$$;
revoke execute on function public.standings_rows(uuid, uuid) from public, anon, authenticated;

-- Organizer list: a team tournament counts its ties, not their lines.
create or replace function public.list_my_tournaments()
returns jsonb language sql stable security invoker set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'name', t.name,
    'slug', t.slug,
    'sport', t.sport,
    'format', t.format,
    'category', t.category,
    'status', t.status,
    'set_format', t.set_format,
    'doubles_pairing_mode', t.doubles_pairing_mode,
    'visibility', t.visibility,
    'registration_deadline', t.registration_deadline,
    'registration_capacity', t.registration_capacity,
    'created_at', t.created_at,
    'role', ta.role,
    'progress', jsonb_build_object(
      'approved', en.approved, 'pending', en.pending,
      'matches', ma.total, 'played', ma.played, 'byes', ma.byes,
      'live', li.live
    )
  ) order by t.created_at desc), '[]'::jsonb)
  from tournament_admins ta
  join tournaments t on t.id = ta.tournament_id
  cross join lateral (
    select count(*) filter (where e.status = 'approved') approved,
           count(*) filter (where e.status = 'pending') pending
    from entries e where e.tournament_id = t.id
  ) en
  cross join lateral (
    select count(*) total,
           count(*) filter (where m.status = 'finished' and m.side_a_entry_id is not null and m.side_b_entry_id is not null) played,
           count(*) filter (where m.status = 'finished' and (m.side_a_entry_id is null or m.side_b_entry_id is null)) byes
    from matches m where m.tournament_id = t.id and m.parent_match_id is null
  ) ma
  cross join lateral (
    select count(*) live from live_scores l where l.tournament_id = t.id and l.status = 'active'
  ) li
  where ta.user_id = auth.uid();
$$;
revoke execute on function public.list_my_tournaments() from public, anon;
grant execute on function public.list_my_tournaments() to authenticated;

-- The pair editor's CAS view of entries must describe an entry exactly like the
-- sync snapshot does, so it carries the member gender too.
create or replace function tournament_entry_snapshot(p_tournament_id uuid)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,'seed_order',e.seed_order,
  'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,'member_name',em.member_name,'member_order',em.member_order,'gender',em.gender) order by em.member_order) from entry_members em where em.entry_id=e.id),'[]'::jsonb)) order by e.id),'[]')
 from entries e where e.tournament_id=p_tournament_id;
$$;
revoke execute on function tournament_entry_snapshot(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sync snapshot: member gender, lineups (visibility-filtered), submissions,
-- teams with a captain, the caller's own teams.
-- ---------------------------------------------------------------------------
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
   'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,'seed_order',e.seed_order,
   'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,
    'member_name',em.member_name,'member_order',em.member_order,'gender',em.gender) order by em.member_order,em.id)
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
   else '[]'::jsonb end,
  'tie_lineups',case when t.category::text='team' then
   coalesce((select jsonb_agg(jsonb_build_object('tie_id',l.tie_id,'line_id',l.line_id,'side',l.side,'slot',l.slot,'member_id',l.member_id)
    order by l.tie_id,l.line_id,l.side,l.slot)
    from tie_lineups l where l.tournament_id=t.id and tie_lineup_visible(l.tie_id,l.side)),'[]'::jsonb)
   else '[]'::jsonb end,
  'tie_submissions',case when t.category::text='team' then
   coalesce((select jsonb_agg(jsonb_build_object('tie_id',s.tie_id,'side',s.side,'submitted_at',s.submitted_at) order by s.tie_id,s.side)
    from tie_lineup_submissions s where s.tournament_id=t.id),'[]'::jsonb)
   else '[]'::jsonb end,
  'team_captains',case when t.category::text='team' then team_captain_entries(t.id) else '[]'::jsonb end,
  'my_captain_entries',case when t.category::text='team' then my_captain_entries(t.id) else '[]'::jsonb end
 ) from tournaments t where t.id=p_tournament_id;
$$;
revoke execute on function get_tournament_sync_state(uuid) from public, anon, authenticated;
grant execute on function get_tournament_sync_state(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: lineup changes reach open pages (payloads are invalidation only).
-- ---------------------------------------------------------------------------
alter table public.tie_lineups replica identity full;
alter table public.tie_lineup_submissions replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tie_lineups') then
      alter publication supabase_realtime add table public.tie_lineups;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tie_lineup_submissions') then
      alter publication supabase_realtime add table public.tie_lineup_submissions;
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
