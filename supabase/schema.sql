create extension if not exists pgcrypto;

-- Idempotent enum creation (safe to re-run whole schema; plain CREATE TYPE fails if type exists)
do $$ begin
  create type tournament_category as enum ('singles', 'doubles');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type sport as enum ('tennis', 'padel', 'football');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type tournament_format as enum ('single_elimination', 'round_robin', 'groups_playoff', 'double_elimination');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type match_stage as enum ('main', 'group', 'winners', 'losers', 'grand_final', 'third_place');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type registration_status as enum ('pending', 'approved', 'rejected');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type tournament_status as enum ('draft', 'registration_open', 'registration_closed', 'in_progress', 'completed');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type set_format as enum ('best_of_3', 'best_of_5');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type draw_mode as enum ('auto-random', 'manual');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type match_status as enum ('pending', 'ready', 'finished');
exception
  when duplicate_object then null;
end $$;

do $$ begin
  create type doubles_pairing_mode as enum ('pre_agreed', 'pick_random');
exception
  when duplicate_object then null;
end $$;

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  display_name text not null,
  avatar_url text,
  contact_hash text,
  birth_year integer,
  gender text check (gender in ('male', 'female', 'other')),
  country text,
  merged_into uuid references players (id) on delete set null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_players_contact
  on players (contact_hash)
  where contact_hash is not null and is_deleted = false;

create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  sport sport not null default 'tennis',
  format tournament_format not null default 'single_elimination',
  category tournament_category not null,
  set_format set_format,
  status tournament_status not null default 'draft',
  is_public boolean not null default true,
  doubles_pairing_mode doubles_pairing_mode,
  format_config jsonb not null default '{}'::jsonb,
  scoring_config jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tournament_admins (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'counter')),
  created_at timestamptz not null default now(),
  unique (tournament_id, user_id)
);

create table if not exists entries (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  entry_type tournament_category not null,
  display_name text not null,
  phone_or_email text not null,
  status registration_status not null default 'pending',
  seed_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_entries_active_contact
  on entries (tournament_id, phone_or_email)
  where status in ('pending', 'approved');

create table if not exists entry_members (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references entries (id) on delete cascade,
  member_name text not null,
  member_order integer not null check (member_order in (1, 2)),
  player_id uuid references players (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (entry_id, member_order)
);

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  name text not null,
  group_index integer not null check (group_index >= 0),
  created_at timestamptz not null default now(),
  unique (tournament_id, group_index)
);

create table if not exists group_entries (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups (id) on delete cascade,
  entry_id uuid not null references entries (id) on delete cascade,
  seed integer,
  created_at timestamptz not null default now(),
  unique (group_id, entry_id)
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  stage match_stage not null default 'main',
  group_id uuid references groups (id) on delete cascade,
  round_number integer not null check (round_number > 0),
  match_number integer not null check (match_number > 0),
  side_a_entry_id uuid references entries (id) on delete set null,
  side_b_entry_id uuid references entries (id) on delete set null,
  winner_entry_id uuid references entries (id) on delete set null,
  side_a_score integer,
  side_b_score integer,
  side_a_pens integer,
  side_b_pens integer,
  status match_status not null default 'pending',
  next_match_id uuid references matches (id) on delete set null,
  next_slot text check (next_slot in ('A', 'B')),
  loser_next_match_id uuid references matches (id) on delete set null,
  loser_next_slot text check (loser_next_slot in ('A', 'B')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, stage, round_number, match_number)
);

create table if not exists match_sets (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches (id) on delete cascade,
  set_index integer not null check (set_index >= 1 and set_index <= 5),
  side_a_games integer not null check (side_a_games >= 0 and side_a_games <= 7),
  side_b_games integer not null check (side_b_games >= 0 and side_b_games <= 7),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, set_index)
);

create table if not exists bracket_versions (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_bracket_versions_tournament on bracket_versions (tournament_id);
create index if not exists idx_players_user on players (user_id);
create index if not exists idx_entry_members_player on entry_members (player_id);
create index if not exists idx_tournament_admins_user on tournament_admins (user_id);
create index if not exists idx_entries_tournament on entries (tournament_id, status);
create index if not exists idx_matches_tournament on matches (tournament_id, stage, round_number, match_number);
create index if not exists idx_matches_group on matches (group_id);
create index if not exists idx_match_sets_match on match_sets (match_id);
create index if not exists idx_groups_tournament on groups (tournament_id, group_index);
create index if not exists idx_group_entries_group on group_entries (group_id);
create index if not exists idx_created_by on tournaments (created_by);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_tournaments_updated_at on tournaments;
create trigger trg_tournaments_updated_at
before update on tournaments
for each row
execute function set_updated_at();

drop trigger if exists trg_players_updated_at on players;
create trigger trg_players_updated_at
before update on players
for each row
execute function set_updated_at();

drop trigger if exists trg_entries_updated_at on entries;
create trigger trg_entries_updated_at
before update on entries
for each row
execute function set_updated_at();

drop trigger if exists trg_matches_updated_at on matches;
create trigger trg_matches_updated_at
before update on matches
for each row
execute function set_updated_at();

drop trigger if exists trg_match_sets_updated_at on match_sets;
create trigger trg_match_sets_updated_at
before update on match_sets
for each row
execute function set_updated_at();

create or replace function is_tournament_admin(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from tournament_admins ta
    where ta.tournament_id = p_tournament_id
      and ta.user_id = auth.uid()
  );
$$;

create or replace function normalize_contact(p_contact text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(coalesce(trim(p_contact), '')), '\s|-|\+|\(|\)', '', 'g');
$$;

create or replace function hash_contact(p_contact text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when p_contact is null or btrim(p_contact) = '' then null
    else encode(extensions.digest(normalize_contact(p_contact), 'sha256'), 'hex')
  end;
$$;

create or replace function propagate_winner(p_match_id uuid, p_winner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_match_id uuid;
  v_next_slot text;
  v_loser_next_id uuid;
  v_loser_next_slot text;
  v_match_side_a uuid;
  v_match_side_b uuid;
  v_loser uuid;
  v_side_a uuid;
  v_side_b uuid;
begin
  if p_winner_id is null then
    return;
  end if;

  select next_match_id, next_slot, loser_next_match_id, loser_next_slot,
         side_a_entry_id, side_b_entry_id
    into v_next_match_id, v_next_slot, v_loser_next_id, v_loser_next_slot,
         v_match_side_a, v_match_side_b
  from matches
  where id = p_match_id;

  -- Double elimination: route the loser to the losers bracket.
  if v_loser_next_id is not null then
    v_loser := case when p_winner_id = v_match_side_a then v_match_side_b else v_match_side_a end;
    if v_loser is not null then
      if v_loser_next_slot = 'A' then
        update matches set side_a_entry_id = v_loser where id = v_loser_next_id;
      else
        update matches set side_b_entry_id = v_loser where id = v_loser_next_id;
      end if;
      select side_a_entry_id, side_b_entry_id into v_side_a, v_side_b
      from matches where id = v_loser_next_id;
      update matches
        set status = case
          when v_side_a is not null and v_side_b is not null then 'ready'::match_status
          else 'pending'::match_status
        end
      where id = v_loser_next_id and status <> 'finished'::match_status;
    end if;
  end if;

  -- Route the winner to the next match.
  if v_next_match_id is not null then
    if v_next_slot = 'A' then
      update matches set side_a_entry_id = p_winner_id where id = v_next_match_id;
    else
      update matches set side_b_entry_id = p_winner_id where id = v_next_match_id;
    end if;

    select side_a_entry_id, side_b_entry_id into v_side_a, v_side_b
    from matches where id = v_next_match_id;

    update matches
      set status = case
        when v_side_a is not null and v_side_b is not null then 'ready'::match_status
        else 'pending'::match_status
      end
    where id = v_next_match_id and status <> 'finished'::match_status;
  end if;
end;
$$;

create or replace function clear_downstream(p_match_id uuid, p_stale_winner uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_match_id uuid;
  v_next_slot text;
  v_next_winner uuid;
begin
  if p_stale_winner is null then
    return;
  end if;

  select next_match_id, next_slot
    into v_next_match_id, v_next_slot
  from matches
  where id = p_match_id;

  if v_next_match_id is null then
    return;
  end if;

  if v_next_slot = 'A' then
    update matches
    set side_a_entry_id = null
    where id = v_next_match_id
      and side_a_entry_id = p_stale_winner;
  else
    update matches
    set side_b_entry_id = null
    where id = v_next_match_id
      and side_b_entry_id = p_stale_winner;
  end if;

  select winner_entry_id
    into v_next_winner
  from matches
  where id = v_next_match_id;

  if v_next_winner is not null then
    delete from match_sets where match_id = v_next_match_id;
    perform clear_downstream(v_next_match_id, v_next_winner);
  end if;

  update matches
  set winner_entry_id = null,
      status = case
        when side_a_entry_id is not null and side_b_entry_id is not null then 'ready'::match_status
        else 'pending'::match_status
      end
  where id = v_next_match_id
    and status = 'finished'::match_status;
end;
$$;

create or replace function register_entry(
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

drop function if exists create_tournament(
  text,
  text,
  text,
  tournament_category,
  set_format,
  boolean,
  doubles_pairing_mode
);

drop function if exists create_tournament(
  text,
  text,
  text,
  tournament_category,
  set_format,
  boolean,
  doubles_pairing_mode,
  uuid
);

create or replace function create_tournament(
  p_name text,
  p_slug text,
  p_description text default null,
  p_sport sport default 'tennis',
  p_format tournament_format default 'single_elimination',
  p_category tournament_category default 'singles',
  p_set_format set_format default 'best_of_3',
  p_is_public boolean default true,
  p_doubles_pairing_mode doubles_pairing_mode default null,
  p_format_config jsonb default '{}'::jsonb,
  p_scoring_config jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_uid uuid := auth.uid();
  v_category tournament_category := p_category;
  v_set_format set_format;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  -- Sport-forced categories: padel is always doubles;
  -- football sides are single team entities (one entry per side)
  if p_sport = 'padel' then
    v_category := 'doubles';
  elsif p_sport = 'football' then
    v_category := 'singles';
  end if;

  -- set_format only meaningful for sets-family sports (tennis/padel)
  if p_sport in ('tennis', 'padel') then
    v_set_format := coalesce(p_set_format, 'best_of_3');
  else
    v_set_format := null;
  end if;

  insert into tournaments (
    name, slug, description, sport, format, category, set_format, status,
    is_public, doubles_pairing_mode, format_config, scoring_config, created_by
  )
  values (
    p_name,
    p_slug,
    p_description,
    p_sport,
    p_format,
    v_category,
    v_set_format,
    'registration_open',
    p_is_public,
    case when v_category = 'doubles' then coalesce(p_doubles_pairing_mode, 'pre_agreed') else null end,
    coalesce(p_format_config, '{}'::jsonb),
    coalesce(p_scoring_config, '{}'::jsonb),
    v_uid
  )
  returning id into v_id;

  insert into tournament_admins (tournament_id, user_id, role)
  values (v_id, v_uid, 'owner');

  return v_id;
end;
$$;

create or replace function generate_bracket(
  p_tournament_id uuid,
  p_mode draw_mode default 'auto-random',
  p_manual_order uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_ids uuid[];
  v_ordered_ids uuid[];
  v_count integer;
  v_bracket_size integer := 1;
  v_rounds integer := 0;
  v_round integer;
  v_match integer;
  v_matches_in_round integer;
  v_match_id uuid;
  v_next_match_id uuid;
  v_side_a uuid;
  v_side_b uuid;
  v_winner uuid;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  select array_agg(e.id)
    into v_entry_ids
  from entries e
  where e.tournament_id = p_tournament_id
    and e.status = 'approved';

  v_count := coalesce(array_length(v_entry_ids, 1), 0);

  if v_count < 2 then
    raise exception 'At least 2 approved entries required';
  end if;

  if p_mode = 'manual' and p_manual_order is not null then
    select array_agg(x.entry_id)
      into v_ordered_ids
    from (
      select distinct unnest(p_manual_order) as entry_id
    ) x
    where x.entry_id = any(v_entry_ids);

    select coalesce(v_ordered_ids, '{}') || coalesce(array_agg(e.id order by e.created_at), '{}')
      into v_ordered_ids
    from entries e
    where e.tournament_id = p_tournament_id
      and e.status = 'approved'
      and not (e.id = any(coalesce(v_ordered_ids, '{}')));
  else
    select array_agg(e.id order by random())
      into v_ordered_ids
    from entries e
    where e.tournament_id = p_tournament_id
      and e.status = 'approved';
  end if;

  -- Double elimination is built by a dedicated generator.
  if (select format from tournaments where id = p_tournament_id) = 'double_elimination' then
    perform generate_double_elim(p_tournament_id, v_ordered_ids);
    return;
  end if;

  while v_bracket_size < v_count loop
    v_bracket_size := v_bracket_size * 2;
  end loop;

  v_matches_in_round := v_bracket_size / 2;
  while v_matches_in_round >= 1 loop
    v_rounds := v_rounds + 1;
    v_matches_in_round := v_matches_in_round / 2;
  end loop;

  delete from match_sets
  where match_id in (
    select m.id
    from matches m
    where m.tournament_id = p_tournament_id
  );

  delete from matches
  where tournament_id = p_tournament_id;

  create temporary table tmp_match_ids (
    round_number integer,
    match_number integer,
    match_id uuid
  ) on commit drop;

  for v_round in 1..v_rounds loop
    v_matches_in_round := v_bracket_size / (2 ^ v_round);

    for v_match in 1..v_matches_in_round loop
      insert into matches (
        tournament_id,
        round_number,
        match_number,
        status
      ) values (
        p_tournament_id,
        v_round,
        v_match,
        'pending'::match_status
      )
      returning id into v_match_id;

      insert into tmp_match_ids (round_number, match_number, match_id)
      values (v_round, v_match, v_match_id);
    end loop;
  end loop;

  for v_round in 1..(v_rounds - 1) loop
    v_matches_in_round := v_bracket_size / (2 ^ v_round);

    for v_match in 1..v_matches_in_round loop
      select tmi.match_id
        into v_match_id
      from tmp_match_ids tmi
      where tmi.round_number = v_round
        and tmi.match_number = v_match;

      select tmi.match_id
        into v_next_match_id
      from tmp_match_ids tmi
      where tmi.round_number = v_round + 1
        and tmi.match_number = ((v_match + 1) / 2)::integer;

      update matches
      set next_match_id = v_next_match_id,
          next_slot = case when mod(v_match, 2) = 1 then 'A' else 'B' end
      where id = v_match_id;
    end loop;
  end loop;

  v_matches_in_round := v_bracket_size / 2;
  for v_match in 1..v_matches_in_round loop
    v_side_a := null;
    v_side_b := null;

    if (2 * v_match - 1) <= v_count then
      v_side_a := v_ordered_ids[2 * v_match - 1];
    end if;

    if (2 * v_match) <= v_count then
      v_side_b := v_ordered_ids[2 * v_match];
    end if;

    select tmi.match_id
      into v_match_id
    from tmp_match_ids tmi
    where tmi.round_number = 1
      and tmi.match_number = v_match;

    v_winner := case
      when v_side_a is null then v_side_b
      when v_side_b is null then v_side_a
      else null
    end;

    update matches
    set side_a_entry_id = v_side_a,
        side_b_entry_id = v_side_b,
        winner_entry_id = v_winner,
        status = case
          when v_winner is not null then 'finished'::match_status
          when v_side_a is not null and v_side_b is not null then 'ready'::match_status
          else 'pending'::match_status
        end
    where id = v_match_id;

    if v_winner is not null then
      perform propagate_winner(v_match_id, v_winner);
    end if;
  end loop;
end;
$$;

create or replace function rebuild_bracket(
  p_tournament_id uuid,
  p_mode draw_mode default 'auto-random',
  p_manual_order uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot jsonb;
begin
  select jsonb_build_object(
    'matches', coalesce((
      select jsonb_agg(row_to_json(m))
      from matches m
      where m.tournament_id = p_tournament_id
    ), '[]'::jsonb),
    'match_sets', coalesce((
      select jsonb_agg(row_to_json(ms))
      from match_sets ms
      join matches m on m.id = ms.match_id
      where m.tournament_id = p_tournament_id
    ), '[]'::jsonb)
  ) into v_snapshot;

  if v_snapshot->'matches' <> '[]'::jsonb then
    insert into bracket_versions (tournament_id, snapshot)
    values (p_tournament_id, v_snapshot);
  end if;

  perform generate_bracket(p_tournament_id, p_mode, p_manual_order);
end;
$$;

-- =============================================
-- ROUND ROBIN + STANDINGS
-- =============================================

-- Reusable circle-method scheduler. Creates all-play-all matches for the given
-- ordered entry set. Reused by round_robin (stage 'main') and group stage.
-- p_round_offset lets group stage keep round numbers collision-free across groups.
create or replace function generate_round_robin_matches(
  p_tournament_id uuid,
  p_entries uuid[],
  p_stage match_stage,
  p_group_id uuid,
  p_round_offset integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_arr uuid[];
  v_slots integer;
  v_rounds integer;
  v_round integer;
  v_i integer;
  v_home uuid;
  v_away uuid;
  v_match_no integer;
begin
  if coalesce(array_length(p_entries, 1), 0) < 2 then
    raise exception 'At least 2 entries required';
  end if;

  v_arr := p_entries;
  if array_length(v_arr, 1) % 2 = 1 then
    v_arr := v_arr || null::uuid;  -- bye placeholder for odd counts
  end if;
  v_slots := array_length(v_arr, 1);
  v_rounds := v_slots - 1;

  for v_round in 1..v_rounds loop
    v_match_no := 0;
    for v_i in 1..(v_slots / 2) loop
      v_home := v_arr[v_i];
      v_away := v_arr[v_slots - v_i + 1];
      if v_home is not null and v_away is not null then
        v_match_no := v_match_no + 1;
        insert into matches (
          tournament_id, stage, group_id, round_number, match_number,
          side_a_entry_id, side_b_entry_id, status
        ) values (
          p_tournament_id, p_stage, p_group_id, p_round_offset + v_round, v_match_no,
          v_home, v_away, 'ready'::match_status
        );
      end if;
    end loop;
    -- circle rotation: first element fixed, rotate the rest
    v_arr := array[v_arr[1]] || array[v_arr[v_slots]] || v_arr[2:v_slots - 1];
  end loop;

  return v_rounds;
end;
$$;

create or replace function generate_round_robin(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entries uuid[];
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  select array_agg(e.id order by coalesce(e.seed_order, 999999), e.created_at)
    into v_entries
  from entries e
  where e.tournament_id = p_tournament_id
    and e.status = 'approved';

  if coalesce(array_length(v_entries, 1), 0) < 2 then
    raise exception 'At least 2 approved entries required';
  end if;

  delete from match_sets
  where match_id in (select id from matches where tournament_id = p_tournament_id);
  delete from matches where tournament_id = p_tournament_id;

  perform generate_round_robin_matches(p_tournament_id, v_entries, 'main', null, 0);
end;
$$;

-- Standings computed from the canonical per-match aggregate (side_a_score/side_b_score
-- + winner_entry_id). Works for any sport. p_group_id null => whole tournament (round_robin);
-- non-null => that group only.
create or replace function get_standings(
  p_tournament_id uuid,
  p_group_id uuid default null
)
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
  rank integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sport sport;
  v_cfg jsonb;
  v_win integer;
  v_draw integer;
  v_loss integer;
begin
  select t.sport, coalesce(t.scoring_config, '{}'::jsonb)
    into v_sport, v_cfg
  from tournaments t
  where t.id = p_tournament_id;

  if v_sport is null then
    raise exception 'Tournament not found';
  end if;

  if not (
    exists (select 1 from tournaments t where t.id = p_tournament_id and t.is_public)
    or is_tournament_admin(p_tournament_id)
    or can_live_score(p_tournament_id)
  ) then
    raise exception 'Not allowed';
  end if;

  -- points defaults: goals sports use 3/1/0, sets sports 1/0/0; scoring_config may override
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
    select e.id, e.display_name
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
      and m.status = 'finished'
      and (p_group_id is null or m.group_id = p_group_id)
      and m.side_a_entry_id is not null
      and m.side_b_entry_id is not null
  ),
  sides as (
    select side_a_entry_id as eid,
           coalesce(side_a_score, 0) as gf,
           coalesce(side_b_score, 0) as ga,
           winner_entry_id
    from played_matches
    union all
    select side_b_entry_id as eid,
           coalesce(side_b_score, 0) as gf,
           coalesce(side_a_score, 0) as ga,
           winner_entry_id
    from played_matches
  ),
  agg as (
    select s.eid,
           count(*)::integer as played,
           count(*) filter (where s.winner_entry_id = s.eid)::integer as won,
           count(*) filter (where s.winner_entry_id is null)::integer as drawn,
           count(*) filter (where s.winner_entry_id is not null and s.winner_entry_id <> s.eid)::integer as lost,
           coalesce(sum(s.gf), 0)::integer as score_for,
           coalesce(sum(s.ga), 0)::integer as score_against
    from sides s
    group by s.eid
  ),
  merged as (
    select p.id as entry_id,
           p.display_name,
           coalesce(a.played, 0) as played,
           coalesce(a.won, 0) as won,
           coalesce(a.drawn, 0) as drawn,
           coalesce(a.lost, 0) as lost,
           coalesce(a.score_for, 0) as score_for,
           coalesce(a.score_against, 0) as score_against,
           (coalesce(a.score_for, 0) - coalesce(a.score_against, 0)) as diff,
           (coalesce(a.won, 0) * v_win + coalesce(a.drawn, 0) * v_draw + coalesce(a.lost, 0) * v_loss) as points
    from participants p
    left join agg a on a.eid = p.id
  ),
  -- Head-to-head points, counting only matches between entries tied on total points.
  -- Breaks pairwise/group ties correctly; circular ties fall through to diff.
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
                     mg.diff desc, mg.score_for desc, mg.display_name asc
         ))::integer as rank
  from merged mg
  left join h2h h on h.entry_id = mg.entry_id
  order by rank;
end;
$$;

grant execute on function generate_round_robin(uuid) to authenticated;
grant execute on function get_standings(uuid, uuid) to anon, authenticated;

-- =============================================
-- FOOTBALL RESULT ENTRY (goals family)
-- =============================================

-- Writes a final football result: goals per side, plus optional penalty shootout
-- for knockout ties. Draws are legal only in round_robin / group stages.
create or replace function update_football_result(
  p_match_id uuid,
  p_a_goals integer,
  p_b_goals integer,
  p_a_pens integer default null,
  p_b_pens integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status tournament_status;
  v_format tournament_format;
  v_stage match_stage;
  v_side_a uuid;
  v_side_b uuid;
  v_prev_winner uuid;
  v_new_winner uuid;
  v_draw_allowed boolean;
begin
  select m.tournament_id, t.status, t.format, m.stage,
         m.side_a_entry_id, m.side_b_entry_id, m.winner_entry_id
    into v_tournament_id, v_status, v_format, v_stage,
         v_side_a, v_side_b, v_prev_winner
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;
  if not is_tournament_admin(v_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if v_status <> 'in_progress'::tournament_status then
    raise exception 'Scores can be entered only after the tournament starts';
  end if;
  if v_side_a is null or v_side_b is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;
  if p_a_goals is null or p_b_goals is null or p_a_goals < 0 or p_b_goals < 0 then
    raise exception 'Valid goal counts required';
  end if;

  v_draw_allowed := (v_format = 'round_robin') or (v_stage = 'group');

  if p_a_goals > p_b_goals then
    v_new_winner := v_side_a;
  elsif p_b_goals > p_a_goals then
    v_new_winner := v_side_b;
  else
    -- tie
    if v_draw_allowed then
      v_new_winner := null;
    else
      if p_a_pens is null or p_b_pens is null or p_a_pens = p_b_pens then
        raise exception 'Penalty shootout result required to break a knockout tie';
      end if;
      v_new_winner := case when p_a_pens > p_b_pens then v_side_a else v_side_b end;
    end if;
  end if;

  update matches
  set side_a_score = p_a_goals,
      side_b_score = p_b_goals,
      side_a_pens = p_a_pens,
      side_b_pens = p_b_pens,
      winner_entry_id = v_new_winner,
      status = 'finished'::match_status
  where id = p_match_id;

  if v_prev_winner is not null and v_prev_winner is distinct from v_new_winner then
    perform clear_downstream(p_match_id, v_prev_winner);
  end if;

  if v_new_winner is not null then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  return v_new_winner;
end;
$$;

grant execute on function update_football_result(uuid, integer, integer, integer, integer) to authenticated;

-- =============================================
-- GROUPS + PLAYOFF
-- =============================================

-- Single-elimination tree builder from an already-ordered seed array, scoped to a
-- stage. Only touches matches of that stage (does not delete group-stage matches).
create or replace function generate_single_elim(
  p_tournament_id uuid,
  p_seeds uuid[],
  p_stage match_stage default 'main'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_bracket_size integer := 1;
  v_rounds integer := 0;
  v_round integer;
  v_match integer;
  v_matches_in_round integer;
  v_match_id uuid;
  v_next_match_id uuid;
  v_side_a uuid;
  v_side_b uuid;
  v_winner uuid;
begin
  v_count := coalesce(array_length(p_seeds, 1), 0);
  if v_count < 2 then
    raise exception 'At least 2 seeds required';
  end if;

  while v_bracket_size < v_count loop
    v_bracket_size := v_bracket_size * 2;
  end loop;

  v_matches_in_round := v_bracket_size / 2;
  while v_matches_in_round >= 1 loop
    v_rounds := v_rounds + 1;
    v_matches_in_round := v_matches_in_round / 2;
  end loop;

  delete from match_sets
  where match_id in (
    select id from matches where tournament_id = p_tournament_id and stage = p_stage
  );
  delete from matches where tournament_id = p_tournament_id and stage = p_stage;

  create temporary table tmp_se_ids (
    round_number integer,
    match_number integer,
    match_id uuid
  ) on commit drop;

  for v_round in 1..v_rounds loop
    v_matches_in_round := v_bracket_size / (2 ^ v_round);
    for v_match in 1..v_matches_in_round loop
      insert into matches (tournament_id, stage, round_number, match_number, status)
      values (p_tournament_id, p_stage, v_round, v_match, 'pending'::match_status)
      returning id into v_match_id;
      insert into tmp_se_ids (round_number, match_number, match_id)
      values (v_round, v_match, v_match_id);
    end loop;
  end loop;

  for v_round in 1..(v_rounds - 1) loop
    v_matches_in_round := v_bracket_size / (2 ^ v_round);
    for v_match in 1..v_matches_in_round loop
      select match_id into v_match_id from tmp_se_ids
        where round_number = v_round and match_number = v_match;
      select match_id into v_next_match_id from tmp_se_ids
        where round_number = v_round + 1 and match_number = ((v_match + 1) / 2)::integer;
      update matches
        set next_match_id = v_next_match_id,
            next_slot = case when mod(v_match, 2) = 1 then 'A' else 'B' end
      where id = v_match_id;
    end loop;
  end loop;

  v_matches_in_round := v_bracket_size / 2;
  for v_match in 1..v_matches_in_round loop
    v_side_a := null;
    v_side_b := null;
    if (2 * v_match - 1) <= v_count then v_side_a := p_seeds[2 * v_match - 1]; end if;
    if (2 * v_match) <= v_count then v_side_b := p_seeds[2 * v_match]; end if;

    select match_id into v_match_id from tmp_se_ids
      where round_number = 1 and match_number = v_match;

    v_winner := case
      when v_side_a is null then v_side_b
      when v_side_b is null then v_side_a
      else null
    end;

    update matches
      set side_a_entry_id = v_side_a,
          side_b_entry_id = v_side_b,
          winner_entry_id = v_winner,
          status = case
            when v_winner is not null then 'finished'::match_status
            when v_side_a is not null and v_side_b is not null then 'ready'::match_status
            else 'pending'::match_status
          end
    where id = v_match_id;

    if v_winner is not null then
      perform propagate_winner(v_match_id, v_winner);
    end if;
  end loop;

  drop table if exists tmp_se_ids;
end;
$$;

-- Snake-distribute approved entries into N groups, then round-robin within each group.
create or replace function generate_groups(
  p_tournament_id uuid,
  p_group_count integer default 2
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entries uuid[];
  v_n integer;
  v_g integer;
  v_i integer;
  v_group_ids uuid[] := '{}';
  v_gid uuid;
  v_target integer;
  v_dir integer;
  v_pos integer;
  v_seed integer;
  v_group_members uuid[];
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if p_group_count < 2 then
    raise exception 'At least 2 groups required';
  end if;

  select array_agg(e.id order by coalesce(e.seed_order, 999999), e.created_at)
    into v_entries
  from entries e
  where e.tournament_id = p_tournament_id and e.status = 'approved';

  v_n := coalesce(array_length(v_entries, 1), 0);
  if v_n < p_group_count * 2 then
    raise exception 'Need at least 2 entries per group';
  end if;

  -- wipe existing structure
  delete from match_sets where match_id in (select id from matches where tournament_id = p_tournament_id);
  delete from matches where tournament_id = p_tournament_id;
  delete from groups where tournament_id = p_tournament_id;  -- cascades group_entries

  -- create groups A, B, C, ...
  for v_g in 0..(p_group_count - 1) loop
    insert into groups (tournament_id, name, group_index)
    values (p_tournament_id, chr(65 + v_g), v_g)
    returning id into v_gid;
    v_group_ids := v_group_ids || v_gid;
  end loop;

  -- snake distribution
  for v_i in 1..v_n loop
    v_pos := ((v_i - 1) / p_group_count);           -- row index (0-based)
    if v_pos % 2 = 0 then
      v_target := ((v_i - 1) % p_group_count);      -- left to right
    else
      v_target := p_group_count - 1 - ((v_i - 1) % p_group_count); -- right to left
    end if;
    insert into group_entries (group_id, entry_id, seed)
    values (v_group_ids[v_target + 1], v_entries[v_i], v_i);
  end loop;

  -- round-robin per group; round_offset keeps round numbers unique across groups
  for v_g in 0..(p_group_count - 1) loop
    select array_agg(ge.entry_id order by ge.seed)
      into v_group_members
    from group_entries ge
    where ge.group_id = v_group_ids[v_g + 1];

    perform generate_round_robin_matches(
      p_tournament_id, v_group_members, 'group', v_group_ids[v_g + 1], v_g * 1000
    );
  end loop;
end;
$$;

-- After all group matches finish, seed a knockout bracket (stage 'winners') from the
-- top N of each group with cross-group placement to avoid same-group early meetings.
create or replace function generate_group_playoff(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance integer;
  v_group record;
  v_winners uuid[] := '{}';
  v_runners uuid[] := '{}';
  v_extra uuid[] := '{}';
  v_seeds uuid[] := '{}';
  v_qualifier uuid;
  v_group_count integer;
  v_i integer;
  v_rank integer;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if exists (
    select 1 from matches
    where tournament_id = p_tournament_id and stage = 'group' and status <> 'finished'
  ) then
    raise exception 'All group matches must be finished first';
  end if;

  select coalesce((format_config->>'advance_per_group')::integer, 2)
    into v_advance
  from tournaments where id = p_tournament_id;

  select count(*) into v_group_count from groups where tournament_id = p_tournament_id;
  if v_group_count < 1 then
    raise exception 'No groups found';
  end if;

  -- collect qualifiers by rank, group order
  for v_group in
    select id, group_index from groups where tournament_id = p_tournament_id order by group_index
  loop
    for v_rank in 1..v_advance loop
      select s.entry_id into v_qualifier
      from get_standings(p_tournament_id, v_group.id) s
      where s.rank = v_rank;
      if v_qualifier is not null then
        if v_rank = 1 then
          v_winners := v_winners || v_qualifier;
        elsif v_rank = 2 then
          v_runners := v_runners || v_qualifier;
        else
          v_extra := v_extra || v_qualifier;
        end if;
      end if;
    end loop;
  end loop;

  -- build seed order: interleave winners with reversed runners-up so W_i faces R_j (j != i)
  if v_advance = 1 then
    v_seeds := v_winners;
  else
    for v_i in 1..array_length(v_winners, 1) loop
      v_seeds := v_seeds || v_winners[v_i];
      if array_length(v_runners, 1) >= v_i then
        v_seeds := v_seeds || v_runners[array_length(v_runners, 1) - v_i + 1];
      end if;
    end loop;
    -- any deeper qualifiers appended (best-effort for advance > 2)
    v_seeds := v_seeds || v_extra;
  end if;

  if coalesce(array_length(v_seeds, 1), 0) < 2 then
    raise exception 'Not enough qualifiers for a playoff';
  end if;

  perform generate_single_elim(p_tournament_id, v_seeds, 'winners');
end;
$$;

grant execute on function generate_single_elim(uuid, uuid[], match_stage) to authenticated;
grant execute on function generate_groups(uuid, integer) to authenticated;
grant execute on function generate_group_playoff(uuid) to authenticated;

-- =============================================
-- DOUBLE ELIMINATION
-- =============================================

-- Builds a double-elimination bracket: winners bracket (stage 'winners'),
-- losers bracket (stage 'losers') with WB dropdown routing via loser_next_match_id,
-- and a single grand final (stage 'grand_final'). v1 requires a power-of-two seed
-- count (no byes) and uses a single grand final (no bracket reset).
create or replace function generate_double_elim(
  p_tournament_id uuid,
  p_seeds uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_b integer := 1;
  v_k integer := 0;
  v_tmp integer;
  v_r integer;
  v_m integer;
  v_cnt integer;
  v_j integer;
  v_id uuid;
  v_nid uuid;
  v_side_a uuid;
  v_side_b uuid;
  v_winner uuid;
begin
  v_count := coalesce(array_length(p_seeds, 1), 0);
  if v_count < 2 then
    raise exception 'At least 2 seeds required';
  end if;

  while v_b < v_count loop
    v_b := v_b * 2;
  end loop;
  if v_b <> v_count then
    raise exception 'Double elimination v1 requires a power-of-two participant count (got %)', v_count;
  end if;

  v_tmp := v_b;
  while v_tmp > 1 loop
    v_k := v_k + 1;
    v_tmp := v_tmp / 2;
  end loop;

  delete from match_sets where match_id in (
    select id from matches where tournament_id = p_tournament_id
      and stage in ('winners', 'losers', 'grand_final')
  );
  delete from matches where tournament_id = p_tournament_id
    and stage in ('winners', 'losers', 'grand_final');

  create temporary table tmp_de (br text, rnd integer, mno integer, id uuid) on commit drop;

  -- Winners bracket matches
  for v_r in 1..v_k loop
    v_cnt := v_b / (2 ^ v_r);
    for v_m in 1..v_cnt loop
      insert into matches (tournament_id, stage, round_number, match_number, status)
      values (p_tournament_id, 'winners', v_r, v_m, 'pending'::match_status)
      returning id into v_id;
      insert into tmp_de values ('W', v_r, v_m, v_id);
    end loop;
  end loop;

  -- Losers bracket matches: rounds 1..(2k-2)
  if v_k >= 2 then
    for v_r in 1..(2 * v_k - 2) loop
      v_j := (v_r + 1) / 2;
      v_cnt := v_b / (2 ^ (v_j + 1));
      for v_m in 1..v_cnt loop
        insert into matches (tournament_id, stage, round_number, match_number, status)
        values (p_tournament_id, 'losers', v_r, v_m, 'pending'::match_status)
        returning id into v_id;
        insert into tmp_de values ('L', v_r, v_m, v_id);
      end loop;
    end loop;
  end if;

  -- Grand final
  insert into matches (tournament_id, stage, round_number, match_number, status)
  values (p_tournament_id, 'grand_final', 1, 1, 'pending'::match_status)
  returning id into v_id;
  insert into tmp_de values ('GF', 1, 1, v_id);

  -- Winners bracket internal links (winner advances)
  for v_r in 1..(v_k - 1) loop
    v_cnt := v_b / (2 ^ v_r);
    for v_m in 1..v_cnt loop
      select id into v_id from tmp_de where br = 'W' and rnd = v_r and mno = v_m;
      select id into v_nid from tmp_de where br = 'W' and rnd = v_r + 1 and mno = ((v_m + 1) / 2);
      update matches set next_match_id = v_nid,
        next_slot = case when v_m % 2 = 1 then 'A' else 'B' end where id = v_id;
    end loop;
  end loop;
  -- WB final winner -> grand final slot A
  select id into v_id from tmp_de where br = 'W' and rnd = v_k and mno = 1;
  select id into v_nid from tmp_de where br = 'GF';
  update matches set next_match_id = v_nid, next_slot = 'A' where id = v_id;

  if v_k >= 2 then
    -- WB round 1 losers -> LB round 1 (both slots)
    v_cnt := v_b / 2;
    for v_m in 1..v_cnt loop
      select id into v_id from tmp_de where br = 'W' and rnd = 1 and mno = v_m;
      select id into v_nid from tmp_de where br = 'L' and rnd = 1 and mno = ((v_m + 1) / 2);
      update matches set loser_next_match_id = v_nid,
        loser_next_slot = case when v_m % 2 = 1 then 'A' else 'B' end where id = v_id;
    end loop;
    -- WB round i (2..k) losers -> LB minor round (2i-2), slot B, match m -> m
    for v_r in 2..v_k loop
      v_cnt := v_b / (2 ^ v_r);
      for v_m in 1..v_cnt loop
        select id into v_id from tmp_de where br = 'W' and rnd = v_r and mno = v_m;
        select id into v_nid from tmp_de where br = 'L' and rnd = (2 * v_r - 2) and mno = v_m;
        update matches set loser_next_match_id = v_nid, loser_next_slot = 'B' where id = v_id;
      end loop;
    end loop;

    -- LB internal links
    for v_r in 1..(2 * v_k - 3) loop
      v_j := (v_r + 1) / 2;
      v_cnt := v_b / (2 ^ (v_j + 1));
      for v_m in 1..v_cnt loop
        select id into v_id from tmp_de where br = 'L' and rnd = v_r and mno = v_m;
        if v_r % 2 = 1 then
          -- odd round (round1 / major): winner -> next round slot A, same match number
          select id into v_nid from tmp_de where br = 'L' and rnd = v_r + 1 and mno = v_m;
          update matches set next_match_id = v_nid, next_slot = 'A' where id = v_id;
        else
          -- even round (minor): winner pairs into next (major) round
          select id into v_nid from tmp_de where br = 'L' and rnd = v_r + 1 and mno = ((v_m + 1) / 2);
          update matches set next_match_id = v_nid,
            next_slot = case when v_m % 2 = 1 then 'A' else 'B' end where id = v_id;
        end if;
      end loop;
    end loop;
    -- LB final winner -> grand final slot B
    select id into v_id from tmp_de where br = 'L' and rnd = (2 * v_k - 2) and mno = 1;
    select id into v_nid from tmp_de where br = 'GF';
    update matches set next_match_id = v_nid, next_slot = 'B' where id = v_id;
  end if;

  -- Seed winners bracket round 1
  v_cnt := v_b / 2;
  for v_m in 1..v_cnt loop
    v_side_a := p_seeds[2 * v_m - 1];
    v_side_b := p_seeds[2 * v_m];
    select id into v_id from tmp_de where br = 'W' and rnd = 1 and mno = v_m;
    update matches set side_a_entry_id = v_side_a, side_b_entry_id = v_side_b,
      status = 'ready'::match_status where id = v_id;
  end loop;

  drop table if exists tmp_de;
end;
$$;

grant execute on function generate_double_elim(uuid, uuid[]) to authenticated;

create or replace function form_random_pairs(p_tournament_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unpaired_ids uuid[];
  v_count integer;
  v_i integer;
  v_entry_a uuid;
  v_entry_b uuid;
  v_name_a text;
  v_name_b text;
  v_pairs_formed integer := 0;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if not exists (
    select 1 from tournaments
    where id = p_tournament_id
      and category = 'doubles'
      and doubles_pairing_mode = 'pick_random'
  ) then
    raise exception 'Tournament is not configured for random pairing';
  end if;

  select array_agg(e.id order by random())
    into v_unpaired_ids
  from entries e
  where e.tournament_id = p_tournament_id
    and e.status = 'approved'
    and e.entry_type = 'doubles'
    and not exists (
      select 1 from entry_members em
      where em.entry_id = e.id and em.member_order = 2
    );

  v_count := coalesce(array_length(v_unpaired_ids, 1), 0);

  if v_count = 0 then
    return 0;
  end if;

  if v_count % 2 <> 0 then
    raise exception 'Odd number of unpaired players (%). Remove or add one before forming pairs.', v_count;
  end if;

  v_i := 1;
  while v_i <= v_count - 1 loop
    v_entry_a := v_unpaired_ids[v_i];
    v_entry_b := v_unpaired_ids[v_i + 1];

    select em.member_name into v_name_a
    from entry_members em
    where em.entry_id = v_entry_a and em.member_order = 1;

    select em.member_name into v_name_b
    from entry_members em
    where em.entry_id = v_entry_b and em.member_order = 1;

    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_a, v_name_b, 2);

    update entries
    set display_name = v_name_a || ' / ' || v_name_b
    where id = v_entry_a;

    delete from entry_members where entry_id = v_entry_b;
    delete from entries where id = v_entry_b;

    v_pairs_formed := v_pairs_formed + 1;
    v_i := v_i + 2;
  end loop;

  return v_pairs_formed;
end;
$$;

create or replace function form_manual_pairs(
  p_tournament_id uuid,
  p_pairs jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pair jsonb;
  v_entry_a uuid;
  v_entry_b uuid;
  v_name_a text;
  v_name_b text;
  v_pairs_formed integer := 0;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if not exists (
    select 1 from tournaments
    where id = p_tournament_id
      and category = 'doubles'
      and doubles_pairing_mode = 'pick_random'
  ) then
    raise exception 'Tournament is not configured for random pairing';
  end if;

  for v_pair in select * from jsonb_array_elements(p_pairs)
  loop
    v_entry_a := (v_pair->>0)::uuid;
    v_entry_b := (v_pair->>1)::uuid;

    if not exists (
      select 1 from entries
      where id = v_entry_a
        and tournament_id = p_tournament_id
        and status = 'approved'
        and not exists (
          select 1 from entry_members em where em.entry_id = v_entry_a and em.member_order = 2
        )
    ) then
      raise exception 'Entry % is not a valid unpaired entry', v_entry_a;
    end if;

    if not exists (
      select 1 from entries
      where id = v_entry_b
        and tournament_id = p_tournament_id
        and status = 'approved'
        and not exists (
          select 1 from entry_members em where em.entry_id = v_entry_b and em.member_order = 2
        )
    ) then
      raise exception 'Entry % is not a valid unpaired entry', v_entry_b;
    end if;

    select em.member_name into v_name_a
    from entry_members em
    where em.entry_id = v_entry_a and em.member_order = 1;

    select em.member_name into v_name_b
    from entry_members em
    where em.entry_id = v_entry_b and em.member_order = 1;

    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_a, v_name_b, 2);

    update entries
    set display_name = v_name_a || ' / ' || v_name_b
    where id = v_entry_a;

    delete from entry_members where entry_id = v_entry_b;
    delete from entries where id = v_entry_b;

    v_pairs_formed := v_pairs_formed + 1;
  end loop;

  return v_pairs_formed;
end;
$$;

create or replace function split_pairs(
  p_tournament_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_member2_name text;
  v_new_entry_id uuid;
  v_split_count integer := 0;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if not exists (
    select 1 from tournaments
    where id = p_tournament_id
      and category = 'doubles'
      and doubles_pairing_mode = 'pick_random'
  ) then
    raise exception 'Tournament is not configured for random pairing';
  end if;

  if exists (
    select 1 from tournaments
    where id = p_tournament_id
      and status in ('in_progress', 'completed')
  ) then
    raise exception 'Cannot edit pairs while tournament is in progress or completed';
  end if;

  delete from match_sets where match_id in (
    select id from matches where tournament_id = p_tournament_id
  );
  delete from matches where tournament_id = p_tournament_id;

  for v_entry in
    select e.id, e.phone_or_email
    from entries e
    where e.tournament_id = p_tournament_id
      and e.status = 'approved'
      and exists (
        select 1 from entry_members em
        where em.entry_id = e.id and em.member_order = 2
      )
  loop
    select em.member_name into v_member2_name
    from entry_members em
    where em.entry_id = v_entry.id and em.member_order = 2;

    delete from entry_members
    where entry_id = v_entry.id and member_order = 2;

    update entries
    set display_name = (
      select em.member_name from entry_members em
      where em.entry_id = v_entry.id and em.member_order = 1
    )
    where id = v_entry.id;

    insert into entries (tournament_id, entry_type, display_name, phone_or_email, status)
    values (p_tournament_id, 'doubles', v_member2_name, 'split-' || gen_random_uuid(), 'approved')
    returning id into v_new_entry_id;

    insert into entry_members (entry_id, member_name, member_order)
    values (v_new_entry_id, v_member2_name, 1);

    v_split_count := v_split_count + 1;
  end loop;

  return v_split_count;
end;
$$;

create or replace function update_match_sets(
  p_match_id uuid,
  p_sets jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_tournament_status tournament_status;
  v_set_format set_format;
  v_required_wins integer;
  v_side_a_id uuid;
  v_side_b_id uuid;
  v_previous_winner uuid;
  v_new_winner uuid;
  v_a_wins integer := 0;
  v_b_wins integer := 0;
  v_item jsonb;
  v_set_index integer;
  v_a_games integer;
  v_b_games integer;
begin
  select m.tournament_id,
         m.side_a_entry_id,
         m.side_b_entry_id,
         m.winner_entry_id,
         t.set_format,
         t.status
    into v_tournament_id,
         v_side_a_id,
         v_side_b_id,
         v_previous_winner,
         v_set_format,
         v_tournament_status
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not is_tournament_admin(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Scores can be entered only after the tournament starts';
  end if;

  if v_side_a_id is null or v_side_b_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;

  v_required_wins := case
    when v_set_format = 'best_of_5' then 3
    else 2
  end;

  delete from match_sets where match_id = p_match_id;

  for v_item in
    select value
    from jsonb_array_elements(p_sets)
  loop
    v_set_index := (v_item->>'set_index')::integer;
    v_a_games := (v_item->>'side_a_games')::integer;
    v_b_games := (v_item->>'side_b_games')::integer;

    insert into match_sets (
      match_id,
      set_index,
      side_a_games,
      side_b_games
    ) values (
      p_match_id,
      v_set_index,
      v_a_games,
      v_b_games
    );

    if v_a_games > v_b_games then
      v_a_wins := v_a_wins + 1;
    elsif v_b_games > v_a_games then
      v_b_wins := v_b_wins + 1;
    end if;
  end loop;

  v_new_winner := case
    when v_a_wins >= v_required_wins then v_side_a_id
    when v_b_wins >= v_required_wins then v_side_b_id
    else null
  end;

  update matches
  set winner_entry_id = v_new_winner,
      side_a_score = v_a_wins,
      side_b_score = v_b_wins,
      status = case
        when v_new_winner is null then 'ready'::match_status
        else 'finished'::match_status
      end
  where id = p_match_id;

  if v_previous_winner is not null and v_previous_winner is distinct from v_new_winner then
    perform clear_downstream(p_match_id, v_previous_winner);
  end if;

  if v_new_winner is not null then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  -- status transitions are managed explicitly via the admin UI

  return v_new_winner;
end;
$$;

create or replace function swap_bracket_slots(
  p_tournament_id uuid,
  p_from_match_id uuid,
  p_from_slot text,
  p_to_match_id uuid,
  p_to_slot text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fs text := upper(trim(p_from_slot));
  v_ts text := upper(trim(p_to_slot));
  m_from matches%rowtype;
  m_to matches%rowtype;
  v1 uuid;
  v2 uuid;
  nf_a uuid;
  nf_b uuid;
  nt_a uuid;
  nt_b uuid;
begin
  if v_fs not in ('A', 'B') or v_ts not in ('A', 'B') then
    raise exception 'Invalid slot (use A or B)';
  end if;

  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  select * into m_from from matches where id = p_from_match_id for update;
  select * into m_to from matches where id = p_to_match_id for update;

  if m_from.id is null or m_to.id is null then
    raise exception 'Match not found';
  end if;

  if m_from.tournament_id <> p_tournament_id or m_to.tournament_id <> p_tournament_id then
    raise exception 'Match does not belong to this tournament';
  end if;

  if m_from.status = 'finished'::match_status or m_to.status = 'finished'::match_status then
    raise exception 'Cannot move players in finished matches';
  end if;

  if exists (
    select 1
    from match_sets ms
    where ms.match_id in (p_from_match_id, p_to_match_id)
  ) then
    raise exception 'Cannot move players when match scores exist';
  end if;

  if p_from_match_id = p_to_match_id then
    if v_fs = v_ts then
      return;
    end if;
    update matches
    set
      side_a_entry_id = m_from.side_b_entry_id,
      side_b_entry_id = m_from.side_a_entry_id,
      winner_entry_id = null,
      status = case
        when m_from.side_b_entry_id is not null and m_from.side_a_entry_id is not null then 'ready'::match_status
        else 'pending'::match_status
      end
    where id = p_from_match_id;
    return;
  end if;

  v1 := case v_fs when 'A' then m_from.side_a_entry_id else m_from.side_b_entry_id end;
  v2 := case v_ts when 'A' then m_to.side_a_entry_id else m_to.side_b_entry_id end;

  nf_a := m_from.side_a_entry_id;
  nf_b := m_from.side_b_entry_id;
  nt_a := m_to.side_a_entry_id;
  nt_b := m_to.side_b_entry_id;

  if v_fs = 'A' then
    nf_a := v2;
  else
    nf_b := v2;
  end if;

  if v_ts = 'A' then
    nt_a := v1;
  else
    nt_b := v1;
  end if;

  update matches
  set
    side_a_entry_id = nf_a,
    side_b_entry_id = nf_b,
    winner_entry_id = null,
    status = case
      when nf_a is not null and nf_b is not null then 'ready'::match_status
      else 'pending'::match_status
    end
  where id = p_from_match_id;

  update matches
  set
    side_a_entry_id = nt_a,
    side_b_entry_id = nt_b,
    winner_entry_id = null,
    status = case
      when nt_a is not null and nt_b is not null then 'ready'::match_status
      else 'pending'::match_status
    end
  where id = p_to_match_id;
end;
$$;

create or replace function apply_bracket_layout(
  p_tournament_id uuid,
  p_layout jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_match_id uuid;
  v_side_a uuid;
  v_side_b uuid;
  v_match matches%rowtype;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  for v_item in select * from jsonb_array_elements(p_layout)
  loop
    v_match_id := (v_item->>'match_id')::uuid;
    v_side_a := nullif(v_item->>'side_a_entry_id', '')::uuid;
    v_side_b := nullif(v_item->>'side_b_entry_id', '')::uuid;

    select * into v_match from matches where id = v_match_id;
    if v_match.id is null then
      raise exception 'Match % not found', v_match_id;
    end if;
    if v_match.tournament_id <> p_tournament_id then
      raise exception 'Match does not belong to this tournament';
    end if;
    if v_match.status = 'finished'::match_status then
      raise exception 'Cannot modify finished match';
    end if;

    update matches
    set
      side_a_entry_id = v_side_a,
      side_b_entry_id = v_side_b,
      winner_entry_id = null,
      status = case
        when v_side_a is not null and v_side_b is not null then 'ready'::match_status
        else 'pending'::match_status
      end
    where id = v_match_id;
  end loop;
end;
$$;

create or replace function add_tournament_admin_by_email(
  p_tournament_id uuid,
  p_email text,
  p_role text default 'editor'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not authorized';
  end if;

  select id into v_user_id
  from auth.users
  where email = lower(trim(p_email));

  if v_user_id is null then
    raise exception 'User with email % not found', p_email;
  end if;

  insert into tournament_admins (tournament_id, user_id, role)
  values (p_tournament_id, v_user_id, p_role)
  on conflict (tournament_id, user_id)
  do update set role = excluded.role;
end;
$$;

create or replace function remove_tournament_admin(
  p_tournament_id uuid,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not authorized';
  end if;

  delete from tournament_admins
  where id = p_admin_id
    and tournament_id = p_tournament_id;
end;
$$;

create or replace function get_tournament_admins_with_email(p_tournament_id uuid)
returns table (
  id uuid,
  user_id uuid,
  email text,
  role text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not authorized';
  end if;

  return query
    select ta.id, ta.user_id, u.email::text, ta.role, ta.created_at
    from tournament_admins ta
    join auth.users u on u.id = ta.user_id
    where ta.tournament_id = p_tournament_id
    order by ta.created_at asc;
end;
$$;

alter table tournaments enable row level security;
alter table tournament_admins enable row level security;
alter table entries enable row level security;
alter table entry_members enable row level security;
alter table matches enable row level security;
alter table match_sets enable row level security;
alter table bracket_versions enable row level security;

drop policy if exists bracket_versions_select_admin on bracket_versions;
create policy bracket_versions_select_admin on bracket_versions
for select
to authenticated
using (is_tournament_admin(tournament_id));

drop policy if exists bracket_versions_insert_admin on bracket_versions;
create policy bracket_versions_insert_admin on bracket_versions
for insert
to authenticated
with check (is_tournament_admin(tournament_id));

drop policy if exists tournaments_public_or_admin_select on tournaments;
create policy tournaments_public_or_admin_select on tournaments
for select
using (
  is_public = true or is_tournament_admin(id)
);

drop policy if exists tournaments_insert_authenticated on tournaments;
create policy tournaments_insert_authenticated on tournaments
for insert
to authenticated
with check (
  created_by = auth.uid()
);

drop policy if exists tournaments_update_admin on tournaments;
create policy tournaments_update_admin on tournaments
for update
to authenticated
using (is_tournament_admin(id))
with check (is_tournament_admin(id));

drop policy if exists tournaments_delete_admin on tournaments;
create policy tournaments_delete_admin on tournaments
for delete
to authenticated
using (is_tournament_admin(id));

drop policy if exists tournament_admins_select_admin on tournament_admins;
create policy tournament_admins_select_admin on tournament_admins
for select
to authenticated
using (is_tournament_admin(tournament_id));

drop policy if exists tournament_admins_insert_owner_or_admin on tournament_admins;
create policy tournament_admins_insert_owner_or_admin on tournament_admins
for insert
to authenticated
with check (
  (
    user_id = auth.uid()
    and exists (
      select 1
      from tournaments t
      where t.id = tournament_id
        and t.created_by = auth.uid()
    )
  )
  or is_tournament_admin(tournament_id)
);

drop policy if exists tournament_admins_delete_admin on tournament_admins;
create policy tournament_admins_delete_admin on tournament_admins
for delete
to authenticated
using (is_tournament_admin(tournament_id));

drop policy if exists entries_public_or_admin_select on entries;
create policy entries_public_or_admin_select on entries
for select
using (
  exists (
    select 1
    from tournaments t
    where t.id = entries.tournament_id
      and (t.is_public = true or is_tournament_admin(t.id))
  )
);

drop policy if exists entries_insert_admin on entries;
create policy entries_insert_admin on entries
for insert
to authenticated
with check (is_tournament_admin(tournament_id));

drop policy if exists entries_update_admin on entries;
create policy entries_update_admin on entries
for update
to authenticated
using (is_tournament_admin(tournament_id))
with check (is_tournament_admin(tournament_id));

drop policy if exists entries_delete_admin on entries;
create policy entries_delete_admin on entries
for delete
to authenticated
using (is_tournament_admin(tournament_id));

drop policy if exists entry_members_public_or_admin_select on entry_members;
create policy entry_members_public_or_admin_select on entry_members
for select
using (
  exists (
    select 1
    from entries e
    join tournaments t on t.id = e.tournament_id
    where e.id = entry_members.entry_id
      and (t.is_public = true or is_tournament_admin(t.id))
  )
);

drop policy if exists entry_members_insert_admin on entry_members;
create policy entry_members_insert_admin on entry_members
for insert
to authenticated
with check (
  exists (
    select 1
    from entries e
    where e.id = entry_members.entry_id
      and is_tournament_admin(e.tournament_id)
  )
);

drop policy if exists entry_members_update_admin on entry_members;
create policy entry_members_update_admin on entry_members
for update
to authenticated
using (
  exists (
    select 1
    from entries e
    where e.id = entry_members.entry_id
      and is_tournament_admin(e.tournament_id)
  )
)
with check (
  exists (
    select 1
    from entries e
    where e.id = entry_members.entry_id
      and is_tournament_admin(e.tournament_id)
  )
);

drop policy if exists entry_members_delete_admin on entry_members;
create policy entry_members_delete_admin on entry_members
for delete
to authenticated
using (
  exists (
    select 1
    from entries e
    where e.id = entry_members.entry_id
      and is_tournament_admin(e.tournament_id)
  )
);

drop policy if exists matches_public_or_admin_select on matches;
create policy matches_public_or_admin_select on matches
for select
using (
  exists (
    select 1
    from tournaments t
    where t.id = matches.tournament_id
      and (t.is_public = true or is_tournament_admin(t.id))
  )
);

drop policy if exists matches_insert_admin on matches;
create policy matches_insert_admin on matches
for insert
to authenticated
with check (is_tournament_admin(tournament_id));

drop policy if exists matches_update_admin on matches;
create policy matches_update_admin on matches
for update
to authenticated
using (is_tournament_admin(tournament_id))
with check (is_tournament_admin(tournament_id));

drop policy if exists matches_delete_admin on matches;
create policy matches_delete_admin on matches
for delete
to authenticated
using (is_tournament_admin(tournament_id));

drop policy if exists match_sets_public_or_admin_select on match_sets;
create policy match_sets_public_or_admin_select on match_sets
for select
using (
  exists (
    select 1
    from matches m
    join tournaments t on t.id = m.tournament_id
    where m.id = match_sets.match_id
      and (t.is_public = true or is_tournament_admin(t.id))
  )
);

drop policy if exists match_sets_insert_admin on match_sets;
create policy match_sets_insert_admin on match_sets
for insert
to authenticated
with check (
  exists (
    select 1
    from matches m
    where m.id = match_sets.match_id
      and is_tournament_admin(m.tournament_id)
  )
);

drop policy if exists match_sets_update_admin on match_sets;
create policy match_sets_update_admin on match_sets
for update
to authenticated
using (
  exists (
    select 1
    from matches m
    where m.id = match_sets.match_id
      and is_tournament_admin(m.tournament_id)
  )
)
with check (
  exists (
    select 1
    from matches m
    where m.id = match_sets.match_id
      and is_tournament_admin(m.tournament_id)
  )
);

drop policy if exists match_sets_delete_admin on match_sets;
create policy match_sets_delete_admin on match_sets
for delete
to authenticated
using (
  exists (
    select 1
    from matches m
    where m.id = match_sets.match_id
      and is_tournament_admin(m.tournament_id)
  )
);

grant execute on function create_tournament(text, text, text, sport, tournament_format, tournament_category, set_format, boolean, doubles_pairing_mode, jsonb, jsonb) to authenticated;
grant execute on function register_entry(text, tournament_category, text, text, text, text) to anon, authenticated;
grant execute on function normalize_contact(text) to authenticated;
grant execute on function hash_contact(text) to authenticated;
grant execute on function generate_bracket(uuid, draw_mode, uuid[]) to authenticated;
grant execute on function rebuild_bracket(uuid, draw_mode, uuid[]) to authenticated;
grant execute on function update_match_sets(uuid, jsonb) to authenticated;
grant execute on function swap_bracket_slots(uuid, uuid, text, uuid, text) to authenticated;
grant execute on function form_random_pairs(uuid) to authenticated;
grant execute on function form_manual_pairs(uuid, jsonb) to authenticated;
grant execute on function split_pairs(uuid) to authenticated;
grant execute on function apply_bracket_layout(uuid, jsonb) to authenticated;
grant execute on function add_tournament_admin_by_email(uuid, text, text) to authenticated;
grant execute on function remove_tournament_admin(uuid, uuid) to authenticated;
grant execute on function get_tournament_admins_with_email(uuid) to authenticated;

-- Idempotent: skip if table is already in supabase_realtime publication
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tournaments'
  ) then
    alter publication supabase_realtime add table tournaments;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'entries'
  ) then
    alter publication supabase_realtime add table entries;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches'
  ) then
    alter publication supabase_realtime add table matches;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'match_sets'
  ) then
    alter publication supabase_realtime add table match_sets;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tournament_admins'
  ) then
    alter publication supabase_realtime add table tournament_admins;
  end if;
end $$;

-- =============================================
-- PLATFORM ADMIN
-- =============================================

-- Platform super admins
create table if not exists platform_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade unique,
  created_at timestamptz not null default now()
);

-- Helper: check if current user is platform admin
create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from platform_admins where user_id = auth.uid()
  );
$$;

-- RLS: platform_admins
alter table platform_admins enable row level security;

do $$ begin
  drop policy if exists platform_admins_select_self on platform_admins;
end $$;

create policy platform_admins_select_self on platform_admins
  for select to authenticated using (user_id = auth.uid());

grant execute on function is_platform_admin() to authenticated;


-- =============================================
-- LIVE SCORING & COUNTER ROLE
-- =============================================


alter table tournament_admins drop constraint if exists tournament_admins_role_check;
alter table tournament_admins
  add constraint tournament_admins_role_check check (role in ('owner', 'editor', 'counter'));

create or replace function is_tournament_admin(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from tournament_admins ta
    where ta.tournament_id = p_tournament_id
      and ta.user_id = auth.uid()
      and ta.role in ('owner', 'editor')
  );
$$;

create or replace function can_live_score(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from tournament_admins ta
    where ta.tournament_id = p_tournament_id
      and ta.user_id = auth.uid()
      and ta.role in ('owner', 'editor', 'counter')
  );
$$;

create or replace function get_my_tournament_role(p_tournament_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select ta.role
  from tournament_admins ta
  where ta.tournament_id = p_tournament_id
    and ta.user_id = auth.uid()
  limit 1;
$$;

create table if not exists live_scores (
  id uuid primary key default gen_random_uuid()
);

alter table live_scores add column if not exists match_id uuid;
alter table live_scores add column if not exists tournament_id uuid;
alter table live_scores add column if not exists counter_user_id uuid references auth.users (id) on delete set null;
alter table live_scores add column if not exists status text default 'active';
alter table live_scores add column if not exists state jsonb;
alter table live_scores add column if not exists history jsonb default '[]'::jsonb;
alter table live_scores add column if not exists revision integer default 0;
alter table live_scores add column if not exists created_at timestamptz default now();
alter table live_scores add column if not exists updated_at timestamptz default now();

update live_scores ls
set tournament_id = m.tournament_id
from matches m
where ls.match_id = m.id
  and ls.tournament_id is null;

update live_scores
set status = 'active'
where status is null or status not in ('active', 'stopped', 'finished');

update live_scores
set history = '[]'::jsonb
where history is null;

update live_scores
set revision = 0
where revision is null;

update live_scores
set created_at = now()
where created_at is null;

update live_scores
set updated_at = now()
where updated_at is null;

update live_scores ls
set state = jsonb_build_object(
  'points', jsonb_build_object('a', 0, 'b', 0),
  'games', jsonb_build_object('a', 0, 'b', 0),
  'setsWon', jsonb_build_object('a', 0, 'b', 0),
  'sets', '[]'::jsonb,
  'currentSet', 1,
  'isTiebreak', false,
  'tiebreakPoints', jsonb_build_object('a', 0, 'b', 0),
  'requiredSets', case when t.set_format = 'best_of_5' then 3 else 2 end,
  'winner', null
)
from matches m
join tournaments t on t.id = m.tournament_id
where ls.match_id = m.id
  and ls.state is null;

update live_scores
set state = jsonb_build_object(
  'points', jsonb_build_object('a', 0, 'b', 0),
  'games', jsonb_build_object('a', 0, 'b', 0),
  'setsWon', jsonb_build_object('a', 0, 'b', 0),
  'sets', '[]'::jsonb,
  'currentSet', 1,
  'isTiebreak', false,
  'tiebreakPoints', jsonb_build_object('a', 0, 'b', 0),
  'requiredSets', 2,
  'winner', null
)
where state is null;

alter table live_scores alter column id set default gen_random_uuid();
update live_scores set id = gen_random_uuid() where id is null;
alter table live_scores alter column id set not null;
alter table live_scores alter column status set default 'active';
alter table live_scores alter column status set not null;
alter table live_scores alter column state set not null;
alter table live_scores alter column history set default '[]'::jsonb;
alter table live_scores alter column history set not null;
alter table live_scores alter column revision set default 0;
alter table live_scores alter column revision set not null;
alter table live_scores alter column created_at set default now();
alter table live_scores alter column created_at set not null;
alter table live_scores alter column updated_at set default now();
alter table live_scores alter column updated_at set not null;

alter table live_scores drop constraint if exists live_scores_status_check;
alter table live_scores
  add constraint live_scores_status_check check (status in ('active', 'stopped', 'finished'));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.live_scores'::regclass
      and contype = 'p'
  ) then
    alter table live_scores add constraint live_scores_pkey primary key (id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_scores'::regclass
      and conname = 'live_scores_match_id_fkey'
  ) then
    alter table live_scores
      add constraint live_scores_match_id_fkey
      foreign key (match_id) references matches(id) on delete cascade;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.live_scores'::regclass
      and conname = 'live_scores_tournament_id_fkey'
  ) then
    alter table live_scores
      add constraint live_scores_tournament_id_fkey
      foreign key (tournament_id) references tournaments(id) on delete cascade;
  end if;
end $$;

create index if not exists idx_live_scores_tournament on live_scores (tournament_id);
create index if not exists idx_live_scores_match on live_scores (match_id);
create unique index if not exists idx_live_scores_match_unique
  on live_scores (match_id)
  where match_id is not null;

drop trigger if exists trg_live_scores_updated_at on live_scores;
create trigger trg_live_scores_updated_at
before update on live_scores
for each row
execute function set_updated_at();

create or replace function live_score_initial_state(p_required_sets integer)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'points', jsonb_build_object('a', 0, 'b', 0),
    'games', jsonb_build_object('a', 0, 'b', 0),
    'setsWon', jsonb_build_object('a', 0, 'b', 0),
    'sets', '[]'::jsonb,
    'currentSet', 1,
    'isTiebreak', false,
    'tiebreakPoints', jsonb_build_object('a', 0, 'b', 0),
    'requiredSets', p_required_sets,
    'winner', null
  );
$$;

create or replace function tennis_apply_point(p_state jsonb, p_side text)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_side text := lower(trim(p_side));
  v_other text;
  v_points_a integer := coalesce((p_state #>> '{points,a}')::integer, 0);
  v_points_b integer := coalesce((p_state #>> '{points,b}')::integer, 0);
  v_games_a integer := coalesce((p_state #>> '{games,a}')::integer, 0);
  v_games_b integer := coalesce((p_state #>> '{games,b}')::integer, 0);
  v_sets_a integer := coalesce((p_state #>> '{setsWon,a}')::integer, 0);
  v_sets_b integer := coalesce((p_state #>> '{setsWon,b}')::integer, 0);
  v_tb_a integer := coalesce((p_state #>> '{tiebreakPoints,a}')::integer, 0);
  v_tb_b integer := coalesce((p_state #>> '{tiebreakPoints,b}')::integer, 0);
  v_required_sets integer := coalesce((p_state->>'requiredSets')::integer, 2);
  v_current_set integer := coalesce((p_state->>'currentSet')::integer, 1);
  v_is_tiebreak boolean := coalesce((p_state->>'isTiebreak')::boolean, false);
  v_winner text := nullif(p_state->>'winner', '');
  v_sets jsonb := coalesce(p_state->'sets', '[]'::jsonb);
  v_side_points integer;
  v_other_points integer;
  v_set_winner text := null;
begin
  if v_side not in ('a', 'b') then
    raise exception 'Invalid side';
  end if;

  if v_winner in ('a', 'b') then
    return p_state;
  end if;

  v_other := case when v_side = 'a' then 'b' else 'a' end;

  if v_is_tiebreak then
    if v_side = 'a' then
      v_tb_a := v_tb_a + 1;
      if v_tb_a >= 7 and v_tb_a - v_tb_b >= 2 then
        v_games_a := v_games_a + 1;
        v_set_winner := 'a';
      end if;
    else
      v_tb_b := v_tb_b + 1;
      if v_tb_b >= 7 and v_tb_b - v_tb_a >= 2 then
        v_games_b := v_games_b + 1;
        v_set_winner := 'b';
      end if;
    end if;
  else
    if v_side = 'a' then
      v_points_a := v_points_a + 1;
    else
      v_points_b := v_points_b + 1;
    end if;

    v_side_points := case when v_side = 'a' then v_points_a else v_points_b end;
    v_other_points := case when v_other = 'a' then v_points_a else v_points_b end;

    if v_side_points >= 4 and v_side_points - v_other_points >= 2 then
      if v_side = 'a' then
        v_games_a := v_games_a + 1;
      else
        v_games_b := v_games_b + 1;
      end if;
      v_points_a := 0;
      v_points_b := 0;

      if v_games_a = 6 and v_games_b = 6 then
        v_is_tiebreak := true;
      elsif (v_games_a >= 6 or v_games_b >= 6) and abs(v_games_a - v_games_b) >= 2 then
        v_set_winner := case when v_games_a > v_games_b then 'a' else 'b' end;
      end if;
    end if;
  end if;

  if v_set_winner in ('a', 'b') then
    v_sets := v_sets || jsonb_build_array(jsonb_build_object(
      'set_index', v_current_set,
      'side_a_games', v_games_a,
      'side_b_games', v_games_b
    ));

    if v_set_winner = 'a' then
      v_sets_a := v_sets_a + 1;
      if v_sets_a >= v_required_sets then
        v_winner := 'a';
      end if;
    else
      v_sets_b := v_sets_b + 1;
      if v_sets_b >= v_required_sets then
        v_winner := 'b';
      end if;
    end if;

    v_points_a := 0;
    v_points_b := 0;
    v_tb_a := 0;
    v_tb_b := 0;
    v_is_tiebreak := false;

    if v_winner is null then
      v_current_set := v_current_set + 1;
      v_games_a := 0;
      v_games_b := 0;
    end if;
  end if;

  return jsonb_build_object(
    'points', jsonb_build_object('a', v_points_a, 'b', v_points_b),
    'games', jsonb_build_object('a', v_games_a, 'b', v_games_b),
    'setsWon', jsonb_build_object('a', v_sets_a, 'b', v_sets_b),
    'sets', v_sets,
    'currentSet', v_current_set,
    'isTiebreak', v_is_tiebreak,
    'tiebreakPoints', jsonb_build_object('a', v_tb_a, 'b', v_tb_b),
    'requiredSets', v_required_sets,
    'winner', v_winner
  );
end;
$$;

drop function if exists start_live_match(uuid);
drop function if exists record_point(uuid, text);
drop function if exists record_point(uuid, text, integer);
drop function if exists stop_live_match(uuid);

create or replace function start_live_match(p_match_id uuid)
returns live_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match matches%rowtype;
  v_set_format set_format;
  v_tournament_status tournament_status;
  v_required_sets integer;
  v_live live_scores%rowtype;
begin
  select *
    into v_match
  from matches
  where id = p_match_id;

  if v_match.id is null then
    raise exception 'Match not found';
  end if;

  select t.set_format, t.status
    into v_set_format, v_tournament_status
  from tournaments t
  where t.id = v_match.tournament_id;

  if not can_live_score(v_match.tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Live scoring can start only after the tournament starts';
  end if;

  if v_match.side_a_entry_id is null or v_match.side_b_entry_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;

  if v_match.status = 'finished'::match_status then
    raise exception 'Match already finished';
  end if;

  v_required_sets := case when v_set_format = 'best_of_5' then 3 else 2 end;

  select * into v_live
  from live_scores
  where match_id = p_match_id;

  if v_live.id is null then
    insert into live_scores (match_id, tournament_id, counter_user_id, status, state)
    values (p_match_id, v_match.tournament_id, auth.uid(), 'active', live_score_initial_state(v_required_sets))
    returning * into v_live;
  elsif v_live.status <> 'finished' then
    update live_scores
    set status = 'active',
        counter_user_id = coalesce(counter_user_id, auth.uid())
    where id = v_live.id
    returning * into v_live;
  end if;

  return v_live;
end;
$$;

create or replace function record_point(
  p_match_id uuid,
  p_side text,
  p_expected_revision integer default null
)
returns live_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live live_scores%rowtype;
  v_match matches%rowtype;
  v_tournament_status tournament_status;
  v_history_len integer;
  v_new_state jsonb;
  v_new_history jsonb;
  v_winner_side text;
  v_winner_id uuid;
  v_previous_winner uuid;
  v_set jsonb;
begin
  select *
    into v_match
  from matches
  where id = p_match_id;

  if v_match.id is null then
    raise exception 'Match not found';
  end if;

  select t.status
    into v_tournament_status
  from tournaments t
  where t.id = v_match.tournament_id;

  if not can_live_score(v_match.tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Live scoring is available only while the tournament is in progress';
  end if;

  select * into v_live
  from live_scores
  where match_id = p_match_id
  for update;

  if v_live.id is null then
    v_live := start_live_match(p_match_id);
    select * into v_live
    from live_scores
    where match_id = p_match_id
    for update;
  end if;

  if p_expected_revision is not null and v_live.revision <> p_expected_revision then
    raise exception 'Live score changed. Refresh and try again.';
  end if;

  if lower(trim(p_side)) = 'undo' then
    if v_live.status = 'finished' then
      raise exception 'Cannot undo a finished live match';
    end if;

    v_history_len := jsonb_array_length(v_live.history);
    if v_history_len = 0 then
      raise exception 'Nothing to undo';
    end if;

    update live_scores
    set state = v_live.history -> (v_history_len - 1),
        history = v_live.history - (v_history_len - 1),
        status = 'active',
        revision = revision + 1
    where id = v_live.id
    returning * into v_live;

    return v_live;
  end if;

  if v_live.status = 'finished' then
    raise exception 'Match already finished';
  end if;

  v_new_history := v_live.history || jsonb_build_array(v_live.state);
  v_new_state := tennis_apply_point(v_live.state, p_side);
  v_winner_side := v_new_state->>'winner';

  update live_scores
  set state = v_new_state,
      history = v_new_history,
      status = case when v_winner_side in ('a', 'b') then 'finished' else 'active' end,
      revision = revision + 1
  where id = v_live.id
  returning * into v_live;

  if v_winner_side in ('a', 'b') then
    v_previous_winner := v_match.winner_entry_id;
    v_winner_id := case
      when v_winner_side = 'a' then v_match.side_a_entry_id
      else v_match.side_b_entry_id
    end;

    delete from match_sets where match_id = p_match_id;

    for v_set in
      select value
      from jsonb_array_elements(v_new_state->'sets')
    loop
      insert into match_sets (match_id, set_index, side_a_games, side_b_games)
      values (
        p_match_id,
        (v_set->>'set_index')::integer,
        (v_set->>'side_a_games')::integer,
        (v_set->>'side_b_games')::integer
      );
    end loop;

    update matches
    set winner_entry_id = v_winner_id,
        status = 'finished'::match_status
    where id = p_match_id;

    if v_previous_winner is not null and v_previous_winner is distinct from v_winner_id then
      perform clear_downstream(p_match_id, v_previous_winner);
    end if;

    perform propagate_winner(p_match_id, v_winner_id);
  end if;

  return v_live;
end;
$$;

create or replace function stop_live_match(p_match_id uuid)
returns live_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live live_scores%rowtype;
  v_tournament_id uuid;
begin
  select m.tournament_id into v_tournament_id
  from matches m
  where m.id = p_match_id;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not can_live_score(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  select * into v_live
  from live_scores
  where match_id = p_match_id;

  if v_live.id is null then
    raise exception 'Live match not found';
  end if;

  if v_live.status <> 'finished' then
    update live_scores
    set status = 'stopped',
        revision = revision + 1
    where id = v_live.id
    returning * into v_live;
  end if;

  return v_live;
end;
$$;

alter table live_scores enable row level security;

drop policy if exists live_scores_public_or_scorer_select on live_scores;
create policy live_scores_public_or_scorer_select on live_scores
for select
using (
  exists (
    select 1
    from tournaments t
    where t.id = live_scores.tournament_id
      and (t.is_public = true or can_live_score(t.id))
  )
);

drop policy if exists tournaments_public_or_admin_select on tournaments;
create policy tournaments_public_or_admin_select on tournaments
for select
using (
  is_public = true or is_tournament_admin(id) or can_live_score(id)
);

drop policy if exists entries_public_or_admin_select on entries;
create policy entries_public_or_admin_select on entries
for select
using (
  exists (
    select 1
    from tournaments t
    where t.id = entries.tournament_id
      and (t.is_public = true or is_tournament_admin(t.id) or can_live_score(t.id))
  )
);

drop policy if exists entry_members_public_or_admin_select on entry_members;
create policy entry_members_public_or_admin_select on entry_members
for select
using (
  exists (
    select 1
    from entries e
    join tournaments t on t.id = e.tournament_id
    where e.id = entry_members.entry_id
      and (t.is_public = true or is_tournament_admin(t.id) or can_live_score(t.id))
  )
);

drop policy if exists matches_public_or_admin_select on matches;
create policy matches_public_or_admin_select on matches
for select
using (
  exists (
    select 1
    from tournaments t
    where t.id = matches.tournament_id
      and (t.is_public = true or is_tournament_admin(t.id) or can_live_score(t.id))
  )
);

drop policy if exists match_sets_public_or_admin_select on match_sets;
create policy match_sets_public_or_admin_select on match_sets
for select
using (
  exists (
    select 1
    from matches m
    join tournaments t on t.id = m.tournament_id
    where m.id = match_sets.match_id
      and (t.is_public = true or is_tournament_admin(t.id) or can_live_score(t.id))
  )
);

grant select on live_scores to anon, authenticated;
grant execute on function can_live_score(uuid) to authenticated;
grant execute on function get_my_tournament_role(uuid) to authenticated;
grant execute on function start_live_match(uuid) to authenticated;
grant execute on function record_point(uuid, text, integer) to authenticated;
grant execute on function stop_live_match(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_scores'
  ) then
    alter publication supabase_realtime add table live_scores;
  end if;
end $$;

-- =============================================
-- COUNTER TOURNAMENT LIST ACCESS
-- =============================================

drop policy if exists tournament_admins_select_admin on tournament_admins;
create policy tournament_admins_select_admin on tournament_admins
for select
to authenticated
using (
  user_id = auth.uid()
  or is_tournament_admin(tournament_id)
);

-- =============================================
-- GROUPS RLS (round_robin / groups_playoff)
-- =============================================

alter table groups enable row level security;
alter table group_entries enable row level security;

drop policy if exists groups_public_or_admin_select on groups;
create policy groups_public_or_admin_select on groups
for select
using (
  exists (
    select 1 from tournaments t
    where t.id = groups.tournament_id
      and (t.is_public = true or is_tournament_admin(t.id) or can_live_score(t.id))
  )
);

drop policy if exists groups_write_admin on groups;
create policy groups_write_admin on groups
for all
using (is_tournament_admin(tournament_id))
with check (is_tournament_admin(tournament_id));

drop policy if exists group_entries_public_or_admin_select on group_entries;
create policy group_entries_public_or_admin_select on group_entries
for select
using (
  exists (
    select 1 from groups g
    join tournaments t on t.id = g.tournament_id
    where g.id = group_entries.group_id
      and (t.is_public = true or is_tournament_admin(t.id) or can_live_score(t.id))
  )
);

drop policy if exists group_entries_write_admin on group_entries;
create policy group_entries_write_admin on group_entries
for all
using (
  exists (select 1 from groups g where g.id = group_entries.group_id and is_tournament_admin(g.tournament_id))
)
with check (
  exists (select 1 from groups g where g.id = group_entries.group_id and is_tournament_admin(g.tournament_id))
);
