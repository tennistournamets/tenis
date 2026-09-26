create extension if not exists pgcrypto;

-- Enum guards support schema assembly; update existing databases with versioned migrations.
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
  create type registration_status as enum ('pending', 'approved', 'rejected', 'waitlisted');
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
  contact_phone text,
  contact_email text,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tournaments add column if not exists contact_phone text;
alter table tournaments add column if not exists contact_email text;

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

alter table public.matches add column if not exists score_revision integer not null default 0;

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
  v_tournament_id uuid;
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

  select tournament_id, next_match_id, next_slot, loser_next_match_id, loser_next_slot,
         side_a_entry_id, side_b_entry_id
    into v_tournament_id, v_next_match_id, v_next_slot, v_loser_next_id, v_loser_next_slot,
         v_match_side_a, v_match_side_b
  from matches
  where id = p_match_id
  for update;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;
  -- Defend against old or privileged writes containing invalid graph links.
  if not exists (select 1 from entries where id = p_winner_id and tournament_id = v_tournament_id)
     or (p_winner_id is distinct from v_match_side_a and p_winner_id is distinct from v_match_side_b)
     or exists (
       select 1 from entries e
       where e.id in (v_match_side_a, v_match_side_b) and e.tournament_id <> v_tournament_id
     ) then
    raise exception 'Winner or participant does not belong to this tournament match';
  end if;
  if v_next_match_id is not null and not exists (
    select 1 from matches where id = v_next_match_id and tournament_id = v_tournament_id
  ) then
    raise exception 'Next match does not belong to this tournament';
  end if;
  if v_loser_next_id is not null and not exists (
    select 1 from matches where id = v_loser_next_id and tournament_id = v_tournament_id
  ) then
    raise exception 'Loser next match does not belong to this tournament';
  end if;

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
  v_tournament_id uuid;
  v_next_match_id uuid;
  v_next_slot text;
  v_next_winner uuid;
begin
  if p_stale_winner is null then
    return;
  end if;

  select tournament_id, next_match_id, next_slot
    into v_tournament_id, v_next_match_id, v_next_slot
  from matches
  where id = p_match_id
  for update;

  if v_next_match_id is null then
    return;
  end if;

  if not exists (
    select 1 from matches where id = v_next_match_id and tournament_id = v_tournament_id
  ) then
    raise exception 'Next match does not belong to this tournament';
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

drop function if exists create_tournament(
  text,
  text,
  text,
  sport,
  tournament_format,
  tournament_category,
  set_format,
  boolean,
  doubles_pairing_mode,
  jsonb,
  jsonb
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
  p_scoring_config jsonb default '{}'::jsonb,
  p_contact_phone text default null,
  p_contact_email text default null
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

  -- Sport must be enabled via feature flag (see FEATURE FLAGS section)
  if not is_feature_enabled('sport.' || p_sport::text) then
    raise exception 'Sport is disabled: %', p_sport using errcode = 'P0403';
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
    is_public, doubles_pairing_mode, format_config, scoring_config,
    contact_phone, contact_email, created_by
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
    nullif(btrim(coalesce(p_contact_phone, '')), ''),
    nullif(btrim(coalesce(p_contact_email, '')), ''),
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
  v_seed_index integer := 1;
  v_byes integer;
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

  if p_mode is null then
    raise exception 'Draw mode is required';
  end if;
  if p_manual_order is not null then
    if coalesce(array_ndims(p_manual_order), 1) <> 1
       or exists (select 1 from unnest(p_manual_order) x(id) where x.id is null or not (x.id = any(v_entry_ids)))
       or (select count(*) <> count(distinct id) from unnest(p_manual_order) x(id)) then
      raise exception 'Manual order must contain unique approved entries from this tournament';
    end if;
  end if;

  if p_mode = 'manual' then
    -- The UI sends NULL to create the initial manually editable bracket.
    -- Keep any supplied seed order; append omitted approved entries.
    select coalesce(array_agg(x.id order by x.position), '{}') into v_ordered_ids
    from unnest(p_manual_order) with ordinality x(id, position);

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
  v_byes := v_bracket_size - v_count;
  for v_match in 1..v_matches_in_round loop
    -- Give every first-round match a participant, spreading the BYEs evenly
    -- across sibling sections. Integer division decides which matches get a
    -- free pass; flattening the non-null slots preserves the supplied order.
    v_side_a := v_ordered_ids[v_seed_index];
    v_seed_index := v_seed_index + 1;
    v_side_b := null;
    if (v_match * v_byes) / v_matches_in_round
       = ((v_match - 1) * v_byes) / v_matches_in_round then
      v_side_b := v_ordered_ids[v_seed_index];
      v_seed_index := v_seed_index + 1;
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
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

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

  if p_group_id is not null and not exists (
    select 1 from groups where id = p_group_id and tournament_id = p_tournament_id
  ) then
    raise exception 'Group does not belong to this tournament';
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
  p_b_pens integer default null,
  p_expected_revision integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status tournament_status;
  v_sport sport;
  v_format tournament_format;
  v_stage match_stage;
  v_side_a uuid;
  v_side_b uuid;
  v_prev_winner uuid;
  v_new_winner uuid;
  v_draw_allowed boolean;
begin
  select m.tournament_id, t.status, t.sport, t.format, m.stage,
         m.side_a_entry_id, m.side_b_entry_id, m.winner_entry_id
    into v_tournament_id, v_status, v_sport, v_format, v_stage,
         v_side_a, v_side_b, v_prev_winner
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id for update of m;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;
  if not is_tournament_admin(v_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if v_sport <> 'football' then
    raise exception 'Goal scores are supported only for football';
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

  if p_expected_revision is null or p_expected_revision<>(select score_revision from matches where id=p_match_id) then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
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

  if v_prev_winner is not null and v_prev_winner is distinct from v_new_winner then
    perform assert_score_correction_safe(p_match_id);
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

  if v_new_winner is not null and v_new_winner is distinct from v_prev_winner then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  return v_new_winner;
end;
$$;

grant execute on function update_football_result(uuid, integer, integer, integer, integer, integer) to authenticated;

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
  v_seed_index integer := 1;
  v_byes integer;
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
  v_byes := v_bracket_size - v_count;
  for v_match in 1..v_matches_in_round loop
    -- Give every first-round match a participant, spreading the BYEs evenly
    -- across sibling sections. Integer division decides which matches get a
    -- free pass; flattening the non-null slots preserves the supplied order.
    v_side_a := p_seeds[v_seed_index];
    v_seed_index := v_seed_index + 1;
    v_side_b := null;
    if (v_match * v_byes) / v_matches_in_round
       = ((v_match - 1) * v_byes) / v_matches_in_round then
      v_side_b := p_seeds[v_seed_index];
      v_seed_index := v_seed_index + 1;
    end if;

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
  else
    -- Two players have no losers-bracket round: the WB loser goes directly
    -- to the grand final, opposite the WB winner routed to slot A above.
    select id into v_id from tmp_de where br = 'W' and rnd = 1 and mno = 1;
    select id into v_nid from tmp_de where br = 'GF';
    update matches set loser_next_match_id = v_nid, loser_next_slot = 'B' where id = v_id;
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
  v_seen uuid[] := '{}';
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

  if jsonb_typeof(p_pairs) is distinct from 'array' then
    raise exception 'Pairs must be an array';
  end if;

  -- Validate the entire batch before merging/deleting any entry.
  for v_pair in select * from jsonb_array_elements(p_pairs)
  loop
    if jsonb_typeof(v_pair) is distinct from 'array' then
      raise exception 'Each pair must contain two entry IDs';
    end if;
    if jsonb_array_length(v_pair) <> 2 then
      raise exception 'Each pair must contain two entry IDs';
    end if;
    v_entry_a := (v_pair->>0)::uuid;
    v_entry_b := (v_pair->>1)::uuid;
    if v_entry_a is null or v_entry_b is null or v_entry_a = v_entry_b
       or v_entry_a = any(v_seen) or v_entry_b = any(v_seen) then
      raise exception 'Pairs must contain distinct non-null entries without reuse';
    end if;
    if (select count(*) from entries e
        where e.id in (v_entry_a, v_entry_b) and e.tournament_id = p_tournament_id
          and e.status = 'approved' and e.entry_type = 'doubles'
          and exists (select 1 from entry_members em where em.entry_id = e.id and em.member_order = 1)
          and not exists (select 1 from entry_members em where em.entry_id = e.id and em.member_order = 2)
       ) <> 2 then
      raise exception 'Pairs require approved unpaired entries from this tournament';
    end if;
    v_seen := v_seen || array[v_entry_a, v_entry_b];
  end loop;

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

alter table public.match_sets
  add column if not exists score_kind text not null default 'set',
  add column if not exists side_a_tiebreak integer,
  add column if not exists side_b_tiebreak integer;
alter table public.match_sets drop constraint if exists match_sets_side_a_games_check;
alter table public.match_sets drop constraint if exists match_sets_side_b_games_check;
alter table public.match_sets add constraint match_sets_side_a_games_check check(side_a_games>=0);
alter table public.match_sets add constraint match_sets_side_b_games_check check(side_b_games>=0);
alter table public.match_sets drop constraint if exists match_sets_tiebreak_check;
alter table public.match_sets add constraint match_sets_tiebreak_check check(
  score_kind in ('set','match_tiebreak') and
  ((side_a_tiebreak is null and side_b_tiebreak is null) or
   (side_a_tiebreak is not null and side_b_tiebreak is not null and side_a_tiebreak>=0 and side_b_tiebreak>=0)) and
  (score_kind<>'match_tiebreak' or (side_a_games=0 and side_b_games=0 and side_a_tiebreak is not null))
);

-- Rules are internal helpers; API writers retain their existing authorization.
create or replace function tennis_scoring_rules(p_config jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  r jsonb := coalesce(p_config->'tennis', '{}'::jsonb);
  k text;
  legacy integer := 7;
begin
  if jsonb_typeof(coalesce(p_config,'{}'::jsonb)) <> 'object' or jsonb_typeof(r) <> 'object' then
    raise exception using errcode='22023', message='Invalid tennis scoring configuration';
  end if;
  if not (coalesce(p_config,'{}'::jsonb) ? 'tennis') then
    if p_config ? 'tiebreak_to' then
      if jsonb_typeof(p_config->'tiebreak_to') <> 'number' or p_config->>'tiebreak_to' not in ('7','10') then
        raise exception using errcode='22023', message='Invalid tiebreak target';
      end if;
      legacy := (p_config->>'tiebreak_to')::integer;
    end if;
  end if;
  for k in select jsonb_object_keys(r) loop
    if k not in ('game_rule','set_rule','short_tiebreak_at','short_tiebreak_to','final_set_rule','changeover') then
      raise exception using errcode='22023', message='Unknown tennis scoring setting: '||k;
    end if;
    if r->k = 'null'::jsonb then
      raise exception using errcode='22023', message='Tennis scoring settings cannot be null';
    end if;
  end loop;
  r := jsonb_build_object('game_rule','advantage','set_rule','standard','short_tiebreak_at',4,
    'short_tiebreak_to',7,'final_set_rule','same','changeover','every_six') || r;
  if r->>'game_rule' not in ('advantage','no_ad')
     or r->>'set_rule' not in ('standard','advantage','short')
     or r->>'final_set_rule' not in ('same','standard','advantage','tiebreak_10','match_tiebreak_7','match_tiebreak_10')
     or r->>'changeover' not in ('every_six','one_then_four')
     or jsonb_typeof(r->'short_tiebreak_at') <> 'number' or r->>'short_tiebreak_at' not in ('3','4')
     or jsonb_typeof(r->'short_tiebreak_to') <> 'number' or r->>'short_tiebreak_to' not in ('5','7') then
    raise exception using errcode='22023', message='Invalid tennis scoring setting';
  end if;
  return r || jsonb_build_object('tiebreak_to',legacy);
end;
$$;

create or replace function tennis_set_rule(p_rules jsonb, p_index integer, p_required integer)
returns jsonb language plpgsql immutable set search_path=public as $$
declare
  kind text := p_rules->>'set_rule';
  final_rule text := p_rules->>'final_set_rule';
  target integer := coalesce((p_rules->>'tiebreak_to')::integer,7);
  at_game integer := 6;
  games_to integer := 6;
  margin integer := 2;
begin
  if p_index = 2*p_required-1 and final_rule <> 'same' then
    if final_rule in ('match_tiebreak_7','match_tiebreak_10') then
      return jsonb_build_object('kind','match_tiebreak','games_to',0,'at',0,
        'target',case when final_rule='match_tiebreak_7' then 7 else 10 end,'margin',2);
    end if;
    kind := case when final_rule='tiebreak_10' then 'standard' else final_rule end;
    target := case when final_rule='tiebreak_10' then 10 else 7 end;
  end if;
  if kind='short' then
    games_to:=4;
    at_game:=(p_rules->>'short_tiebreak_at')::integer;
    target:=(p_rules->>'short_tiebreak_to')::integer;
    margin:=case when target=5 then 1 else 2 end;
  elsif kind='advantage' then
    at_game:=null;
  end if;
  return jsonb_build_object('kind','set','games_to',games_to,'at',at_game,'target',target,'margin',margin);
end;
$$;

-- -1 = impossible, 0 = reachable unfinished, 1/2 = completed A/B.
-- The result must stop at the first winning point, including sudden death.
create or replace function tennis_race_result(a integer,b integer,target integer,margin integer)
returns integer language sql immutable set search_path=public as $$
  select case
    when a is null or b is null or a<0 or b<0 then -1
    when greatest(a,b)<target or abs(a::bigint-b)<margin then
      case when margin=1 and greatest(a,b)>=target then -1 else 0 end
    when (greatest(a,b)=target and least(a,b)<=target-margin)
      or (margin=2 and greatest(a,b)>target and abs(a::bigint-b)=2)
      then case when a>b then 1 else 2 end
    else -1 end;
$$;

create or replace function tennis_set_result(p_set jsonb,p_rule jsonb)
returns integer language plpgsql immutable set search_path=public as $$
declare
  a integer := (p_set->>'side_a_games')::numeric::integer;
  b integer := (p_set->>'side_b_games')::numeric::integer;
  ta integer := (p_set->>'side_a_tiebreak')::numeric::integer;
  tb integer := (p_set->>'side_b_tiebreak')::numeric::integer;
  at_game integer := (p_rule->>'at')::integer;
  target integer := (p_rule->>'target')::integer;
  margin integer := (p_rule->>'margin')::integer;
  result integer;
  tb_result integer;
begin
  if a is null or b is null or a<0 or b<0 then return -1; end if;
  if p_set ? 'score_kind' and p_set->>'score_kind' is distinct from p_rule->>'kind' then return -1; end if;
  if (ta is null) <> (tb is null) then return -1; end if;
  if p_rule->>'kind'='match_tiebreak' then
    if a<>0 or b<>0 or ta is null then return -1; end if;
    return tennis_race_result(ta,tb,target,margin);
  end if;
  if at_game is not null and greatest(a,b)=at_game+1 and least(a,b)=at_game then
    result:=case when a>b then 1 else 2 end;
  elsif at_game is not null and greatest(a,b)>at_game+1 then
    return -1;
  else
    result:=tennis_race_result(a,b,(p_rule->>'games_to')::integer,2);
    -- At 3:3 short sets go directly to a tiebreak, so 4:2 remains legal,
    -- but 5:3 is unreachable. With a 4:4 tiebreak, 5:3 is legal.
    if at_game is not null and greatest(a,b)>at_game and result=0 then return -1; end if;
    if at_game is not null and least(a,b)>=at_game and result<>0 then return -1; end if;
  end if;
  if ta is not null then
    if at_game is null then return -1; end if;
    tb_result:=tennis_race_result(ta,tb,target,margin);
    if a=at_game and b=at_game then
      if tb_result<>0 then return -1; end if;
    elsif greatest(a,b)=at_game+1 and least(a,b)=at_game then
      if tb_result<>result then return -1; end if;
    else return -1;
    end if;
  end if;
  return result;
end;
$$;

create or replace function guard_tennis_scoring_settings()
returns trigger language plpgsql security definer set search_path=public as $$
declare changed boolean; new_rules jsonb; old_rules jsonb;
begin
  -- A sport change must not bypass the rule lock by temporarily switching
  -- to football, whose scoring settings are outside this tennis validator.
  if TG_OP='UPDATE' and new.sport is distinct from old.sport then
    if old.status in ('in_progress','completed') or new.status in ('in_progress','completed')
      or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=old.id)
      or exists(select 1 from live_scores where tournament_id=old.id) then
      raise exception using errcode='22023', message='Scoring rules are locked after the tournament starts or scores exist';
    end if;
  end if;
  if new.sport not in ('tennis','padel') then return new; end if;
  if new.sport='padel' and new.scoring_config ? 'tennis' then
    raise exception using errcode='22023', message='ITF tennis settings apply only to tennis';
  end if;
  new_rules:=tennis_scoring_rules(new.scoring_config);
  if TG_OP='UPDATE' then
    old_rules:=tennis_scoring_rules(old.scoring_config);
    changed := new_rules is distinct from old_rules or new.set_format is distinct from old.set_format;
    if changed and (old.status in ('in_progress','completed') or new.status in ('in_progress','completed')
      or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=old.id)
      or exists(select 1 from live_scores where tournament_id=old.id)) then
      raise exception using errcode='22023', message='Scoring rules are locked after the tournament starts or scores exist';
    end if;
  end if;
  return new;
end;
$$;

create or replace function tennis_live_state(p_match_id uuid,p_rules jsonb,p_required integer)
returns jsonb language plpgsql stable set search_path=public as $$
declare
  s jsonb; rule jsonb; result integer; n integer:=1; a integer:=0; b integer:=0;
  completed jsonb:='[]'; games jsonb:='{"a":0,"b":0}'; tb jsonb:='{"a":0,"b":0}';
  winner text; is_tb boolean:=false;
begin
  for s in select to_jsonb(ms) - 'id' - 'match_id' - 'created_at' - 'updated_at'
    from match_sets ms where match_id=p_match_id order by set_index loop
    n:=(s->>'set_index')::integer;
    rule:=tennis_set_rule(p_rules,n,p_required);
    result:=tennis_set_result(s,rule);
    if result=-1 then raise exception 'Stored score does not match the tournament rules'; end if;
    games:=jsonb_build_object('a',(s->>'side_a_games')::integer,'b',(s->>'side_b_games')::integer);
    tb:=jsonb_build_object('a',coalesce((s->>'side_a_tiebreak')::integer,0),'b',coalesce((s->>'side_b_tiebreak')::integer,0));
    if result=0 then exit; end if;
    completed:=completed||jsonb_build_array(s);
    a:=a+case when result=1 then 1 else 0 end;
    b:=b+case when result=2 then 1 else 0 end;
    if a=p_required or b=p_required then winner:=case when a>b then 'a' else 'b' end; exit; end if;
    n:=n+1; games:='{"a":0,"b":0}'; tb:='{"a":0,"b":0}';
  end loop;
  rule:=tennis_set_rule(p_rules,n,p_required);
  is_tb:=winner is null and (rule->>'kind'='match_tiebreak' or
    ((games->>'a')::integer=(rule->>'at')::integer and (games->>'b')::integer=(rule->>'at')::integer));
  return jsonb_build_object('points',jsonb_build_object('a',0,'b',0),'games',games,'setsWon',jsonb_build_object('a',a,'b',b),
    'sets',completed,'currentSet',n,'isTiebreak',coalesce(is_tb,false),'isMatchTiebreak',rule->>'kind'='match_tiebreak',
    'tiebreakPoints',tb,'requiredSets',p_required,'tiebreakTo',(rule->>'target')::integer,
    'tiebreakMargin',(rule->>'margin')::integer,'rules',p_rules,'winner',winner);
end;
$$;

create or replace function update_match_sets(
  p_match_id uuid,
  p_sets jsonb,
  p_expected_revision integer default null
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
  v_sport sport;
  v_rules jsonb;
  v_rule jsonb;
  v_result integer;
  v_max_sets integer;
  v_set_count integer;
  v_expected_index integer := 1;
  v_field text;
  v_number numeric;
  v_complete boolean;
  v_required_wins integer;
  v_side_a_id uuid;
  v_side_b_id uuid;
  v_previous_winner uuid;
  v_new_winner uuid;
  v_a_wins integer := 0;
  v_b_wins integer := 0;
  v_item jsonb;
  v_revision integer;
  v_set_index integer;
  v_a_games integer;
  v_b_games integer;
begin
  select m.tournament_id,
         m.side_a_entry_id,
         m.side_b_entry_id,
         m.winner_entry_id,
         t.set_format,
         tennis_scoring_rules(t.scoring_config),
         t.sport,
         t.status
    into v_tournament_id,
         v_side_a_id,
         v_side_b_id,
         v_previous_winner,
         v_set_format,
         v_rules,
         v_sport,
         v_tournament_status
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id
  for update of m;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not is_tournament_admin(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_sport not in ('tennis', 'padel') then
    raise exception 'Set scores are supported only for tennis and padel';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Scores can be entered only after the tournament starts';
  end if;

  if v_side_a_id is null or v_side_b_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;

  select score_revision into v_revision from matches where id=p_match_id;
  if exists(select 1 from live_scores where match_id=p_match_id and status='active') then
    raise exception using errcode='P0001',message='scoringFlow.liveBlocked';
  end if;
  if p_expected_revision is null or p_expected_revision<>v_revision then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
  end if;

  v_required_wins := case
    when v_set_format = 'best_of_5' then 3
    else 2
  end;

  v_max_sets := 2 * v_required_wins - 1;

  -- Validate the entire replacement before deleting sets or changing the graph.
  -- [] is an explicit reset; SQL/JSON null and incomplete fields are errors.
  if jsonb_typeof(p_sets) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Sets must be a JSON array';
  end if;
  v_set_count := jsonb_array_length(p_sets);
  if v_set_count > v_max_sets then
    raise exception using errcode = '22023', message = 'Too many sets for this match format';
  end if;

  for v_item in select value from jsonb_array_elements(p_sets) loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Each set must be an object with an index and both game scores';
    end if;
    foreach v_field in array array['set_index', 'side_a_games', 'side_b_games'] loop
      if jsonb_typeof(v_item->v_field) is distinct from 'number' then
        raise exception using errcode = '22023', message = 'Set index and game scores must be non-null JSON numbers';
      end if;
      v_number := (v_item->>v_field)::numeric;
      if v_number <> trunc(v_number)
         or v_number < (case when v_field = 'set_index' then 1 else 0 end)
         or v_number > (case when v_field = 'set_index' then v_max_sets else 2147483647 end) then
        raise exception using errcode = '22023', message = 'Set index or game score is outside the allowed integer range';
      end if;
    end loop;
    foreach v_field in array array['side_a_tiebreak','side_b_tiebreak'] loop
      if v_item ? v_field and v_item->v_field <> 'null'::jsonb then
        if jsonb_typeof(v_item->v_field) is distinct from 'number' then
          raise exception using errcode='22023',message='Tiebreak scores must be JSON integers';
        end if;
        v_number:=(v_item->>v_field)::numeric;
        if v_number<>trunc(v_number) or v_number<0 or v_number>2147483647 then
          raise exception using errcode='22023',message='Tiebreak score is outside the allowed integer range';
        end if;
      end if;
    end loop;
  end loop;

  -- Indices define chronology, independently of the JSON array order.
  for v_item in
    select value from jsonb_array_elements(p_sets)
    order by (value->>'set_index')::numeric
  loop
    v_set_index := (v_item->>'set_index')::numeric::integer;
    v_a_games := (v_item->>'side_a_games')::numeric::integer;
    v_b_games := (v_item->>'side_b_games')::numeric::integer;
    if v_set_index <> v_expected_index then
      raise exception using errcode = '22023', message = 'Set indices must be unique and contiguous starting at 1';
    end if;
    v_expected_index := v_expected_index + 1;

    if v_a_wins = v_required_wins or v_b_wins = v_required_wins then
      raise exception using errcode = '22023', message = 'No further sets are allowed after the match is won';
    end if;

    v_rule:=tennis_set_rule(v_rules,v_set_index,v_required_wins);
    v_result:=tennis_set_result(v_item,v_rule);
    if v_result=-1 then
      raise exception using errcode='22023',message='Invalid set or tiebreak score for the tournament rules';
    end if;
    v_complete:=v_result>0;
    if v_complete then
      if v_result=1 then v_a_wins:=v_a_wins+1; else v_b_wins:=v_b_wins+1; end if;
    else
      if v_set_index <> v_set_count then
        raise exception using errcode = '22023', message = 'Only the final entered set may be unfinished';
      end if;
    end if;
  end loop;

  if v_a_wins<v_required_wins and v_b_wins<v_required_wins then
    raise exception using errcode='22023',message='scoringFlow.finalRequired';
  end if;
  v_new_winner:=case when v_a_wins>=v_required_wins then v_side_a_id else v_side_b_id end;
  if v_previous_winner is not null and v_previous_winner is distinct from v_new_winner then
    perform assert_score_correction_safe(p_match_id);
  end if;

  delete from match_sets where match_id = p_match_id;
  insert into match_sets (match_id,set_index,side_a_games,side_b_games,score_kind,side_a_tiebreak,side_b_tiebreak)
  select p_match_id,(value->>'set_index')::numeric::integer,
    (value->>'side_a_games')::numeric::integer,(value->>'side_b_games')::numeric::integer,
    tennis_set_rule(v_rules,(value->>'set_index')::numeric::integer,v_required_wins)->>'kind',
    (value->>'side_a_tiebreak')::numeric::integer,(value->>'side_b_tiebreak')::numeric::integer
  from jsonb_array_elements(p_sets);

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

  if v_new_winner is not null and v_new_winner is distinct from v_previous_winner then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  -- A manual replacement becomes the next live baseline. In-flight taps
  -- carry the old revision and cannot restore the pre-edit score.
  update live_scores set state=tennis_live_state(p_match_id,v_rules,v_required_wins),history='[]'::jsonb,
    status=case when v_new_winner is null then 'stopped' else 'finished' end,revision=revision+1
  where match_id=p_match_id;

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
  if v_fs is null or v_ts is null or v_fs not in ('A', 'B') or v_ts not in ('A', 'B') then
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
  v_seen_matches uuid[] := '{}';
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if jsonb_typeof(p_layout) is distinct from 'array' then
    raise exception 'Layout must be an array';
  end if;

  -- Check every requested change before modifying a match.
  for v_item in select * from jsonb_array_elements(p_layout)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or not (v_item ?& array['match_id', 'side_a_entry_id', 'side_b_entry_id']) then
      raise exception 'Each layout item requires a match and both participant slots';
    end if;
    v_match_id := (v_item->>'match_id')::uuid;
    v_side_a := nullif(v_item->>'side_a_entry_id', '')::uuid;
    v_side_b := nullif(v_item->>'side_b_entry_id', '')::uuid;

    if v_match_id is null or v_match_id = any(v_seen_matches) then
      raise exception 'Layout requires distinct non-null match IDs';
    end if;
    v_seen_matches := array_append(v_seen_matches, v_match_id);

    select * into v_match from matches where id = v_match_id for update;
    if v_match.id is null then
      raise exception 'Match % not found', v_match_id;
    end if;
    if v_match.tournament_id <> p_tournament_id then
      raise exception 'Match does not belong to this tournament';
    end if;
    if v_match.status = 'finished'::match_status then
      raise exception 'Cannot modify finished match';
    end if;
    if exists (select 1 from match_sets where match_id = v_match_id)
       or exists (select 1 from live_scores where match_id = v_match_id and status = 'active') then
      raise exception 'Cannot modify a match with scores or active live scoring';
    end if;
    if v_side_a = v_side_b then
      raise exception 'A match cannot contain the same participant twice';
    end if;
    if (v_side_a is not null and not exists (
          select 1 from entries where id = v_side_a and tournament_id = p_tournament_id and status = 'approved'
        )) or (v_side_b is not null and not exists (
          select 1 from entries where id = v_side_b and tournament_id = p_tournament_id and status = 'approved'
        )) then
      raise exception 'Participant does not belong to the approved entries of this tournament';
    end if;
  end loop;

  for v_item in select * from jsonb_array_elements(p_layout)
  loop
    v_match_id := (v_item->>'match_id')::uuid;
    v_side_a := nullif(v_item->>'side_a_entry_id', '')::uuid;
    v_side_b := nullif(v_item->>'side_b_entry_id', '')::uuid;

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
to anon, authenticated
using (
  is_tournament_admin(tournament_id)
  or (
    status = 'approved'
    and exists (
      select 1 from tournaments t where t.id = entries.tournament_id
        and t.is_public
    )
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
to anon, authenticated
using (
  -- Inherit the parent entry's visibility, including its approval status.
  exists (select 1 from entries e where e.id = entry_members.entry_id)
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
with check (
  is_tournament_admin(tournament_id)
  and winner_entry_id is null
  and status = 'ready'::match_status
);

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

grant execute on function create_tournament(text, text, text, sport, tournament_format, tournament_category, set_format, boolean, doubles_pairing_mode, jsonb, jsonb, text, text) to authenticated;
grant execute on function register_entry(text, tournament_category, text, text, text, text) to anon, authenticated;
grant execute on function normalize_contact(text) to authenticated;
grant execute on function hash_contact(text) to authenticated;
grant execute on function generate_bracket(uuid, draw_mode, uuid[]) to authenticated;
grant execute on function rebuild_bracket(uuid, draw_mode, uuid[]) to authenticated;
grant execute on function update_match_sets(uuid, jsonb, integer) to authenticated;
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

-- Realtime DELETE payloads only carry the primary key by default; clients
-- need match_id to route the event, so publish the full old row.
alter table match_sets replica identity full;

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
-- FEATURE FLAGS (platform-wide toggles, super-admin managed)
-- =============================================
-- Keys are dotted namespaces. Sports use `sport.<enum value>`; a sport with no
-- row (or enabled=false) is hidden from the create wizard and rejected by
-- create_tournament(). Existing tournaments of a disabled sport stay readable.

create table if not exists feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table feature_flags enable row level security;

do $$ begin
  drop policy if exists feature_flags_select_all on feature_flags;
  drop policy if exists feature_flags_write_platform_admin on feature_flags;
end $$;

-- Everyone (incl. anon) may read flags: the UI needs them before/without login.
create policy feature_flags_select_all on feature_flags
  for select to anon, authenticated using (true);

create policy feature_flags_write_platform_admin on feature_flags
  for all to authenticated using (is_platform_admin()) with check (is_platform_admin());

-- Seed: tennis & padel on, football hidden. Idempotent — never overrides admin choices.
insert into feature_flags (key, enabled, description) values
  ('sport.tennis',   true,  'Tennis available in the create wizard'),
  ('sport.padel',    true,  'Padel available in the create wizard'),
  ('sport.football', false, 'Football available in the create wizard')
on conflict (key) do nothing;

create or replace function is_feature_enabled(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select enabled from feature_flags where key = p_key), false);
$$;

create or replace function set_feature_flag(p_key text, p_enabled boolean, p_description text default null)
returns feature_flags
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row feature_flags;
begin
  if not is_platform_admin() then
    raise exception 'Platform admin required';
  end if;
  if p_key is null or btrim(p_key) = '' then
    raise exception 'Flag key required';
  end if;

  insert into feature_flags (key, enabled, description, updated_at, updated_by)
  values (btrim(p_key), coalesce(p_enabled, false), p_description, now(), auth.uid())
  on conflict (key) do update
    set enabled = excluded.enabled,
        description = coalesce(excluded.description, feature_flags.description),
        updated_at = now(),
        updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function set_feature_flag(text, boolean, text) from public, anon;
grant execute on function is_feature_enabled(text) to anon, authenticated;
grant execute on function set_feature_flag(text, boolean, text) to authenticated;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feature_flags'
  ) then
    alter publication supabase_realtime add table feature_flags;
  end if;
end $$;


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
alter table live_scores add column if not exists sides_swapped boolean default false;
alter table live_scores add column if not exists sides_auto boolean default true;
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
update live_scores set sides_swapped = false where sides_swapped is null;
alter table live_scores alter column sides_swapped set default false;
alter table live_scores alter column sides_swapped set not null;
update live_scores set sides_auto = true where sides_auto is null;
alter table live_scores alter column sides_auto set default true;
alter table live_scores alter column sides_auto set not null;
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

drop function if exists live_score_initial_state(integer);

create or replace function live_score_initial_state(
  p_required_sets integer,
  p_tiebreak_to integer default 7
)
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
    'tiebreakTo', p_tiebreak_to,
    'winner', null
  );
$$;

create or replace function tennis_apply_point(p_state jsonb,p_side text)
returns jsonb language plpgsql immutable set search_path=public as $$
declare
  side text:=lower(trim(p_side));
  ga integer:=coalesce((p_state#>>'{games,a}')::integer,0); gb integer:=coalesce((p_state#>>'{games,b}')::integer,0);
  pa integer:=coalesce((p_state#>>'{points,a}')::integer,0); pb integer:=coalesce((p_state#>>'{points,b}')::integer,0);
  ta integer:=coalesce((p_state#>>'{tiebreakPoints,a}')::integer,0); tb integer:=coalesce((p_state#>>'{tiebreakPoints,b}')::integer,0);
  sa integer:=coalesce((p_state#>>'{setsWon,a}')::integer,0); sb integer:=coalesce((p_state#>>'{setsWon,b}')::integer,0);
  required integer:=coalesce((p_state->>'requiredSets')::integer,2); n integer:=coalesce((p_state->>'currentSet')::integer,1);
  sets jsonb:=coalesce(p_state->'sets','[]'::jsonb);
  rules jsonb:=coalesce(p_state->'rules',tennis_scoring_rules(jsonb_build_object('tiebreak_to',coalesce((p_state->>'tiebreakTo')::integer,7))));
  rule jsonb; is_tb boolean:=coalesce((p_state->>'isTiebreak')::boolean,false);
  set_winner integer:=0; game_winner integer:=0; winner text:=nullif(p_state->>'winner',''); entry jsonb;
begin
  if side is null or side not in ('a','b') then raise exception 'Invalid side'; end if;
  if winner in ('a','b') then return p_state; end if;
  rule:=tennis_set_rule(rules,n,required);
  is_tb:=is_tb or rule->>'kind'='match_tiebreak';
  if is_tb then
    ta:=ta+case when side='a' then 1 else 0 end;
    tb:=tb+case when side='b' then 1 else 0 end;
    set_winner:=tennis_race_result(ta,tb,(rule->>'target')::integer,(rule->>'margin')::integer);
    if set_winner>0 and rule->>'kind'='set' then
      ga:=ga+case when set_winner=1 then 1 else 0 end;
      gb:=gb+case when set_winner=2 then 1 else 0 end;
    end if;
  else
    pa:=pa+case when side='a' then 1 else 0 end;
    pb:=pb+case when side='b' then 1 else 0 end;
    game_winner:=tennis_race_result(pa,pb,4,case when rules->>'game_rule'='no_ad' then 1 else 2 end);
    if game_winner>0 then
      ga:=ga+case when game_winner=1 then 1 else 0 end;
      gb:=gb+case when game_winner=2 then 1 else 0 end;
      pa:=0; pb:=0;
      set_winner:=tennis_set_result(jsonb_build_object('side_a_games',ga,'side_b_games',gb),rule);
      is_tb:=coalesce(ga=(rule->>'at')::integer and gb=(rule->>'at')::integer,false);
    end if;
  end if;
  if set_winner<0 or game_winner<0 then raise exception 'Invalid live score state'; end if;
  if set_winner>0 then
    entry:=jsonb_build_object('set_index',n,'side_a_games',ga,'side_b_games',gb,'score_kind',rule->>'kind');
    if is_tb then entry:=entry||jsonb_build_object('side_a_tiebreak',ta,'side_b_tiebreak',tb); end if;
    sets:=sets||jsonb_build_array(entry);
    sa:=sa+case when set_winner=1 then 1 else 0 end;
    sb:=sb+case when set_winner=2 then 1 else 0 end;
    if sa>=required or sb>=required then winner:=case when sa>sb then 'a' else 'b' end; end if;
    pa:=0; pb:=0; ta:=0; tb:=0; is_tb:=false;
    if winner is null then
      n:=n+1; ga:=0; gb:=0;
      rule:=tennis_set_rule(rules,n,required);
      is_tb:=rule->>'kind'='match_tiebreak';
    end if;
  end if;
  return jsonb_build_object('points',jsonb_build_object('a',pa,'b',pb),'games',jsonb_build_object('a',ga,'b',gb),
    'setsWon',jsonb_build_object('a',sa,'b',sb),'sets',sets,'currentSet',n,'isTiebreak',is_tb,
    'isMatchTiebreak',rule->>'kind'='match_tiebreak','tiebreakPoints',jsonb_build_object('a',ta,'b',tb),
    'requiredSets',required,'tiebreakTo',(rule->>'target')::integer,'tiebreakMargin',(rule->>'margin')::integer,
    'rules',rules,'winner',winner);
end;
$$;

-- Rewrite match_sets from a live-score state: all completed sets plus the
-- in-progress set (current games), so the score table follows the live match
-- game by game. Upserts by (match_id, set_index) so realtime subscribers get
-- UPDATE events with stable row ids instead of delete+insert churn.
-- Internal helper for record_point — not exposed to clients.
create or replace function sync_live_match_sets(p_match_id uuid,p_state jsonb)
returns void language plpgsql set search_path=public as $$
declare
  s jsonb; sets jsonb:=coalesce(p_state->'sets','[]'); n integer:=(p_state->>'currentSet')::integer;
  ga integer:=coalesce((p_state#>>'{games,a}')::integer,0); gb integer:=coalesce((p_state#>>'{games,b}')::integer,0);
  ta integer:=coalesce((p_state#>>'{tiebreakPoints,a}')::integer,0); tb integer:=coalesce((p_state#>>'{tiebreakPoints,b}')::integer,0);
  kind text:=case when coalesce((p_state->>'isMatchTiebreak')::boolean,false) then 'match_tiebreak' else 'set' end;
  max_index integer:=0;
begin
  if nullif(p_state->>'winner','') is null and (ga>0 or gb>0 or ta>0 or tb>0) then
    s:=jsonb_build_object('set_index',n,'side_a_games',ga,'side_b_games',gb,'score_kind',kind);
    if coalesce((p_state->>'isTiebreak')::boolean,false) then
      s:=s||jsonb_build_object('side_a_tiebreak',ta,'side_b_tiebreak',tb);
    end if;
    sets:=sets||jsonb_build_array(s);
  end if;
  for s in select value from jsonb_array_elements(sets) loop
    insert into match_sets(match_id,set_index,side_a_games,side_b_games,score_kind,side_a_tiebreak,side_b_tiebreak)
    values(p_match_id,(s->>'set_index')::integer,(s->>'side_a_games')::integer,(s->>'side_b_games')::integer,
      coalesce(s->>'score_kind','set'),(s->>'side_a_tiebreak')::integer,(s->>'side_b_tiebreak')::integer)
    on conflict(match_id,set_index) do update set
      side_a_games=excluded.side_a_games,side_b_games=excluded.side_b_games,score_kind=excluded.score_kind,
      side_a_tiebreak=excluded.side_a_tiebreak,side_b_tiebreak=excluded.side_b_tiebreak;
    max_index:=greatest(max_index,(s->>'set_index')::integer);
  end loop;
  delete from match_sets where match_id=p_match_id and set_index>max_index;
  update matches set side_a_score=coalesce((p_state#>>'{setsWon,a}')::integer,0),
    side_b_score=coalesce((p_state#>>'{setsWon,b}')::integer,0) where id=p_match_id;
end;
$$;

revoke execute on function sync_live_match_sets(uuid, jsonb) from public, anon, authenticated;

drop function if exists start_live_match(uuid);
drop function if exists record_point(uuid, text);
drop function if exists record_point(uuid, text, integer);
drop function if exists stop_live_match(uuid);

create or replace function start_live_match(p_match_id uuid, p_expected_revision integer default null)
returns live_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match matches%rowtype;
  v_set_format set_format;
  v_tournament_status tournament_status;
  v_sport sport;
  v_required_sets integer;
  v_rules jsonb;
  v_live live_scores%rowtype;
begin
  select *
    into v_match
  from matches
  where id = p_match_id
  for update;

  if v_match.id is null then
    raise exception 'Match not found';
  end if;

  select t.set_format, t.status, t.sport,
         tennis_scoring_rules(t.scoring_config)
    into v_set_format, v_tournament_status, v_sport, v_rules
  from tournaments t
  where t.id = v_match.tournament_id;

  if not can_live_score(v_match.tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_sport not in ('tennis', 'padel') then
    raise exception 'Live set scoring is supported only for tennis and padel';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Live scoring can start only after the tournament starts';
  end if;

  if v_match.side_a_entry_id is null or v_match.side_b_entry_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;

  if p_expected_revision is null or p_expected_revision<>v_match.score_revision then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
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
    values (p_match_id, v_match.tournament_id, auth.uid(), 'active', tennis_live_state(p_match_id,v_rules,v_required_sets))
    returning * into v_live;
  elsif v_live.status = 'stopped' then
    update live_scores
    set status = 'active',
        revision = revision + 1,
        counter_user_id = coalesce(counter_user_id, auth.uid())
    where id = v_live.id
    returning * into v_live;
  end if;

  update matches set score_revision=score_revision+1 where id=p_match_id;
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
  v_sport sport;
  v_history_len integer;
  v_old_state jsonb;
  v_new_state jsonb;
  v_new_history jsonb;
  v_winner_side text;
  v_winner_id uuid;
  v_previous_winner uuid;
begin
  select *
    into v_match
  from matches
  where id = p_match_id
  for update;

  if v_match.id is null then
    raise exception 'Match not found';
  end if;

  select t.status, t.sport
    into v_tournament_status, v_sport
  from tournaments t
  where t.id = v_match.tournament_id;

  if not can_live_score(v_match.tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_sport not in ('tennis', 'padel') then
    raise exception 'Live set scoring is supported only for tennis and padel';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Live scoring is available only while the tournament is in progress';
  end if;

  select * into v_live
  from live_scores
  where match_id = p_match_id
  for update;

  if v_live.id is null then
    raise exception using errcode='P0001',message='scoringFlow.resumeRequired';
  end if;

  if p_expected_revision is null or v_live.revision <> p_expected_revision then
    raise exception using errcode='P0001',message='scoringFlow.liveConflict';
  end if;

  if v_live.status = 'stopped' then raise exception 'scoringFlow.resumeRequired'; end if;

  if lower(trim(p_side)) = 'undo' then
    if v_live.status = 'finished' then
      raise exception 'Cannot undo a finished live match';
    end if;

    v_history_len := jsonb_array_length(v_live.history);
    if v_history_len = 0 then
      raise exception 'Nothing to undo';
    end if;

    v_old_state := v_live.state;

    update live_scores
    set state = v_live.history -> (v_history_len - 1),
        history = v_live.history - (v_history_len - 1),
        status = 'active',
        revision = revision + 1
    where id = v_live.id
    returning * into v_live;

    -- Undo may roll back a completed game/set — keep match_sets in sync.
    if v_old_state->'games' is distinct from v_live.state->'games'
       or v_old_state->'sets' is distinct from v_live.state->'sets'
       or v_old_state->'tiebreakPoints' is distinct from v_live.state->'tiebreakPoints' then
      perform sync_live_match_sets(p_match_id, v_live.state);
    end if;

    update matches set score_revision=score_revision+1 where id=p_match_id;
  return v_live;
  end if;

  if v_live.status = 'finished' then
    raise exception 'Match already finished';
  end if;

  v_old_state := v_live.state;
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

    perform sync_live_match_sets(p_match_id, v_new_state);

    update matches
    set winner_entry_id = v_winner_id,
        status = 'finished'::match_status
    where id = p_match_id;

    if v_previous_winner is not null and v_previous_winner is distinct from v_winner_id then
      perform clear_downstream(p_match_id, v_previous_winner);
    end if;

    perform propagate_winner(p_match_id, v_winner_id);
  elsif v_old_state->'games' is distinct from v_new_state->'games'
     or v_old_state->'sets' is distinct from v_new_state->'sets'
     or v_old_state->'tiebreakPoints' is distinct from v_new_state->'tiebreakPoints' then
    -- Game (or set) completed: mirror progress into match_sets so the main
    -- score table follows the live match game by game.
    perform sync_live_match_sets(p_match_id, v_new_state);
  end if;

  update matches set score_revision=score_revision+1 where id=p_match_id;
  return v_live;
end;
$$;

create or replace function stop_live_match(p_match_id uuid, p_expected_revision integer default null)
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
  where m.id = p_match_id for update;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not is_tournament_admin(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  select * into v_live
  from live_scores
  where match_id = p_match_id for update;

  if v_live.id is null then
    raise exception 'Live match not found';
  end if;

  if p_expected_revision is null or p_expected_revision<>v_live.revision then
    raise exception using errcode='P0001',message='scoringFlow.liveConflict';
  end if;
  if v_live.status = 'active' then
    update live_scores
    set status = 'stopped',
        revision = revision + 1
    where id = v_live.id
    returning * into v_live;
  end if;

  update matches set score_revision=score_revision+1 where id=p_match_id;
  return v_live;
end;
$$;

-- Court-side orientation for the live scoring UI. Display-only: it never
-- touches the score, so revision is left alone (bumping it would break the
-- optimistic-concurrency check of in-flight record_point calls).
create or replace function set_live_sides(
  p_match_id uuid,
  p_swapped boolean default null,
  p_auto boolean default null
)
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

  update live_scores
  set sides_swapped = coalesce(p_swapped, sides_swapped),
      sides_auto = coalesce(p_auto, sides_auto)
  where match_id = p_match_id
  returning * into v_live;

  if v_live.id is null then
    raise exception 'Live match not found';
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
to anon, authenticated
using (
  is_tournament_admin(tournament_id)
  or (
    status = 'approved'
    and exists (
      select 1 from tournaments t where t.id = entries.tournament_id
        and (t.is_public or can_live_score(t.id))
    )
  )
);

drop policy if exists entry_members_public_or_admin_select on entry_members;
create policy entry_members_public_or_admin_select on entry_members
for select
to anon, authenticated
using (
  -- Inherit the parent entry's visibility, including its approval status.
  exists (select 1 from entries e where e.id = entry_members.entry_id)
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
grant execute on function start_live_match(uuid, integer) to authenticated;
grant execute on function record_point(uuid, text, integer) to authenticated;
grant execute on function stop_live_match(uuid, integer) to authenticated;
grant execute on function set_live_sides(uuid, boolean, boolean) to authenticated;

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

-- Internal mutation helpers: only authorized SECURITY DEFINER entry points
-- may call these as their common owner. They are not client-facing RPCs.
-- Revoke PUBLIC as well as Supabase's explicit default role grants.
revoke execute on function public.propagate_winner(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.clear_downstream(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.generate_single_elim(uuid, uuid[], public.match_stage)
  from public, anon, authenticated;
revoke execute on function public.generate_double_elim(uuid, uuid[])
  from public, anon, authenticated;
revoke execute on function public.generate_round_robin_matches(uuid, uuid[], public.match_stage, uuid, integer)
  from public, anon, authenticated;

-- Client writes must not bypass the authorized graph/scoring RPCs.
-- Keep only the direct writes currently used by the administration screen:
-- entries.status approval, match result reset, and bracket/sets deletion.
revoke insert, update on public.matches, public.match_sets from public, anon, authenticated;
revoke insert, update, delete on public.groups, public.group_entries, public.live_scores from public, anon, authenticated;
revoke update on public.entries from public, anon, authenticated;

-- Table REVOKE does not remove older column grants. Clear those too, including
-- any extra deployed columns, before granting the narrow supported interface.
do $$
declare
  v_table text;
  v_columns text;
begin
  foreach v_table in array array['matches', 'match_sets', 'groups', 'group_entries', 'live_scores', 'entries']
  loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_columns
    from pg_attribute a
    where a.attrelid = format('public.%I', v_table)::regclass
      and a.attnum > 0 and not a.attisdropped;
    execute format('revoke update (%s) on public.%I from public, anon, authenticated', v_columns, v_table);
    if v_table <> 'entries' then
      execute format('revoke insert (%s) on public.%I from public, anon, authenticated', v_columns, v_table);
    end if;
  end loop;
end;
$$;

grant update (status) on public.entries to authenticated;
grant update (winner_entry_id, status) on public.matches to authenticated;


-- Participant privacy: the public entry projection has no contact column.
-- Existing UI queries already select named columns, including INSERT RETURNING id.
-- Server registration/pairing functions retain their owner-level access.
revoke select on public.entries from public, anon, authenticated;
do $$
declare
  v_columns text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_columns
  from pg_attribute where attrelid = 'public.entries'::regclass
    and attnum > 0 and not attisdropped;
  execute format('revoke select (%s) on public.entries from public, anon, authenticated', v_columns);
end;
$$;
grant select (id, tournament_id, entry_type, display_name, status, seed_order, created_at, updated_at)
  on public.entries to anon, authenticated;

-- A profile belongs to its Auth user. Unlinked, merged and deleted records
-- are maintained by trusted server code and are never claimable by a client.
alter table public.players enable row level security;
drop policy if exists players_select_own on public.players;
create policy players_select_own on public.players for select to authenticated
using ((select auth.uid()) = user_id and not is_deleted and merged_into is null);
drop policy if exists players_insert_own on public.players;
create policy players_insert_own on public.players for insert to authenticated
with check ((select auth.uid()) = user_id and not is_deleted and merged_into is null);
drop policy if exists players_update_own on public.players;
create policy players_update_own on public.players for update to authenticated
using ((select auth.uid()) = user_id and not is_deleted and merged_into is null)
with check ((select auth.uid()) = user_id and not is_deleted and merged_into is null);

revoke all privileges on public.players from public, anon, authenticated;
do $$
declare
  v_columns text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum) into v_columns
  from pg_attribute where attrelid = 'public.players'::regclass
    and attnum > 0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.players from public, anon, authenticated',
    v_columns, v_columns, v_columns, v_columns);
end;
$$;
grant select on public.players to authenticated;
grant insert (user_id, display_name, avatar_url, birth_year, gender, country) on public.players to authenticated;
grant update (display_name, avatar_url, birth_year, gender, country) on public.players to authenticated;

-- ITF 2026 rule validation and internal helper permissions.

drop trigger if exists trg_tennis_scoring_settings on public.tournaments;
create trigger trg_tennis_scoring_settings before insert or update of scoring_config,set_format,sport
  on public.tournaments for each row execute function public.guard_tennis_scoring_settings();
revoke execute on function tennis_scoring_rules(jsonb), tennis_set_rule(jsonb,integer,integer),
  tennis_race_result(integer,integer,integer,integer), tennis_set_result(jsonb,jsonb),
  tennis_live_state(uuid,jsonb,integer), guard_tennis_scoring_settings()
  from public,anon,authenticated;
revoke execute on function tennis_apply_point(jsonb,text),sync_live_match_sets(uuid,jsonb) from public,anon,authenticated;
notify pgrst,'reload schema';


-- Versions are server-owned and also invalidate forms when participants change.
create or replace function bump_match_score_revision()
returns trigger language plpgsql set search_path=public as $$
begin
  new.score_revision:=old.score_revision+1;
  return new;
end;
$$;
drop trigger if exists trg_match_score_revision on matches;
create trigger trg_match_score_revision before update on matches for each row execute function bump_match_score_revision();

-- Until full graph rollback is implemented, never change an entrant underneath
-- an already scored downstream match (winner AND loser branches).
create or replace function assert_score_correction_safe(p_match_id uuid)
returns void language plpgsql set search_path=public as $$
declare r matches%rowtype;
begin
  for r in
    with recursive downstream(id) as (
      select unnest(array[next_match_id,loser_next_match_id]) from matches where id=p_match_id
      union
      select unnest(array[m.next_match_id,m.loser_next_match_id]) from matches m join downstream d on d.id=m.id
    )
    select m.* from matches m where m.id in(select id from downstream) and m.id<>p_match_id order by m.id for update
  loop
    if r.tournament_id is distinct from (select tournament_id from matches where id=p_match_id) then
      raise exception 'Next match does not belong to this tournament';
    end if;
    if r.status='finished' or r.winner_entry_id is not null
      or coalesce(r.side_a_score,0)<>0 or coalesce(r.side_b_score,0)<>0
      or exists(select 1 from match_sets where match_id=r.id)
      or exists(select 1 from live_scores where match_id=r.id) then
      raise exception using errcode='P0001',message='scoringFlow.downstreamStarted';
    end if;
  end loop;
end;
$$;

-- One statement snapshot: forms must not pair newer versions with older sets.
create or replace function get_tournament_score_state(p_tournament_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  if not can_live_score(p_tournament_id) then raise exception 'Not allowed'; end if;
  select jsonb_build_object(
    'matches',coalesce((select jsonb_agg(to_jsonb(m) order by m.round_number,m.match_number) from matches m where tournament_id=p_tournament_id),'[]'::jsonb),
    'sets',coalesce((select jsonb_agg(to_jsonb(s) order by s.set_index) from match_sets s join matches m on m.id=s.match_id where m.tournament_id=p_tournament_id),'[]'::jsonb),
    'live',coalesce((select jsonb_agg(to_jsonb(l)) from live_scores l where tournament_id=p_tournament_id),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;

-- No unversioned RPC or direct row reset may bypass the scoring contract.
revoke update(winner_entry_id,status) on matches from public,anon,authenticated;
revoke delete on match_sets from public,anon,authenticated;
revoke execute on function bump_match_score_revision(),assert_score_correction_safe(uuid) from public,anon,authenticated;
revoke execute on function update_match_sets(uuid,jsonb,integer),update_football_result(uuid,integer,integer,integer,integer,integer),
 start_live_match(uuid,integer),stop_live_match(uuid,integer),record_point(uuid,text,integer),get_tournament_score_state(uuid) from public,anon,authenticated;
grant execute on function update_match_sets(uuid,jsonb,integer),update_football_result(uuid,integer,integer,integer,integer,integer),
 start_live_match(uuid,integer),stop_live_match(uuid,integer),record_point(uuid,text,integer),get_tournament_score_state(uuid) to authenticated;
notify pgrst,'reload schema';

-- Step 6: confirmed, versioned correction of both bracket branches.
-- Internal helpers remain inaccessible through the Data API.
create or replace function correction_descendants(p_match_id uuid)
returns uuid[] language plpgsql set search_path=public as $$
declare v_ids uuid[]; v_tid uuid;
begin
  select tournament_id into v_tid from matches where id=p_match_id;
  with recursive d(id) as (
    select unnest(array[next_match_id,loser_next_match_id]) from matches where id=p_match_id
    union
    select unnest(array[m.next_match_id,m.loser_next_match_id]) from matches m join d on d.id=m.id
  ) select coalesce(array_agg(id order by id) filter(where id is not null),'{}') into v_ids from d;
  if p_match_id=any(v_ids) or exists(select 1 from matches where id=any(v_ids) and tournament_id<>v_tid) then
    raise exception 'scoringFlow.invalidGraph';
  end if;
  -- Detect cycles anywhere in the reachable graph, including a lower-branch loop.
  if exists (
    with recursive walk(id,path,cycle) as (
      select p_match_id,array[p_match_id],false
      union all
      select n.id,w.path||n.id,n.id=any(w.path)
      from walk w join matches m on m.id=w.id
      cross join lateral unnest(array[m.next_match_id,m.loser_next_match_id]) n(id)
      where n.id is not null and not w.cycle
    ) select 1 from walk where cycle
  ) then raise exception 'scoringFlow.invalidGraph'; end if;
  if exists(select 1 from matches m where m.id=any(v_ids||p_match_id)
    and ((m.next_match_id is not null and m.next_slot is null) or (m.loser_next_match_id is not null and m.loser_next_slot is null))) then
    raise exception 'scoringFlow.invalidGraph';
  end if;
  return v_ids;
end;
$$;

create or replace function reset_correction_descendants(p_match_id uuid)
returns void language plpgsql set search_path=public as $$
declare v_ids uuid[]; v_parents uuid[]; r matches%rowtype; v_rules jsonb; v_required integer;
begin
  v_ids:=correction_descendants(p_match_id);
  v_parents:=v_ids||p_match_id;
  perform 1 from matches where id=any(v_ids) order by id for update nowait;
  perform 1 from live_scores where match_id=any(v_ids) order by match_id for update nowait;
  if exists(select 1 from live_scores where match_id=any(v_ids) and status='active') then
    raise exception 'scoringFlow.correctionLive';
  end if;
  delete from match_sets where match_id=any(v_ids);
  -- Invalidate only slots fed by this dependency graph. Independent opponents stay.
  update matches target set
    side_a_entry_id=case when exists(select 1 from matches src where src.id=any(v_parents)
      and ((src.next_match_id=target.id and src.next_slot='A') or (src.loser_next_match_id=target.id and src.loser_next_slot='A'))) then null else target.side_a_entry_id end,
    side_b_entry_id=case when exists(select 1 from matches src where src.id=any(v_parents)
      and ((src.next_match_id=target.id and src.next_slot='B') or (src.loser_next_match_id=target.id and src.loser_next_slot='B'))) then null else target.side_b_entry_id end,
    winner_entry_id=null,side_a_score=null,side_b_score=null,side_a_pens=null,side_b_pens=null,status='pending'
  where target.id=any(v_ids);
  select tennis_scoring_rules(t.scoring_config),case when t.set_format='best_of_5' then 3 else 2 end
    into v_rules,v_required from tournaments t join matches m on m.tournament_id=t.id where m.id=p_match_id;
  -- Keep an empty stopped row with an increasing revision. Deleting/recreating
  -- the live row would allow an old request to match a reused revision (ABA).
  update live_scores set state=tennis_live_state(match_id,v_rules,v_required),history='[]',
    status='stopped',revision=revision+1,counter_user_id=null
  where match_id=any(v_ids);
end;
$$;

create or replace function clear_downstream(p_match_id uuid,p_stale_winner uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if p_stale_winner is null then return; end if;
  perform reset_correction_descendants(p_match_id);
end;
$$;

create or replace function get_match_correction_preview(p_match_id uuid,p_result jsonb,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare m matches%rowtype; t tournaments%rowtype; v_ids uuid[]; v_data jsonb; v_state jsonb; v_group boolean; v_token text;
begin
  select * into m from matches where id=p_match_id;
  if m.id is null then raise exception 'Match not found'; end if;
  if not is_tournament_admin(m.tournament_id) then raise exception 'Not allowed'; end if;
  select * into t from tournaments where id=m.tournament_id for share nowait;
  if t.status<>'in_progress' then raise exception 'Scores can be entered only after the tournament starts'; end if;
  -- Corrections are rare. Short NOWAIT locks avoid deadlocks with point RPCs
  -- (which already lock their match before the live row) and bracket edits.
  perform 1 from matches where tournament_id=m.tournament_id order by id for update nowait;
  perform 1 from live_scores where tournament_id=m.tournament_id order by match_id for update nowait;
  select * into m from matches where id=p_match_id;
  if m.id is null or p_expected_revision is null or m.score_revision<>p_expected_revision then raise exception 'scoringFlow.conflict'; end if;
  if exists(select 1 from live_scores where match_id=m.id and status='active') then raise exception 'scoringFlow.liveBlocked'; end if;
  if jsonb_typeof(p_result) is distinct from 'object' then raise exception 'Invalid result'; end if;
  v_group:=m.stage='group' and t.format='groups_playoff' and exists(select 1 from matches where tournament_id=t.id and stage='winners');
  if v_group then
    select coalesce(array_agg(id order by id),'{}') into v_ids from matches where tournament_id=t.id and stage='winners';
  else v_ids:=correction_descendants(m.id); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',d.id,'stage',d.stage,'round_number',d.round_number,'match_number',d.match_number,
    'side_a_entry_id',d.side_a_entry_id,'side_b_entry_id',d.side_b_entry_id,
    'side_a_name',a.display_name,'side_b_name',b.display_name,
    'side_a_score',d.side_a_score,'side_b_score',d.side_b_score,
    'side_a_pens',d.side_a_pens,'side_b_pens',d.side_b_pens,
    'status',d.status,'live_status',l.status,
    'has_result',d.status='finished' or d.winner_entry_id is not null or d.side_a_score is not null or d.side_b_score is not null or l.id is not null
      or exists(select 1 from match_sets where match_id=d.id)
  ) order by d.stage,d.round_number,d.match_number),'[]') into v_data
  from matches d left join entries a on a.id=d.side_a_entry_id left join entries b on b.id=d.side_b_entry_id
  left join live_scores l on l.match_id=d.id where d.id=any(v_ids);
  -- The token binds the submitted result AND every relevant row. Group reseeding
  -- also depends on the other group scores, qualifiers and tournament settings.
  select jsonb_build_object('tournament',to_jsonb(t),'result',p_result,
    'matches',(select jsonb_agg(to_jsonb(x) order by x.id) from matches x where case when v_group then x.tournament_id=t.id else x.id=any(v_ids||m.id) end),
    'sets',(select jsonb_agg(to_jsonb(x) order by x.match_id,x.set_index) from match_sets x join matches d on d.id=x.match_id where case when v_group then d.tournament_id=t.id else d.id=any(v_ids||m.id) end),
    'live',(select jsonb_agg(to_jsonb(x) order by x.match_id) from live_scores x where x.match_id=any(v_ids||m.id)),
    'groups',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from groups x where x.tournament_id=t.id) end,
    'qualifiers',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from group_entries x join groups g on g.id=x.group_id where g.tournament_id=t.id) end
  ) into v_state;
  v_token:=encode(extensions.digest(v_state::text,'sha256'),'hex');
  return jsonb_build_object('token',v_token,'matches',v_data,'reseed_playoff',v_group,
    'blocked_live',exists(select 1 from live_scores where match_id=any(v_ids) and status='active'));
exception when lock_not_available or deadlock_detected then
  raise exception 'scoringFlow.correctionConflict';
end;
$$;


create or replace function propagate_winner(p_match_id uuid, p_winner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
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

  select tournament_id, next_match_id, next_slot, loser_next_match_id, loser_next_slot,
         side_a_entry_id, side_b_entry_id
    into v_tournament_id, v_next_match_id, v_next_slot, v_loser_next_id, v_loser_next_slot,
         v_match_side_a, v_match_side_b
  from matches
  where id = p_match_id
  for update;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;
  -- Defend against old or privileged writes containing invalid graph links.
  if not exists (select 1 from entries where id = p_winner_id and tournament_id = v_tournament_id)
     or (p_winner_id is distinct from v_match_side_a and p_winner_id is distinct from v_match_side_b)
     or exists (
       select 1 from entries e
       where e.id in (v_match_side_a, v_match_side_b) and e.tournament_id <> v_tournament_id
     ) then
    raise exception 'Winner or participant does not belong to this tournament match';
  end if;
  if v_next_match_id is not null and not exists (
    select 1 from matches where id = v_next_match_id and tournament_id = v_tournament_id
  ) then
    raise exception 'Next match does not belong to this tournament';
  end if;
  if v_loser_next_id is not null and not exists (
    select 1 from matches where id = v_loser_next_id and tournament_id = v_tournament_id
  ) then
    raise exception 'Loser next match does not belong to this tournament';
  end if;

  -- Even a first result must not replace a participant under a saved result.
  -- All confirmed correction paths clear affected matches before propagation.
  if exists (
    select 1 from matches d
    join (values (v_next_match_id,v_next_slot,p_winner_id),
      (v_loser_next_id,v_loser_next_slot,case when p_winner_id=v_match_side_a then v_match_side_b else v_match_side_a end)) edge(id,slot,entrant)
      on edge.id=d.id
    where edge.entrant is not null
      and (case when edge.slot='A' then d.side_a_entry_id else d.side_b_entry_id end) is distinct from edge.entrant
      and (d.status='finished' or d.winner_entry_id is not null or d.side_a_score is not null or d.side_b_score is not null
        or d.side_a_pens is not null or d.side_b_pens is not null
        or exists(select 1 from match_sets where match_id=d.id)
        or exists(select 1 from live_scores where match_id=d.id and status='active'))
  ) then raise exception 'scoringFlow.downstreamStarted'; end if;

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

create or replace function write_match_sets_result(
  p_match_id uuid,
  p_sets jsonb,
  p_expected_revision integer default null,
  p_defer_bracket boolean default false
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
  v_sport sport;
  v_rules jsonb;
  v_rule jsonb;
  v_result integer;
  v_max_sets integer;
  v_set_count integer;
  v_expected_index integer := 1;
  v_field text;
  v_number numeric;
  v_complete boolean;
  v_required_wins integer;
  v_side_a_id uuid;
  v_side_b_id uuid;
  v_previous_winner uuid;
  v_new_winner uuid;
  v_a_wins integer := 0;
  v_b_wins integer := 0;
  v_item jsonb;
  v_revision integer;
  v_set_index integer;
  v_a_games integer;
  v_b_games integer;
begin
  select m.tournament_id,
         m.side_a_entry_id,
         m.side_b_entry_id,
         m.winner_entry_id,
         t.set_format,
         tennis_scoring_rules(t.scoring_config),
         t.sport,
         t.status
    into v_tournament_id,
         v_side_a_id,
         v_side_b_id,
         v_previous_winner,
         v_set_format,
         v_rules,
         v_sport,
         v_tournament_status
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id
  for update of m;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not is_tournament_admin(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_sport not in ('tennis', 'padel') then
    raise exception 'Set scores are supported only for tennis and padel';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Scores can be entered only after the tournament starts';
  end if;

  if v_side_a_id is null or v_side_b_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;

  select score_revision into v_revision from matches where id=p_match_id;
  if exists(select 1 from live_scores where match_id=p_match_id and status='active') then
    raise exception using errcode='P0001',message='scoringFlow.liveBlocked';
  end if;
  if p_expected_revision is null or p_expected_revision<>v_revision then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
  end if;

  v_required_wins := case
    when v_set_format = 'best_of_5' then 3
    else 2
  end;

  v_max_sets := 2 * v_required_wins - 1;

  -- Validate the entire replacement before deleting sets or changing the graph.
  -- Only complete results are accepted; reset is a separate confirmed operation.
  if jsonb_typeof(p_sets) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Sets must be a JSON array';
  end if;
  v_set_count := jsonb_array_length(p_sets);
  if v_set_count > v_max_sets then
    raise exception using errcode = '22023', message = 'Too many sets for this match format';
  end if;

  for v_item in select value from jsonb_array_elements(p_sets) loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Each set must be an object with an index and both game scores';
    end if;
    foreach v_field in array array['set_index', 'side_a_games', 'side_b_games'] loop
      if jsonb_typeof(v_item->v_field) is distinct from 'number' then
        raise exception using errcode = '22023', message = 'Set index and game scores must be non-null JSON numbers';
      end if;
      v_number := (v_item->>v_field)::numeric;
      if v_number <> trunc(v_number)
         or v_number < (case when v_field = 'set_index' then 1 else 0 end)
         or v_number > (case when v_field = 'set_index' then v_max_sets else 2147483647 end) then
        raise exception using errcode = '22023', message = 'Set index or game score is outside the allowed integer range';
      end if;
    end loop;
    foreach v_field in array array['side_a_tiebreak','side_b_tiebreak'] loop
      if v_item ? v_field and v_item->v_field <> 'null'::jsonb then
        if jsonb_typeof(v_item->v_field) is distinct from 'number' then
          raise exception using errcode='22023',message='Tiebreak scores must be JSON integers';
        end if;
        v_number:=(v_item->>v_field)::numeric;
        if v_number<>trunc(v_number) or v_number<0 or v_number>2147483647 then
          raise exception using errcode='22023',message='Tiebreak score is outside the allowed integer range';
        end if;
      end if;
    end loop;
  end loop;

  -- Indices define chronology, independently of the JSON array order.
  for v_item in
    select value from jsonb_array_elements(p_sets)
    order by (value->>'set_index')::numeric
  loop
    v_set_index := (v_item->>'set_index')::numeric::integer;
    v_a_games := (v_item->>'side_a_games')::numeric::integer;
    v_b_games := (v_item->>'side_b_games')::numeric::integer;
    if v_set_index <> v_expected_index then
      raise exception using errcode = '22023', message = 'Set indices must be unique and contiguous starting at 1';
    end if;
    v_expected_index := v_expected_index + 1;

    if v_a_wins = v_required_wins or v_b_wins = v_required_wins then
      raise exception using errcode = '22023', message = 'No further sets are allowed after the match is won';
    end if;

    v_rule:=tennis_set_rule(v_rules,v_set_index,v_required_wins);
    v_result:=tennis_set_result(v_item,v_rule);
    if v_result=-1 then
      raise exception using errcode='22023',message='Invalid set or tiebreak score for the tournament rules';
    end if;
    v_complete:=v_result>0;
    if v_complete then
      if v_result=1 then v_a_wins:=v_a_wins+1; else v_b_wins:=v_b_wins+1; end if;
    else
      if v_set_index <> v_set_count then
        raise exception using errcode = '22023', message = 'Only the final entered set may be unfinished';
      end if;
    end if;
  end loop;

  if v_a_wins<v_required_wins and v_b_wins<v_required_wins then
    raise exception using errcode='22023',message='scoringFlow.finalRequired';
  end if;
  v_new_winner:=case when v_a_wins>=v_required_wins then v_side_a_id else v_side_b_id end;
  if not p_defer_bracket and v_previous_winner is distinct from v_new_winner then
    perform assert_score_correction_safe(p_match_id);
  end if;

  if not p_defer_bracket and exists(select 1 from matches where id=p_match_id and stage='group')
     and exists(select 1 from matches where tournament_id=v_tournament_id and stage='winners') then
    raise exception 'scoringFlow.downstreamStarted';
  end if;

  delete from match_sets where match_id = p_match_id;
  insert into match_sets (match_id,set_index,side_a_games,side_b_games,score_kind,side_a_tiebreak,side_b_tiebreak)
  select p_match_id,(value->>'set_index')::numeric::integer,
    (value->>'side_a_games')::numeric::integer,(value->>'side_b_games')::numeric::integer,
    tennis_set_rule(v_rules,(value->>'set_index')::numeric::integer,v_required_wins)->>'kind',
    (value->>'side_a_tiebreak')::numeric::integer,(value->>'side_b_tiebreak')::numeric::integer
  from jsonb_array_elements(p_sets);

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

  if not p_defer_bracket and v_previous_winner is not null and v_previous_winner is distinct from v_new_winner then
    perform clear_downstream(p_match_id, v_previous_winner);
  end if;

  if not p_defer_bracket and v_new_winner is not null and v_new_winner is distinct from v_previous_winner then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  -- A manual replacement becomes the next live baseline. In-flight taps
  -- carry the old revision and cannot restore the pre-edit score.
  update live_scores set state=tennis_live_state(p_match_id,v_rules,v_required_wins),history='[]'::jsonb,
    status=case when v_new_winner is null then 'stopped' else 'finished' end,revision=revision+1
  where match_id=p_match_id;

  -- status transitions are managed explicitly via the admin UI

  return v_new_winner;
end;
$$;

create or replace function write_football_result(
  p_match_id uuid,
  p_a_goals integer,
  p_b_goals integer,
  p_a_pens integer default null,
  p_b_pens integer default null,
  p_expected_revision integer default null,
  p_defer_bracket boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status tournament_status;
  v_sport sport;
  v_format tournament_format;
  v_stage match_stage;
  v_side_a uuid;
  v_side_b uuid;
  v_prev_winner uuid;
  v_new_winner uuid;
  v_draw_allowed boolean;
begin
  select m.tournament_id, t.status, t.sport, t.format, m.stage,
         m.side_a_entry_id, m.side_b_entry_id, m.winner_entry_id
    into v_tournament_id, v_status, v_sport, v_format, v_stage,
         v_side_a, v_side_b, v_prev_winner
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id for update of m;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;
  if not is_tournament_admin(v_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if v_sport <> 'football' then
    raise exception 'Goal scores are supported only for football';
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

  if p_expected_revision is null or p_expected_revision<>(select score_revision from matches where id=p_match_id) then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
  end if;
  if (p_a_pens is not null and p_a_pens<0) or (p_b_pens is not null and p_b_pens<0) then raise exception 'Valid penalty counts required'; end if;
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

  if not p_defer_bracket and v_prev_winner is distinct from v_new_winner then
    perform assert_score_correction_safe(p_match_id);
  end if;
  if not p_defer_bracket and exists(select 1 from matches where id=p_match_id and stage='group')
     and exists(select 1 from matches where tournament_id=v_tournament_id and stage='winners') then
    raise exception 'scoringFlow.downstreamStarted';
  end if;

  update matches
  set side_a_score = p_a_goals,
      side_b_score = p_b_goals,
      side_a_pens = p_a_pens,
      side_b_pens = p_b_pens,
      winner_entry_id = v_new_winner,
      status = 'finished'::match_status
  where id = p_match_id;

  if not p_defer_bracket and v_prev_winner is not null and v_prev_winner is distinct from v_new_winner then
    perform clear_downstream(p_match_id, v_prev_winner);
  end if;

  if not p_defer_bracket and v_new_winner is not null and v_new_winner is distinct from v_prev_winner then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  return v_new_winner;
end;
$$;

-- Preserve the existing versioned API. Unconfirmed dangerous edits still fail.
create or replace function update_match_sets(p_match_id uuid,p_sets jsonb,p_expected_revision integer default null)
returns uuid language sql security definer set search_path=public as $$
  select write_match_sets_result(p_match_id,p_sets,p_expected_revision,false);
$$;
create or replace function update_football_result(p_match_id uuid,p_a_goals integer,p_b_goals integer,
  p_a_pens integer default null,p_b_pens integer default null,p_expected_revision integer default null)
returns uuid language sql security definer set search_path=public as $$
  select write_football_result(p_match_id,p_a_goals,p_b_goals,p_a_pens,p_b_pens,p_expected_revision,false);
$$;

create or replace function apply_match_correction(p_match_id uuid,p_result jsonb,p_expected_revision integer,p_confirmation_token text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_preview jsonb; m matches%rowtype; v_sport sport; v_new uuid; v_group boolean; v_field text;
begin
  -- This repeats permission, LIVE, revision and graph checks under row locks.
  v_preview:=get_match_correction_preview(p_match_id,p_result,p_expected_revision);
  if p_confirmation_token is null or p_confirmation_token is distinct from v_preview->>'token' then
    raise exception 'scoringFlow.correctionConflict';
  end if;
  if (v_preview->>'blocked_live')::boolean then raise exception 'scoringFlow.correctionLive'; end if;
  select * into m from matches where id=p_match_id;
  select sport into v_sport from tournaments where id=m.tournament_id;
  v_group:=(v_preview->>'reseed_playoff')::boolean;
  -- Reuse the exact validators used by ordinary manual saves. Nothing in the
  -- graph changes unless the full result is valid; every write is one transaction.
  if v_sport in ('tennis','padel') then
    v_new:=write_match_sets_result(m.id,p_result->'sets',p_expected_revision,true);
  elsif v_sport='football' then
    foreach v_field in array array['a_goals','b_goals','a_pens','b_pens'] loop
      if p_result->v_field is not null and p_result->v_field<>'null'::jsonb then
        if jsonb_typeof(p_result->v_field)<>'number' or (p_result->>v_field)::numeric<>trunc((p_result->>v_field)::numeric) then
          raise exception 'Valid goal and penalty counts required';
        end if;
      end if;
    end loop;
    v_new:=write_football_result(m.id,(p_result->>'a_goals')::integer,(p_result->>'b_goals')::integer,
      (p_result->>'a_pens')::integer,(p_result->>'b_pens')::integer,p_expected_revision,true);
  else raise exception 'Unsupported sport'; end if;
  if v_group then
    -- New UUIDs fence every old playoff form/session. Other group results stay.
    perform generate_group_playoff(m.tournament_id);
  elsif m.winner_entry_id is distinct from v_new then
    perform reset_correction_descendants(m.id);
    perform propagate_winner(m.id,v_new);
  end if;
  return v_new;
exception when lock_not_available or deadlock_detected then
  raise exception 'scoringFlow.correctionConflict';
end;
$$;

revoke execute on function correction_descendants(uuid),reset_correction_descendants(uuid),
  write_match_sets_result(uuid,jsonb,integer,boolean),write_football_result(uuid,integer,integer,integer,integer,integer,boolean),
  clear_downstream(uuid,uuid) from public,anon,authenticated;
revoke execute on function get_match_correction_preview(uuid,jsonb,integer),apply_match_correction(uuid,jsonb,integer,text),
  update_match_sets(uuid,jsonb,integer),update_football_result(uuid,integer,integer,integer,integer,integer) from public,anon,authenticated;
grant execute on function get_match_correction_preview(uuid,jsonb,integer),apply_match_correction(uuid,jsonb,integer,text),
  update_match_sets(uuid,jsonb,integer),update_football_result(uuid,integer,integer,integer,integer,integer) to authenticated;
notify pgrst,'reload schema';

-- Step 7: preserve drafts and reject stale writes to settings, layouts and pairs.
alter table tournaments add column if not exists settings_revision integer not null default 0;
alter table tournaments add column if not exists publish_contact boolean not null default false;
create or replace function bump_tournament_settings_revision()
returns trigger language plpgsql set search_path=public as $$
begin new.settings_revision:=old.settings_revision+1; return new; end;
$$;
drop trigger if exists trg_tournament_settings_revision on tournaments;
create trigger trg_tournament_settings_revision before update on tournaments for each row execute function bump_tournament_settings_revision();

create or replace function tournament_match_versions(p_tournament_id uuid)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',score_revision) order by id),'[]') from matches where tournament_id=p_tournament_id;
$$;
create or replace function tournament_entry_snapshot(p_tournament_id uuid)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,
  'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,'member_name',em.member_name,'member_order',em.member_order) order by em.member_order) from entry_members em where em.entry_id=e.id),'[]'::jsonb)) order by e.id),'[]')
 from entries e where e.tournament_id=p_tournament_id;
$$;
create or replace function get_tournament_entry_state(p_tournament_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_admin boolean; v_result jsonb;
begin
 if not can_live_score(p_tournament_id) then raise exception 'Not allowed'; end if;
 v_admin:=is_tournament_admin(p_tournament_id);
 select jsonb_build_object('entries',coalesce((select jsonb_agg(x order by x->>'id') from jsonb_array_elements(tournament_entry_snapshot(p_tournament_id)) x where v_admin or x->>'status'='approved'),'[]'),
   'matches',tournament_match_versions(p_tournament_id),'settings_revision',(select settings_revision from tournaments where id=p_tournament_id)) into v_result;
 return v_result;
end;
$$;

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
  if k<>all(array['name','description','category','set_format','scoring_config','doubles_pairing_mode','status','is_public','contact_phone','contact_email','publish_contact']) then raise exception 'Unsupported settings field'; end if;
 end loop;
 v_new:=jsonb_populate_record(v_old,p_patch);
 if v_new.name is null or btrim(v_new.name)='' or v_new.is_public is null or v_new.scoring_config is null or v_new.publish_contact is null then raise exception 'Invalid settings'; end if;
 if v_new.publish_contact and nullif(btrim(coalesce(v_new.contact_phone,'')),'') is null and nullif(btrim(coalesce(v_new.contact_email,'')),'') is null then raise exception 'Contact required'; end if;
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
  contact_phone=nullif(btrim(coalesce(v_new.contact_phone,'')),''),contact_email=nullif(btrim(coalesce(v_new.contact_email,'')),''),publish_contact=v_new.publish_contact
 where id=p_tournament_id returning * into v_new;
 if v_category_changed then delete from matches where tournament_id=p_tournament_id; end if;
 return to_jsonb(v_new);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;

create or replace function save_bracket_layout(p_tournament_id uuid,p_layout jsonb,p_expected_matches jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=p_tournament_id for update;
 if exists(select 1 from tournaments where id=p_tournament_id and status in ('in_progress','completed')) then raise exception 'drafts.rulesLocked'; end if;
 perform 1 from matches where tournament_id=p_tournament_id order by id for update nowait;
 if p_expected_matches is null or p_expected_matches is distinct from tournament_match_versions(p_tournament_id) then raise exception 'drafts.structureConflict'; end if;
 perform apply_bracket_layout(p_tournament_id,p_layout);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;

-- References are member UUIDs, not names: two people with the same name stay
-- distinct. Splitting and regrouping are atomic and preserve member/player IDs.
create or replace function save_tournament_pairs(p_tournament_id uuid,p_pairs jsonb,p_replace boolean,
 p_expected_entries jsonb,p_expected_matches jsonb,p_expected_revision integer)
returns integer language plpgsql security definer set search_path=public as $$
declare v_t tournaments%rowtype; pair jsonb; mid uuid; used uuid[]:='{}'; v_split record; new_entry uuid; a uuid; b uuid; ea uuid; eb uuid; na text; nb text; n integer:=0;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_t from tournaments where id=p_tournament_id for update;
 if p_expected_revision is null or v_t.settings_revision<>p_expected_revision then raise exception 'drafts.structureConflict'; end if;
 if v_t.status in ('in_progress','completed') or v_t.category<>'doubles' or v_t.doubles_pairing_mode is distinct from 'pick_random'::doubles_pairing_mode then raise exception 'drafts.rulesLocked'; end if;
 perform 1 from matches where tournament_id=p_tournament_id order by id for update nowait;
 perform 1 from entries where tournament_id=p_tournament_id order by id for update nowait;
 perform 1 from entry_members where entry_id in(select id from entries where tournament_id=p_tournament_id) order by id for update nowait;
 if p_expected_entries is null or p_expected_entries is distinct from tournament_entry_snapshot(p_tournament_id)
  or p_expected_matches is null or p_expected_matches is distinct from tournament_match_versions(p_tournament_id) then raise exception 'drafts.structureConflict'; end if;
 if jsonb_typeof(p_pairs) is distinct from 'array' or p_replace is null then raise exception 'Invalid pairs'; end if;
 for pair in select value from jsonb_array_elements(p_pairs) loop
  if jsonb_typeof(pair) is distinct from 'array' or jsonb_array_length(pair)<>2 then raise exception 'Invalid pairs'; end if;
  for mid in select value::uuid from jsonb_array_elements_text(pair) loop
   if mid is null or mid=any(used) or not exists(select 1 from entry_members em join entries e on e.id=em.entry_id
      where em.id=mid and e.tournament_id=p_tournament_id and e.status='approved' and e.entry_type='doubles'
       and (p_replace or (select count(*) from entry_members other where other.entry_id=e.id)=1)) then raise exception 'Invalid or repeated pair member'; end if;
   used:=array_append(used,mid);
  end loop;
 end loop;
 if jsonb_array_length(p_pairs)=0 then raise exception 'At least one complete pair required'; end if;
 -- A pairing edit may reset only an unplayed bracket reviewed by the organiser.
 if exists(select 1 from matches where tournament_id=p_tournament_id and status='finished')
  or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=p_tournament_id)
  or exists(select 1 from live_scores where tournament_id=p_tournament_id) then raise exception 'drafts.rulesLocked'; end if;
 delete from matches where tournament_id=p_tournament_id;
 if p_replace then
  for v_split in select em.id,em.entry_id,em.member_name from entry_members em join entries en on en.id=em.entry_id
    where en.tournament_id=p_tournament_id and en.status='approved' and em.member_order=2 order by em.id loop
   insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
     values(p_tournament_id,'doubles',v_split.member_name,'split-'||gen_random_uuid(),'approved') returning id into new_entry;
   update entry_members set entry_id=new_entry,member_order=1 where id=v_split.id;
   update entries set display_name=(select member_name from entry_members where entry_id=v_split.entry_id and member_order=1) where id=v_split.entry_id;
  end loop;
 end if;
 for pair in select value from jsonb_array_elements(p_pairs) loop
  a:=(pair->>0)::uuid; b:=(pair->>1)::uuid;
  select entry_id,member_name into ea,na from entry_members where id=a;
  select entry_id,member_name into eb,nb from entry_members where id=b;
  update entry_members set entry_id=ea,member_order=2 where id=b;
  update entries set display_name=na||' / '||nb where id=ea;
  delete from entries where id=eb;
  n:=n+1;
 end loop;
 return n;
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;
revoke execute on function bump_tournament_settings_revision(),tournament_match_versions(uuid),tournament_entry_snapshot(uuid) from public,anon,authenticated;
revoke execute on function get_tournament_entry_state(uuid),update_tournament_settings(uuid,jsonb,integer,jsonb),save_bracket_layout(uuid,jsonb,jsonb),save_tournament_pairs(uuid,jsonb,boolean,jsonb,jsonb,integer) from public,anon,authenticated;
grant execute on function get_tournament_entry_state(uuid),update_tournament_settings(uuid,jsonb,integer,jsonb),save_bracket_layout(uuid,jsonb,jsonb),save_tournament_pairs(uuid,jsonb,boolean,jsonb,jsonb,integer) to authenticated;
notify pgrst,'reload schema';
-- Step 8: one MVCC snapshot for visible tournament data and derived standings.
-- SECURITY INVOKER deliberately retains table RLS and column grants.
revoke select on public.tournaments from anon, authenticated;
grant select (
  id, name, slug, description, sport, format, category, set_format, status,
  is_public, doubles_pairing_mode, format_config, scoring_config, created_by,
  created_at, updated_at, settings_revision, publish_contact
) on public.tournaments to anon, authenticated;
create or replace function public.tournament_public_contact(p_tournament_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select case when t.id is null then '{}'::jsonb
  when is_tournament_admin(t.id) or (t.is_public and t.publish_contact) then jsonb_build_object('phone',t.contact_phone,'email',t.contact_email,'published',t.publish_contact)
  else '{}'::jsonb end from tournaments t where t.id=p_tournament_id;
$$;
revoke execute on function public.tournament_public_contact(uuid) from public;
grant execute on function public.tournament_public_contact(uuid) to anon, authenticated;
create or replace function get_tournament_sync_state(p_tournament_id uuid)
returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object(
  'tournament', jsonb_build_object('id',t.id,'name',t.name,'slug',t.slug,'description',t.description,
   'sport',t.sport,'format',t.format,'category',t.category,'status',t.status,'set_format',t.set_format,
   'is_public',t.is_public,'doubles_pairing_mode',t.doubles_pairing_mode,'format_config',t.format_config,
   'scoring_config',t.scoring_config,'settings_revision',t.settings_revision,
   'publish_contact',coalesce((tournament_public_contact(t.id)->>'published')::boolean,false),
   'contact_phone',tournament_public_contact(t.id)->>'phone','contact_email',tournament_public_contact(t.id)->>'email'),
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
revoke execute on function get_tournament_sync_state(uuid) from public, anon, authenticated;
grant execute on function get_tournament_sync_state(uuid) to anon, authenticated;
-- Group structure can change without a match update (e.g. an empty group).
do $$
begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='groups') then
  alter publication supabase_realtime add table groups;
 end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='group_entries') then
  alter publication supabase_realtime add table group_entries;
 end if;
end $$;
notify pgrst,'reload schema';
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
-- Stage A+: the waitlist status. Kept in its own file because a value added
-- with ALTER TYPE cannot be used inside the same transaction.
alter type public.registration_status add value if not exists 'waitlisted';
-- Stage A+: waitlist. When approved entries fill the capacity and the organizer
-- enabled the waitlist, public registration continues as `waitlisted` entries.
-- They never take a seat and stay invisible to the public until approved.
alter table public.tournaments add column if not exists waitlist_enabled boolean not null default false;
revoke select on public.tournaments from anon, authenticated;
grant select (
  id, name, slug, description, sport, format, category, set_format, status,
  is_public, doubles_pairing_mode, format_config, scoring_config, created_by,
  created_at, updated_at, settings_revision, publish_contact,
  registration_capacity, capacity_public, registration_deadline,
  entry_fee_mode, entry_fee_minor, entry_fee_currency, entry_fee_unit, waitlist_enabled
) on public.tournaments to anon, authenticated;

-- One active application per contact, including a waiting one.
drop index if exists idx_entries_active_contact;
create unique index idx_entries_active_contact
  on entries (tournament_id, phone_or_email)
  where status in ('pending', 'approved', 'waitlisted');

create or replace function public.tournament_registration_state(p_tournament_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare t tournaments%rowtype; v_occ integer; v_full boolean; v_deadline boolean; v_reason text; v_waitlist integer;
begin
 select * into t from tournaments where id=p_tournament_id;
 if t.id is null then return null; end if;
 if not (t.is_public or is_tournament_admin(t.id) or can_live_score(t.id)) then return null; end if;
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

-- The result now tells the applicant whether they were queued; an anonymous
-- caller cannot read its own row to find out.
drop function if exists register_entry(text, tournament_category, text, text, text, text);
create function register_entry(
  p_slug text,
  p_entry_type tournament_category,
  p_phone_or_email text,
  p_member_one text,
  p_member_two text default null,
  p_display_name text default null
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
revoke execute on function register_entry(text, tournament_category, text, text, text, text) from public;
grant execute on function register_entry(text, tournament_category, text, text, text, text) to anon, authenticated;

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
   'registration_capacity','capacity_public','registration_deadline','entry_fee_mode','entry_fee_minor','entry_fee_currency','entry_fee_unit','waitlist_enabled']) then raise exception 'Unsupported settings field'; end if;
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
  waitlist_enabled=v_new.waitlist_enabled
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
   'waitlist_enabled',t.waitlist_enabled),
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
-- Stage B: manual schedule. Courts and per-match assignments in a hybrid time
-- model (fixed time, "not before", or a place in a court queue). Assignments
-- are drafted, checked for conflicts on the server and published explicitly;
-- the public page only ever sees published rows.
create table if not exists public.courts (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tournament_id, name)
);
create index if not exists idx_courts_tournament on courts (tournament_id, sort_order);

-- Kept apart from matches: to_jsonb(matches) is public, a draft must not be.
create table if not exists public.match_schedule (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  match_id uuid not null references matches (id) on delete cascade,
  state text not null check (state in ('draft', 'published')),
  court_id uuid references courts (id) on delete set null,
  scheduled_at timestamptz,
  time_kind text check (time_kind in ('fixed', 'not_before')),
  queue_order integer check (queue_order is null or queue_order > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, state),
  check ((scheduled_at is null) = (time_kind is null)),
  check (court_id is not null or scheduled_at is not null)
);
create index if not exists idx_match_schedule_tournament on match_schedule (tournament_id, state);
drop trigger if exists trg_match_schedule_updated_at on match_schedule;
create trigger trg_match_schedule_updated_at before update on match_schedule for each row execute function set_updated_at();

alter table public.tournaments
  add column if not exists schedule_config jsonb not null default '{}'::jsonb,
  add column if not exists schedule_published_at timestamptz;
revoke select on public.tournaments from anon, authenticated;
grant select (
  id, name, slug, description, sport, format, category, set_format, status,
  is_public, doubles_pairing_mode, format_config, scoring_config, created_by,
  created_at, updated_at, settings_revision, publish_contact,
  registration_capacity, capacity_public, registration_deadline,
  entry_fee_mode, entry_fee_minor, entry_fee_currency, entry_fee_unit, waitlist_enabled,
  schedule_config, schedule_published_at
) on public.tournaments to anon, authenticated;

alter table courts enable row level security;
alter table match_schedule enable row level security;
drop policy if exists courts_public_or_admin_select on courts;
create policy courts_public_or_admin_select on courts
for select
using (
  exists (
    select 1 from tournaments t
    where t.id = courts.tournament_id
      and (t.is_public = true or is_tournament_admin(t.id) or can_live_score(t.id))
  )
);
drop policy if exists match_schedule_select on match_schedule;
create policy match_schedule_select on match_schedule
for select
using (
  exists (
    select 1 from tournaments t
    where t.id = match_schedule.tournament_id
      and (is_tournament_admin(t.id)
        or (match_schedule.state = 'published' and (t.is_public = true or can_live_score(t.id))))
  )
);
-- Writes only through the RPCs below.
revoke insert, update, delete on public.courts, public.match_schedule from public, anon, authenticated;
grant select on public.courts, public.match_schedule to anon, authenticated;
-- DELETE payloads carry tournament_id so clients can scope them.
alter table public.courts replica identity full;
alter table public.match_schedule replica identity full;
do $$
begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='courts') then
  alter publication supabase_realtime add table courts;
 end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='match_schedule') then
  alter publication supabase_realtime add table match_schedule;
 end if;
end $$;

-- Conflicts against the current draft. Hard ones block, soft ones warn.
-- Without match durations only identical fixed times collide; the minimum
-- rest is measured between fixed start times.
create or replace function public.match_schedule_conflicts(p_match_id uuid, p_court_id uuid, p_scheduled_at timestamptz, p_time_kind text, p_queue_order integer)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare m matches%rowtype; v_config jsonb; v_rest integer; v_out jsonb:='[]'::jsonb; r record; v_entries uuid[];
begin
 select * into m from matches where id=p_match_id;
 if m.id is null then raise exception 'Match not found'; end if;
 select schedule_config into v_config from tournaments where id=m.tournament_id;
 v_rest:=coalesce(nullif(v_config->>'min_rest_minutes','')::integer,0);
 v_entries:=array_remove(array[m.side_a_entry_id,m.side_b_entry_id],null);
 if p_court_id is not null and not exists(select 1 from courts c where c.id=p_court_id and c.tournament_id=m.tournament_id) then
  raise exception 'schedule.invalidCourt';
 end if;
 if exists(select 1 from live_scores l where l.match_id=m.id and l.status='active') then
  v_out:=v_out||jsonb_build_object('kind','match_live','severity','hard');
 end if;
 if m.status='finished' then
  v_out:=v_out||jsonb_build_object('kind','match_finished','severity','hard');
 end if;
 if p_court_id is not null and p_queue_order is not null then
  for r in select s.match_id from match_schedule s where s.tournament_id=m.tournament_id and s.state='draft' and s.match_id<>m.id
    and s.court_id=p_court_id and s.queue_order=p_queue_order loop
   v_out:=v_out||jsonb_build_object('kind','queue_taken','severity','hard','match_id',r.match_id,'court_id',p_court_id);
  end loop;
 end if;
 if p_time_kind='fixed' and p_scheduled_at is not null then
  if p_court_id is not null then
   for r in select s.match_id from match_schedule s where s.tournament_id=m.tournament_id and s.state='draft' and s.match_id<>m.id
     and s.court_id=p_court_id and s.time_kind='fixed' and s.scheduled_at=p_scheduled_at loop
    v_out:=v_out||jsonb_build_object('kind','court_busy','severity','hard','match_id',r.match_id,'court_id',p_court_id);
   end loop;
  end if;
  for r in select s.match_id,s.scheduled_at,x.entry_id from match_schedule s join matches o on o.id=s.match_id
    join lateral (select unnest(array[o.side_a_entry_id,o.side_b_entry_id]) as entry_id) x on x.entry_id=any(v_entries)
    where s.tournament_id=m.tournament_id and s.state='draft' and s.match_id<>m.id and s.time_kind='fixed' and s.scheduled_at is not null loop
   if r.scheduled_at=p_scheduled_at then
    v_out:=v_out||jsonb_build_object('kind','participant_busy','severity','hard','match_id',r.match_id,'entry_id',r.entry_id);
   elsif v_rest>0 and abs(extract(epoch from (r.scheduled_at-p_scheduled_at)))<v_rest*60 then
    v_out:=v_out||jsonb_build_object('kind','rest_short','severity','soft','match_id',r.match_id,'entry_id',r.entry_id,
      'minutes',floor(abs(extract(epoch from (r.scheduled_at-p_scheduled_at)))/60));
   end if;
  end loop;
 end if;
 if p_scheduled_at is not null then
  -- Feeder matches must come earlier; matches fed by this one must come later.
  for r in select s.match_id from match_schedule s join matches f on f.id=s.match_id
    where s.state='draft' and s.scheduled_at is not null and (f.next_match_id=m.id or f.loser_next_match_id=m.id) and s.scheduled_at>=p_scheduled_at loop
   v_out:=v_out||jsonb_build_object('kind','order_violation','severity','soft','match_id',r.match_id);
  end loop;
  for r in select s.match_id from match_schedule s where s.state='draft' and s.scheduled_at is not null
    and s.match_id in (m.next_match_id,m.loser_next_match_id) and s.scheduled_at<=p_scheduled_at loop
   v_out:=v_out||jsonb_build_object('kind','order_violation','severity','soft','match_id',r.match_id);
  end loop;
 end if;
 return v_out;
end;
$$;
revoke execute on function public.match_schedule_conflicts(uuid,uuid,timestamptz,text,integer) from public, anon, authenticated;

create or replace function public.check_match_schedule(p_match_id uuid, p_court_id uuid, p_scheduled_at timestamptz, p_time_kind text, p_queue_order integer)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tid uuid;
begin
 select tournament_id into v_tid from matches where id=p_match_id;
 if v_tid is null or not is_tournament_admin(v_tid) then raise exception 'Not allowed'; end if;
 return match_schedule_conflicts(p_match_id,p_court_id,p_scheduled_at,p_time_kind,p_queue_order);
end;
$$;

create or replace function public.set_match_schedule(p_match_id uuid, p_court_id uuid, p_scheduled_at timestamptz, p_time_kind text, p_queue_order integer, p_ignore_warnings boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tid uuid; v_conflicts jsonb; v_row match_schedule%rowtype;
begin
 select tournament_id into v_tid from matches where id=p_match_id;
 if v_tid is null or not is_tournament_admin(v_tid) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=v_tid for update;
 if p_time_kind is not null and p_time_kind<>all(array['fixed','not_before']) then raise exception 'schedule.invalidAssignment'; end if;
 if (p_scheduled_at is null)<>(p_time_kind is null) then raise exception 'schedule.invalidAssignment'; end if;
 if p_court_id is null and p_scheduled_at is null then raise exception 'schedule.invalidAssignment'; end if;
 if p_queue_order is not null and (p_court_id is null or p_queue_order<=0) then raise exception 'schedule.invalidAssignment'; end if;
 v_conflicts:=match_schedule_conflicts(p_match_id,p_court_id,p_scheduled_at,p_time_kind,p_queue_order);
 if exists(select 1 from jsonb_array_elements(v_conflicts) c where c->>'severity'='hard') then raise exception 'schedule.conflict'; end if;
 if not p_ignore_warnings and jsonb_array_length(v_conflicts)>0 then raise exception 'schedule.warnings'; end if;
 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  values(v_tid,p_match_id,'draft',p_court_id,p_scheduled_at,p_time_kind,p_queue_order)
  on conflict(match_id,state) do update set court_id=excluded.court_id,scheduled_at=excluded.scheduled_at,
   time_kind=excluded.time_kind,queue_order=excluded.queue_order
  returning * into v_row;
 return jsonb_build_object('schedule',to_jsonb(v_row),'conflicts',v_conflicts);
end;
$$;

create or replace function public.clear_match_schedule(p_match_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_tid uuid;
begin
 select tournament_id into v_tid from matches where id=p_match_id;
 if v_tid is null or not is_tournament_admin(v_tid) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=v_tid for update;
 delete from match_schedule where match_id=p_match_id and state='draft';
end;
$$;

-- All draft conflicts at once, for the organizer's summary.
create or replace function public.schedule_draft_conflicts(p_tournament_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r record; v_out jsonb:='[]'::jsonb; c jsonb;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 for r in select * from match_schedule where tournament_id=p_tournament_id and state='draft' order by match_id loop
  c:=match_schedule_conflicts(r.match_id,r.court_id,r.scheduled_at,r.time_kind,r.queue_order);
  if jsonb_array_length(c)>0 then v_out:=v_out||jsonb_build_object('match_id',r.match_id,'conflicts',c); end if;
 end loop;
 return v_out;
end;
$$;

-- Replace the court list. Removed courts leave their matches without a court.
create or replace function public.save_courts(p_tournament_id uuid, p_courts jsonb, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_t tournaments%rowtype; item jsonb; v_keep uuid[]:='{}'; v_id uuid; v_name text; v_names text[]:='{}'; v_pos integer:=0;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_t from tournaments where id=p_tournament_id for update;
 if v_t.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_t.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_courts) is distinct from 'array' then raise exception 'schedule.invalidCourts'; end if;
 for item in select value from jsonb_array_elements(p_courts) loop
  v_name:=btrim(coalesce(item->>'name',''));
  if v_name='' or length(v_name)>60 or v_name=any(v_names) then raise exception 'schedule.invalidCourts'; end if;
  v_names:=array_append(v_names,v_name);
  v_pos:=v_pos+1;
  v_id:=nullif(item->>'id','')::uuid;
  if v_id is not null and exists(select 1 from courts where id=v_id and tournament_id=p_tournament_id) then
   update courts set name=v_name,sort_order=v_pos where id=v_id;
  else
   insert into courts(tournament_id,name,sort_order) values(p_tournament_id,v_name,v_pos) returning id into v_id;
  end if;
  v_keep:=array_append(v_keep,v_id);
 end loop;
 -- A queue-only row cannot survive losing its court: the table requires a
 -- court or a time, and the foreign key would null the court out from under
 -- the check. Timed rows keep their time and only lose the court and its
 -- place in the queue, which is what the hint under the editor promises.
 delete from match_schedule where tournament_id=p_tournament_id
  and court_id is not null and not (court_id=any(v_keep)) and scheduled_at is null;
 update match_schedule set queue_order=null where tournament_id=p_tournament_id
  and court_id is not null and not (court_id=any(v_keep)) and queue_order is not null;
 delete from courts where tournament_id=p_tournament_id and not (id=any(v_keep));
 -- Any settings-level change bumps the revision so stale forms are rejected.
 update tournaments set schedule_config=schedule_config where id=p_tournament_id;
 return coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.name,c.id) from courts c where c.tournament_id=p_tournament_id),'[]'::jsonb);
exception when unique_violation then raise exception 'schedule.invalidCourts';
end;
$$;

create or replace function public.publish_schedule(p_tournament_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r record; v_count integer;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=p_tournament_id for update;
 for r in select * from match_schedule where tournament_id=p_tournament_id and state='draft' loop
  if exists(select 1 from jsonb_array_elements(match_schedule_conflicts(r.match_id,r.court_id,r.scheduled_at,r.time_kind,r.queue_order)) c
            where c->>'severity'='hard' and c->>'kind' not in ('match_finished','match_live')) then
   raise exception 'schedule.conflict';
  end if;
 end loop;
 delete from match_schedule where tournament_id=p_tournament_id and state='published';
 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  select tournament_id,match_id,'published',court_id,scheduled_at,time_kind,queue_order
  from match_schedule where tournament_id=p_tournament_id and state='draft';
 get diagnostics v_count=row_count;
 update tournaments set schedule_published_at=now() where id=p_tournament_id;
 return jsonb_build_object('published',v_count);
end;
$$;

-- Discard draft edits: the draft becomes a copy of what is published.
create or replace function public.revert_schedule_draft(p_tournament_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=p_tournament_id for update;
 delete from match_schedule where tournament_id=p_tournament_id and state='draft';
 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  select tournament_id,match_id,'draft',court_id,scheduled_at,time_kind,queue_order
  from match_schedule where tournament_id=p_tournament_id and state='published';
 get diagnostics v_count=row_count;
 return jsonb_build_object('restored',v_count);
end;
$$;

-- Drag-and-drop on the court board. set_match_schedule writes one row per call
-- and queue_taken is a hard conflict, so renumbering a queue from the client
-- would have to pass through a duplicate (court_id, queue_order). Here the whole
-- queue is renumbered under the same per-tournament lock, and rows that only
-- shift a number are not re-validated: neither their court nor their time moves.
create or replace function public.place_match_in_court_queue(
  p_match_id uuid, p_court_id uuid, p_order uuid[], p_ignore_warnings boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tid uuid; v_row match_schedule%rowtype; v_old_court uuid; v_conflicts jsonb; v_moved uuid[];
begin
 select tournament_id into v_tid from matches where id=p_match_id;
 if v_tid is null or not is_tournament_admin(v_tid) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=v_tid for update;
 if p_court_id is null or not exists(select 1 from courts c where c.id=p_court_id and c.tournament_id=v_tid) then
  raise exception 'schedule.invalidCourt';
 end if;
 if p_order is null or coalesce(array_length(p_order,1),0)=0
    or not (p_match_id=any(p_order))
    or array_length(p_order,1)<>(select count(distinct x) from unnest(p_order) x)
    or exists(select 1 from unnest(p_order) x where not exists(select 1 from matches m where m.id=x and m.tournament_id=v_tid))
 then raise exception 'schedule.invalidAssignment'; end if;

 select * into v_row from match_schedule where match_id=p_match_id and state='draft';
 v_old_court:=v_row.court_id;
 -- queue_taken cannot apply: this function is the only assigner of the numbers
 -- and they are unique by construction, so the check runs without one.
 v_conflicts:=match_schedule_conflicts(p_match_id,p_court_id,v_row.scheduled_at,v_row.time_kind,null);
 if exists(select 1 from jsonb_array_elements(v_conflicts) c where c->>'severity'='hard') then raise exception 'schedule.conflict'; end if;
 if not p_ignore_warnings and jsonb_array_length(v_conflicts)>0 then raise exception 'schedule.warnings'; end if;

 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  values(v_tid,p_match_id,'draft',p_court_id,v_row.scheduled_at,v_row.time_kind,null)
  on conflict(match_id,state) do update set court_id=excluded.court_id;

 -- Renumber the target queue 1..N. Rows the caller did not list keep a place
 -- after the listed ones, so a stale board never discards another organizer's
 -- work. Rows without a number stay unnumbered: they are the timed head.
 with wanted as (select x.match_id, x.ord from unnest(p_order) with ordinality x(match_id,ord)),
 target as (
  select s.match_id,
         (case when w.ord is null then 1 else 0 end) as tail,
         coalesce(w.ord, s.queue_order) as ord
  from match_schedule s left join wanted w on w.match_id=s.match_id
  where s.tournament_id=v_tid and s.state='draft' and s.court_id=p_court_id
    and (w.ord is not null or s.queue_order is not null)),
 numbered as (select match_id, row_number() over (order by tail, ord, match_id) n from target),
 upd as (update match_schedule s set queue_order=numbered.n from numbered
   where s.match_id=numbered.match_id and s.state='draft' and s.queue_order is distinct from numbered.n
   returning s.match_id)
 select coalesce(array_agg(match_id),'{}'::uuid[]) into v_moved from upd;

 -- A live or finished match never changes its place in a queue; raising here
 -- rolls the whole renumbering back, so a column is never left half-moved.
 if exists(select 1 from matches m where m.id=any(v_moved) and m.id<>p_match_id
   and (m.status='finished' or exists(select 1 from live_scores l where l.match_id=m.id and l.status='active')))
 then raise exception 'schedule.queueLocked'; end if;

 -- Close the gap the match left on its previous court. Compaction keeps the
 -- relative order, so it is not a change of place and needs no extra check.
 if v_old_court is not null and v_old_court<>p_court_id then
  with numbered as (select s.match_id, row_number() over (order by s.queue_order, s.match_id) n
   from match_schedule s where s.tournament_id=v_tid and s.state='draft' and s.court_id=v_old_court and s.queue_order is not null)
  update match_schedule s set queue_order=numbered.n from numbered
   where s.match_id=numbered.match_id and s.state='draft' and s.queue_order is distinct from numbered.n;
 end if;

 select * into v_row from match_schedule where match_id=p_match_id and state='draft';
 return jsonb_build_object('schedule',to_jsonb(v_row),'conflicts',v_conflicts);
end;
$$;

revoke execute on function public.check_match_schedule(uuid,uuid,timestamptz,text,integer),
  public.set_match_schedule(uuid,uuid,timestamptz,text,integer,boolean), public.clear_match_schedule(uuid),
  public.schedule_draft_conflicts(uuid), public.save_courts(uuid,jsonb,integer),
  public.publish_schedule(uuid), public.revert_schedule_draft(uuid),
  public.place_match_in_court_queue(uuid,uuid,uuid[],boolean) from public, anon, authenticated;
grant execute on function public.check_match_schedule(uuid,uuid,timestamptz,text,integer),
  public.set_match_schedule(uuid,uuid,timestamptz,text,integer,boolean), public.clear_match_schedule(uuid),
  public.schedule_draft_conflicts(uuid), public.save_courts(uuid,jsonb,integer),
  public.publish_schedule(uuid), public.revert_schedule_draft(uuid),
  public.place_match_in_court_queue(uuid,uuid,uuid[],boolean) to authenticated;

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
   'schedule_config']) then raise exception 'Unsupported settings field'; end if;
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
  waitlist_enabled=v_new.waitlist_enabled,schedule_config=v_new.schedule_config
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
   'waitlist_enabled',t.waitlist_enabled,'schedule_config',t.schedule_config,'schedule_published_at',t.schedule_published_at),
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
notify pgrst, 'reload schema';
-- Stage D: access. The `counter` role becomes "results only": it keeps live
-- scoring and additionally saves, stops and corrects results. Ownership can be
-- granted or removed only by an owner and the last owner cannot be lost.
-- Visibility gets three explicit modes; `is_public` stays the RLS gate and is
-- kept in sync by a trigger, so no policy changes.

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
  where email = lower(trim(p_email));

  if v_user_id is null then
    raise exception 'User with email % not found', p_email;
  end if;

  perform 1 from tournaments where id = p_tournament_id for update;
  select role into v_current from tournament_admins where tournament_id = p_tournament_id and user_id = v_user_id;
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
declare
  v_caller text;
  v_target tournament_admins%rowtype;
  v_owners integer;
begin
  v_caller := get_my_tournament_role(p_tournament_id);
  if v_caller is null or v_caller not in ('owner', 'editor') then
    raise exception 'Not authorized';
  end if;
  perform 1 from tournaments where id = p_tournament_id for update;
  select * into v_target from tournament_admins where id = p_admin_id and tournament_id = p_tournament_id;
  if v_target.id is null then
    return;
  end if;
  if v_target.role = 'owner' then
    if v_caller <> 'owner' then
      raise exception 'access.ownerOnly';
    end if;
    select count(*) into v_owners from tournament_admins where tournament_id = p_tournament_id and role = 'owner';
    if v_owners <= 1 then
      raise exception 'access.lastOwner';
    end if;
  end if;

  delete from tournament_admins where id = v_target.id;
end;
$$;

-- Membership changes go through the RPCs above only.
revoke insert, update, delete on public.tournament_admins from public, anon, authenticated;

-- Three visibility modes. "link" is what every existing public tournament
-- already was: open to anyone holding the link, not listed anywhere.
alter table public.tournaments add column if not exists visibility text not null default 'link';
do $$
begin
 if not exists (select 1 from pg_constraint where conname='tournaments_visibility_check') then
  alter table public.tournaments add constraint tournaments_visibility_check check (visibility in ('public', 'link', 'private'));
 end if;
end $$;
-- Backfill without touching revisions or timestamps of existing rows.
alter table public.tournaments disable trigger trg_tournament_settings_revision;
alter table public.tournaments disable trigger trg_tournaments_updated_at;
update public.tournaments set visibility = 'private' where is_public = false and visibility = 'link';
alter table public.tournaments enable trigger trg_tournament_settings_revision;
alter table public.tournaments enable trigger trg_tournaments_updated_at;

-- is_public follows visibility; a bare is_public write (older clients,
-- create_tournament) still picks a matching mode.
create or replace function public.sync_tournament_visibility()
returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op = 'INSERT' then
  if new.is_public is false then new.visibility := 'private'; end if;
 elsif new.visibility is distinct from old.visibility then
  null;
 elsif new.is_public is distinct from old.is_public then
  new.visibility := case when new.is_public then (case when old.visibility = 'private' then 'link' else old.visibility end) else 'private' end;
 end if;
 new.is_public := new.visibility <> 'private';
 return new;
end;
$$;
revoke execute on function public.sync_tournament_visibility() from public, anon, authenticated;
drop trigger if exists trg_tournaments_visibility on tournaments;
create trigger trg_tournaments_visibility before insert or update on tournaments for each row execute function sync_tournament_visibility();

revoke select on public.tournaments from anon, authenticated;
grant select (
  id, name, slug, description, sport, format, category, set_format, status,
  is_public, doubles_pairing_mode, format_config, scoring_config, created_by,
  created_at, updated_at, settings_revision, publish_contact,
  registration_capacity, capacity_public, registration_deadline,
  entry_fee_mode, entry_fee_minor, entry_fee_currency, entry_fee_unit, waitlist_enabled,
  schedule_config, schedule_published_at, visibility
) on public.tournaments to anon, authenticated;

-- Results role: the four checks below now accept every scoring role.
create or replace function stop_live_match(p_match_id uuid, p_expected_revision integer default null)
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
  where m.id = p_match_id for update;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not can_live_score(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  select * into v_live
  from live_scores
  where match_id = p_match_id for update;

  if v_live.id is null then
    raise exception 'Live match not found';
  end if;

  if p_expected_revision is null or p_expected_revision<>v_live.revision then
    raise exception using errcode='P0001',message='scoringFlow.liveConflict';
  end if;
  if v_live.status = 'active' then
    update live_scores
    set status = 'stopped',
        revision = revision + 1
    where id = v_live.id
    returning * into v_live;
  end if;

  update matches set score_revision=score_revision+1 where id=p_match_id;
  return v_live;
end;
$$;

create or replace function write_match_sets_result(
  p_match_id uuid,
  p_sets jsonb,
  p_expected_revision integer default null,
  p_defer_bracket boolean default false
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
  v_sport sport;
  v_rules jsonb;
  v_rule jsonb;
  v_result integer;
  v_max_sets integer;
  v_set_count integer;
  v_expected_index integer := 1;
  v_field text;
  v_number numeric;
  v_complete boolean;
  v_required_wins integer;
  v_side_a_id uuid;
  v_side_b_id uuid;
  v_previous_winner uuid;
  v_new_winner uuid;
  v_a_wins integer := 0;
  v_b_wins integer := 0;
  v_item jsonb;
  v_revision integer;
  v_set_index integer;
  v_a_games integer;
  v_b_games integer;
begin
  select m.tournament_id,
         m.side_a_entry_id,
         m.side_b_entry_id,
         m.winner_entry_id,
         t.set_format,
         tennis_scoring_rules(t.scoring_config),
         t.sport,
         t.status
    into v_tournament_id,
         v_side_a_id,
         v_side_b_id,
         v_previous_winner,
         v_set_format,
         v_rules,
         v_sport,
         v_tournament_status
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id
  for update of m;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not can_live_score(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_sport not in ('tennis', 'padel') then
    raise exception 'Set scores are supported only for tennis and padel';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Scores can be entered only after the tournament starts';
  end if;

  if v_side_a_id is null or v_side_b_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;

  select score_revision into v_revision from matches where id=p_match_id;
  if exists(select 1 from live_scores where match_id=p_match_id and status='active') then
    raise exception using errcode='P0001',message='scoringFlow.liveBlocked';
  end if;
  if p_expected_revision is null or p_expected_revision<>v_revision then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
  end if;

  v_required_wins := case
    when v_set_format = 'best_of_5' then 3
    else 2
  end;

  v_max_sets := 2 * v_required_wins - 1;

  -- Validate the entire replacement before deleting sets or changing the graph.
  -- Only complete results are accepted; reset is a separate confirmed operation.
  if jsonb_typeof(p_sets) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Sets must be a JSON array';
  end if;
  v_set_count := jsonb_array_length(p_sets);
  if v_set_count > v_max_sets then
    raise exception using errcode = '22023', message = 'Too many sets for this match format';
  end if;

  for v_item in select value from jsonb_array_elements(p_sets) loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Each set must be an object with an index and both game scores';
    end if;
    foreach v_field in array array['set_index', 'side_a_games', 'side_b_games'] loop
      if jsonb_typeof(v_item->v_field) is distinct from 'number' then
        raise exception using errcode = '22023', message = 'Set index and game scores must be non-null JSON numbers';
      end if;
      v_number := (v_item->>v_field)::numeric;
      if v_number <> trunc(v_number)
         or v_number < (case when v_field = 'set_index' then 1 else 0 end)
         or v_number > (case when v_field = 'set_index' then v_max_sets else 2147483647 end) then
        raise exception using errcode = '22023', message = 'Set index or game score is outside the allowed integer range';
      end if;
    end loop;
    foreach v_field in array array['side_a_tiebreak','side_b_tiebreak'] loop
      if v_item ? v_field and v_item->v_field <> 'null'::jsonb then
        if jsonb_typeof(v_item->v_field) is distinct from 'number' then
          raise exception using errcode='22023',message='Tiebreak scores must be JSON integers';
        end if;
        v_number:=(v_item->>v_field)::numeric;
        if v_number<>trunc(v_number) or v_number<0 or v_number>2147483647 then
          raise exception using errcode='22023',message='Tiebreak score is outside the allowed integer range';
        end if;
      end if;
    end loop;
  end loop;

  -- Indices define chronology, independently of the JSON array order.
  for v_item in
    select value from jsonb_array_elements(p_sets)
    order by (value->>'set_index')::numeric
  loop
    v_set_index := (v_item->>'set_index')::numeric::integer;
    v_a_games := (v_item->>'side_a_games')::numeric::integer;
    v_b_games := (v_item->>'side_b_games')::numeric::integer;
    if v_set_index <> v_expected_index then
      raise exception using errcode = '22023', message = 'Set indices must be unique and contiguous starting at 1';
    end if;
    v_expected_index := v_expected_index + 1;

    if v_a_wins = v_required_wins or v_b_wins = v_required_wins then
      raise exception using errcode = '22023', message = 'No further sets are allowed after the match is won';
    end if;

    v_rule:=tennis_set_rule(v_rules,v_set_index,v_required_wins);
    v_result:=tennis_set_result(v_item,v_rule);
    if v_result=-1 then
      raise exception using errcode='22023',message='Invalid set or tiebreak score for the tournament rules';
    end if;
    v_complete:=v_result>0;
    if v_complete then
      if v_result=1 then v_a_wins:=v_a_wins+1; else v_b_wins:=v_b_wins+1; end if;
    else
      if v_set_index <> v_set_count then
        raise exception using errcode = '22023', message = 'Only the final entered set may be unfinished';
      end if;
    end if;
  end loop;

  if v_a_wins<v_required_wins and v_b_wins<v_required_wins then
    raise exception using errcode='22023',message='scoringFlow.finalRequired';
  end if;
  v_new_winner:=case when v_a_wins>=v_required_wins then v_side_a_id else v_side_b_id end;
  if not p_defer_bracket and v_previous_winner is distinct from v_new_winner then
    perform assert_score_correction_safe(p_match_id);
  end if;

  if not p_defer_bracket and exists(select 1 from matches where id=p_match_id and stage='group')
     and exists(select 1 from matches where tournament_id=v_tournament_id and stage='winners') then
    raise exception 'scoringFlow.downstreamStarted';
  end if;

  delete from match_sets where match_id = p_match_id;
  insert into match_sets (match_id,set_index,side_a_games,side_b_games,score_kind,side_a_tiebreak,side_b_tiebreak)
  select p_match_id,(value->>'set_index')::numeric::integer,
    (value->>'side_a_games')::numeric::integer,(value->>'side_b_games')::numeric::integer,
    tennis_set_rule(v_rules,(value->>'set_index')::numeric::integer,v_required_wins)->>'kind',
    (value->>'side_a_tiebreak')::numeric::integer,(value->>'side_b_tiebreak')::numeric::integer
  from jsonb_array_elements(p_sets);

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

  if not p_defer_bracket and v_previous_winner is not null and v_previous_winner is distinct from v_new_winner then
    perform clear_downstream(p_match_id, v_previous_winner);
  end if;

  if not p_defer_bracket and v_new_winner is not null and v_new_winner is distinct from v_previous_winner then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  -- A manual replacement becomes the next live baseline. In-flight taps
  -- carry the old revision and cannot restore the pre-edit score.
  update live_scores set state=tennis_live_state(p_match_id,v_rules,v_required_wins),history='[]'::jsonb,
    status=case when v_new_winner is null then 'stopped' else 'finished' end,revision=revision+1
  where match_id=p_match_id;

  -- status transitions are managed explicitly via the admin UI

  return v_new_winner;
end;
$$;

create or replace function write_football_result(
  p_match_id uuid,
  p_a_goals integer,
  p_b_goals integer,
  p_a_pens integer default null,
  p_b_pens integer default null,
  p_expected_revision integer default null,
  p_defer_bracket boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status tournament_status;
  v_sport sport;
  v_format tournament_format;
  v_stage match_stage;
  v_side_a uuid;
  v_side_b uuid;
  v_prev_winner uuid;
  v_new_winner uuid;
  v_draw_allowed boolean;
begin
  select m.tournament_id, t.status, t.sport, t.format, m.stage,
         m.side_a_entry_id, m.side_b_entry_id, m.winner_entry_id
    into v_tournament_id, v_status, v_sport, v_format, v_stage,
         v_side_a, v_side_b, v_prev_winner
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id for update of m;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;
  if not can_live_score(v_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if v_sport <> 'football' then
    raise exception 'Goal scores are supported only for football';
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

  if p_expected_revision is null or p_expected_revision<>(select score_revision from matches where id=p_match_id) then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
  end if;
  if (p_a_pens is not null and p_a_pens<0) or (p_b_pens is not null and p_b_pens<0) then raise exception 'Valid penalty counts required'; end if;
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

  if not p_defer_bracket and v_prev_winner is distinct from v_new_winner then
    perform assert_score_correction_safe(p_match_id);
  end if;
  if not p_defer_bracket and exists(select 1 from matches where id=p_match_id and stage='group')
     and exists(select 1 from matches where tournament_id=v_tournament_id and stage='winners') then
    raise exception 'scoringFlow.downstreamStarted';
  end if;

  update matches
  set side_a_score = p_a_goals,
      side_b_score = p_b_goals,
      side_a_pens = p_a_pens,
      side_b_pens = p_b_pens,
      winner_entry_id = v_new_winner,
      status = 'finished'::match_status
  where id = p_match_id;

  if not p_defer_bracket and v_prev_winner is not null and v_prev_winner is distinct from v_new_winner then
    perform clear_downstream(p_match_id, v_prev_winner);
  end if;

  if not p_defer_bracket and v_new_winner is not null and v_new_winner is distinct from v_prev_winner then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  return v_new_winner;
end;
$$;

create or replace function get_match_correction_preview(p_match_id uuid,p_result jsonb,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare m matches%rowtype; t tournaments%rowtype; v_ids uuid[]; v_data jsonb; v_state jsonb; v_group boolean; v_token text;
begin
  select * into m from matches where id=p_match_id;
  if m.id is null then raise exception 'Match not found'; end if;
  if not can_live_score(m.tournament_id) then raise exception 'Not allowed'; end if;
  select * into t from tournaments where id=m.tournament_id for share nowait;
  if t.status<>'in_progress' then raise exception 'Scores can be entered only after the tournament starts'; end if;
  -- Corrections are rare. Short NOWAIT locks avoid deadlocks with point RPCs
  -- (which already lock their match before the live row) and bracket edits.
  perform 1 from matches where tournament_id=m.tournament_id order by id for update nowait;
  perform 1 from live_scores where tournament_id=m.tournament_id order by match_id for update nowait;
  select * into m from matches where id=p_match_id;
  if m.id is null or p_expected_revision is null or m.score_revision<>p_expected_revision then raise exception 'scoringFlow.conflict'; end if;
  if exists(select 1 from live_scores where match_id=m.id and status='active') then raise exception 'scoringFlow.liveBlocked'; end if;
  if jsonb_typeof(p_result) is distinct from 'object' then raise exception 'Invalid result'; end if;
  v_group:=m.stage='group' and t.format='groups_playoff' and exists(select 1 from matches where tournament_id=t.id and stage='winners');
  if v_group then
    select coalesce(array_agg(id order by id),'{}') into v_ids from matches where tournament_id=t.id and stage='winners';
  else v_ids:=correction_descendants(m.id); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',d.id,'stage',d.stage,'round_number',d.round_number,'match_number',d.match_number,
    'side_a_entry_id',d.side_a_entry_id,'side_b_entry_id',d.side_b_entry_id,
    'side_a_name',a.display_name,'side_b_name',b.display_name,
    'side_a_score',d.side_a_score,'side_b_score',d.side_b_score,
    'side_a_pens',d.side_a_pens,'side_b_pens',d.side_b_pens,
    'status',d.status,'live_status',l.status,
    'has_result',d.status='finished' or d.winner_entry_id is not null or d.side_a_score is not null or d.side_b_score is not null or l.id is not null
      or exists(select 1 from match_sets where match_id=d.id)
  ) order by d.stage,d.round_number,d.match_number),'[]') into v_data
  from matches d left join entries a on a.id=d.side_a_entry_id left join entries b on b.id=d.side_b_entry_id
  left join live_scores l on l.match_id=d.id where d.id=any(v_ids);
  -- The token binds the submitted result AND every relevant row. Group reseeding
  -- also depends on the other group scores, qualifiers and tournament settings.
  select jsonb_build_object('tournament',to_jsonb(t),'result',p_result,
    'matches',(select jsonb_agg(to_jsonb(x) order by x.id) from matches x where case when v_group then x.tournament_id=t.id else x.id=any(v_ids||m.id) end),
    'sets',(select jsonb_agg(to_jsonb(x) order by x.match_id,x.set_index) from match_sets x join matches d on d.id=x.match_id where case when v_group then d.tournament_id=t.id else d.id=any(v_ids||m.id) end),
    'live',(select jsonb_agg(to_jsonb(x) order by x.match_id) from live_scores x where x.match_id=any(v_ids||m.id)),
    'groups',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from groups x where x.tournament_id=t.id) end,
    'qualifiers',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from group_entries x join groups g on g.id=x.group_id where g.tournament_id=t.id) end
  ) into v_state;
  v_token:=encode(extensions.digest(v_state::text,'sha256'),'hex');
  return jsonb_build_object('token',v_token,'matches',v_data,'reseed_playoff',v_group,
    'blocked_live',exists(select 1 from live_scores where match_id=any(v_ids) and status='active'));
exception when lock_not_available or deadlock_detected then
  raise exception 'scoringFlow.correctionConflict';
end;
$$;

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
 if v_new.visibility is null or v_new.visibility<>all(array['public','link','private']) then raise exception 'access.invalidVisibility'; end if;
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
   'waitlist_enabled',t.waitlist_enabled,'schedule_config',t.schedule_config,'schedule_published_at',t.schedule_published_at,'visibility',t.visibility),
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
notify pgrst, 'reload schema';
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
-- The page password is a code the organizer hands to participants, not a login
-- credential, and they have to be able to read it back to share it again. A
-- bcrypt hash cannot be shown, so the code is kept beside it. The column is
-- deliberately outside the tournaments select grant, so no API role can read it.
alter table public.tournaments add column if not exists access_password_plain text;

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

-- Owners and editors read the code they set. A counter runs results only and
-- gets nothing, like everyone else. Passwords set before this column existed
-- return null: the hash they were stored as cannot be turned back into text.
create or replace function public.tournament_password(p_tournament_id uuid)
returns text language sql stable security definer set search_path=public as $$
 select case when is_tournament_admin(t.id) then t.access_password_plain end from tournaments t where t.id=p_tournament_id;
$$;
-- Supabase grants execute on new functions to anon by default, and revoking
-- from PUBLIC does not take a direct grant away. This one hands out a secret,
-- so the privilege itself is kept off the anonymous role, not just the answer.
revoke execute on function public.tournament_password(uuid) from public, anon, authenticated;
grant execute on function public.tournament_password(uuid) to authenticated;

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

-- Only an owner may delete a tournament. Editors keep every other management
-- right (settings, entries, bracket, schedule, assistants); the role matrix shown
-- to organizers (src/lib/access.js) promises the same split on the server and in
-- Realtime, so the DELETE policy moves from is_tournament_admin to an owner check.
-- Safe to re-run: the helper is replaced, the policy is dropped and recreated.
create or replace function public.is_tournament_owner(p_tournament_id uuid)
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
      and ta.role = 'owner'
  );
$$;

drop policy if exists tournaments_delete_admin on tournaments;
create policy tournaments_delete_admin on tournaments
for delete
to authenticated
using (is_tournament_owner(id));

notify pgrst, 'reload schema';
-- Registration collects a phone AND an email as two separate required fields.
-- `entries.phone_or_email` stays as the legacy single contact and keeps its
-- unique index, so older rows and the admin "add entry" form are unaffected.
-- The two new columns hold the parsed values; a trigger keeps every insert
-- path consistent. Safe to re-run.

alter table entries add column if not exists contact_phone text;
alter table entries add column if not exists contact_email text;

-- Existing rows keep their single contact; it is classified by its shape.
-- Placeholders written by the admin form ("admin-entry-<uuid>@local.tenis")
-- are not real contacts and stay out of the new columns.
update entries
   set contact_email = lower(btrim(phone_or_email))
 where contact_email is null
   and phone_or_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
   and phone_or_email not like 'admin-entry-%@local.tenis';

update entries
   set contact_phone = btrim(phone_or_email)
 where contact_phone is null
   and phone_or_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
   and phone_or_email ~ '^\+?[0-9\s\-\(\)]{7,20}$';

-- Whatever writes an entry (RPC, admin form, manual SQL) ends up with the same
-- normalised columns: email lowercased, blanks turned into nulls.
create or replace function public.entries_fill_contacts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.contact_phone := nullif(btrim(coalesce(new.contact_phone, '')), '');
  new.contact_email := lower(nullif(btrim(coalesce(new.contact_email, '')), ''));

  if new.contact_email is null
     and new.phone_or_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     and new.phone_or_email not like 'admin-entry-%@local.tenis' then
    new.contact_email := lower(btrim(new.phone_or_email));
  end if;

  if new.contact_phone is null
     and new.phone_or_email ~ '^\+?[0-9\s\-\(\)]{7,20}$' then
    new.contact_phone := btrim(new.phone_or_email);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_entries_fill_contacts on entries;
create trigger trg_entries_fill_contacts
before insert or update of phone_or_email, contact_phone, contact_email on entries
for each row execute function public.entries_fill_contacts();

-- Lookup indexes only. Uniqueness stays on `phone_or_email`: normalising an
-- existing contact (case, punctuation) could collide with another old row, and
-- a unique index would then refuse to be created on a live database.
-- register_entry() rejects duplicates explicitly, across both fields.
create index if not exists idx_entries_active_email
  on entries (tournament_id, contact_email)
  where contact_email is not null and status in ('pending', 'approved', 'waitlisted');

create index if not exists idx_entries_active_phone
  on entries (tournament_id, regexp_replace(contact_phone, '\D', '', 'g'))
  where contact_phone is not null and status in ('pending', 'approved', 'waitlisted');

-- Registration with separate phone and email. The previous signature is
-- replaced rather than overloaded: the first seven parameters keep their names
-- and order, so a caller that still sends one combined contact keeps working
-- and no call becomes ambiguous.
drop function if exists register_entry(text, tournament_category, text, text, text, text, text);
drop function if exists register_entry(text, tournament_category, text, text, text, text, text, text, text);
create function register_entry(
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

  if exists (
    select 1
    from entries e
    where e.tournament_id = v_tournament.id
      and e.status in ('pending', 'approved', 'waitlisted')
      and (
        e.phone_or_email = v_contact
        or (v_email is not null and e.contact_email = v_email)
        or (
          v_phone is not null and e.contact_phone is not null
          and regexp_replace(e.contact_phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g')
        )
      )
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
  values (v_entry_id, p_member_one, 1);

  if p_entry_type = 'doubles' and p_member_two is not null and btrim(p_member_two) <> '' then
    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_id, p_member_two, 2);
  end if;

  return jsonb_build_object('id', v_entry_id, 'status', v_status);
end;
$$;
revoke execute on function register_entry(text, tournament_category, text, text, text, text, text, text, text) from public;
grant execute on function register_entry(text, tournament_category, text, text, text, text, text, text, text) to anon, authenticated;
-- Where the tournament is played: a written address and an optional point on
-- the map. The public page turns the point (or the address) into a route in the
-- viewer's navigator. Both coordinates are set together or not at all.
-- Safe to re-run.

alter table tournaments add column if not exists venue_address text;
alter table tournaments add column if not exists venue_lat double precision;
alter table tournaments add column if not exists venue_lng double precision;

alter table tournaments drop constraint if exists tournaments_venue_point_ck;
alter table tournaments add constraint tournaments_venue_point_ck check (
  (venue_lat is null) = (venue_lng is null)
  and (venue_lat is null or (venue_lat between -90 and 90 and venue_lng between -180 and 180))
);

-- The venue is public: it belongs to the same projection the public page reads.
revoke select on public.tournaments from anon, authenticated;
grant select (
  id, name, slug, description, sport, format, category, set_format, status,
  is_public, doubles_pairing_mode, format_config, scoring_config, created_by,
  created_at, updated_at, settings_revision, publish_contact,
  registration_capacity, capacity_public, registration_deadline,
  entry_fee_mode, entry_fee_minor, entry_fee_currency, entry_fee_unit, waitlist_enabled,
  schedule_config, schedule_published_at, visibility,
  venue_address, venue_lat, venue_lng
) on public.tournaments to anon, authenticated;

-- The venue can be set while creating the tournament. The previous signature is
-- dropped rather than overloaded: a call by parameter name would otherwise match
-- both functions.
drop function if exists create_tournament(text, text, text, sport, tournament_format, tournament_category, set_format, boolean, doubles_pairing_mode, jsonb, jsonb, text, text);
drop function if exists create_tournament(text, text, text, sport, tournament_format, tournament_category, set_format, boolean, doubles_pairing_mode, jsonb, jsonb, text, text, text, double precision, double precision);
create function create_tournament(
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
  p_scoring_config jsonb default '{}'::jsonb,
  p_contact_phone text default null,
  p_contact_email text default null,
  p_venue_address text default null,
  p_venue_lat double precision default null,
  p_venue_lng double precision default null
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
  v_address text := nullif(btrim(coalesce(p_venue_address, '')), '');
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;

  -- Sport must be enabled via feature flag (see FEATURE FLAGS section)
  if not is_feature_enabled('sport.' || p_sport::text) then
    raise exception 'Sport is disabled: %', p_sport using errcode = 'P0403';
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

  if v_address is not null and length(v_address) > 300 then
    raise exception 'venue.invalidAddress';
  end if;
  if (p_venue_lat is null) <> (p_venue_lng is null) then
    raise exception 'venue.invalidPoint';
  end if;
  if p_venue_lat is not null and (p_venue_lat < -90 or p_venue_lat > 90 or p_venue_lng < -180 or p_venue_lng > 180) then
    raise exception 'venue.invalidPoint';
  end if;

  insert into tournaments (
    name, slug, description, sport, format, category, set_format, status,
    is_public, doubles_pairing_mode, format_config, scoring_config,
    contact_phone, contact_email, venue_address, venue_lat, venue_lng, created_by
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
    nullif(btrim(coalesce(p_contact_phone, '')), ''),
    nullif(btrim(coalesce(p_contact_email, '')), ''),
    v_address,
    p_venue_lat,
    p_venue_lng,
    v_uid
  )
  returning id into v_id;

  insert into tournament_admins (tournament_id, user_id, role)
  values (v_id, v_uid, 'owner');

  return v_id;
end;
$$;
revoke execute on function create_tournament(text, text, text, sport, tournament_format, tournament_category, set_format, boolean, doubles_pairing_mode, jsonb, jsonb, text, text, text, double precision, double precision) from public;
grant execute on function create_tournament(text, text, text, sport, tournament_format, tournament_category, set_format, boolean, doubles_pairing_mode, jsonb, jsonb, text, text, text, double precision, double precision) to authenticated;

-- The venue joins the whitelisted settings: same CAS, same validation as above.
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
   'schedule_config','visibility','venue_address','venue_lat','venue_lng']) then raise exception 'Unsupported settings field'; end if;
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

-- The snapshot carries the venue to both the public page and the admin page.
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

notify pgrst, 'reload schema';

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

-- Knockout bracket fixes (single and double elimination).
--  * A manual draw follows the seeding (entries.seed_order, then created_at)
--    and places it in standard bracket positions: seeds 1 and 2 in opposite
--    halves, 1 v N, 2 v N-1…, and the BYEs go to the top seeds. The random
--    draw is unchanged.
--  * Draws of one tournament are serialized on its row, so parallel rebuilds
--    wait instead of failing on the match unique key.
--  * A started or completed tournament whose bracket has results cannot be
--    redrawn: that would silently erase the results.
--  * Rearranging players is checked on the server: first-round slots only
--    (matches no other match feeds), a permutation of the players already
--    there, never after the start or during live scoring. A BYE can be
--    rearranged too; its free pass follows the player.
-- generate_single_elim (reused by the group playoff) and generate_double_elim
-- keep their contracts: both still take a flat, already ordered seed array.
-- Safe to re-run: every function is replaced and its grants restated.

-- Standard seeded positions for the smallest power-of-two bracket that fits
-- the seeds: slot i holds seed positions[i] ([1,8,4,5,2,7,3,6] for eight), and
-- a seed beyond the field is a BYE (NULL), so free passes go to the top seeds.
-- Neighbouring slots form the first-round matches.
create or replace function knockout_seeded_slots(p_seeds uuid[])
returns uuid[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_count integer := coalesce(array_length(p_seeds, 1), 0);
  v_positions integer[] := array[1];
  v_next integer[];
  v_size integer := 1;
  v_seed integer;
  v_slots uuid[] := '{}';
begin
  while v_size < v_count loop
    v_next := '{}';
    foreach v_seed in array v_positions loop
      v_next := v_next || v_seed || (2 * v_size + 1 - v_seed);
    end loop;
    v_positions := v_next;
    v_size := v_size * 2;
  end loop;
  foreach v_seed in array v_positions loop
    v_slots := array_append(v_slots, case when v_seed <= v_count then p_seeds[v_seed] end);
  end loop;
  return v_slots;
end;
$$;
revoke execute on function knockout_seeded_slots(uuid[]) from public, anon, authenticated;

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
  v_tournament tournaments%rowtype;
  v_entry_ids uuid[];
  v_ordered_ids uuid[];
  v_slots uuid[] := '{}';
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
  v_seed_index integer := 1;
  v_byes integer;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  -- One draw at a time per tournament: a concurrent rebuild waits here and
  -- then replaces the committed bracket instead of racing on the unique key.
  select * into v_tournament from tournaments where id = p_tournament_id for update;
  if v_tournament.id is null then
    raise exception 'Tournament not found';
  end if;
  -- Redrawing deletes every match; once play has begun that would silently
  -- erase results (a BYE is not a result).
  if v_tournament.status in ('in_progress', 'completed') and (
    exists (
      select 1 from matches m
      where m.tournament_id = p_tournament_id
        and (m.side_a_score is not null or m.side_b_score is not null
          or m.side_a_pens is not null or m.side_b_pens is not null
          or (m.status = 'finished' and m.side_a_entry_id is not null and m.side_b_entry_id is not null))
    )
    or exists (select 1 from match_sets s join matches m on m.id = s.match_id where m.tournament_id = p_tournament_id)
    or exists (select 1 from live_scores l where l.tournament_id = p_tournament_id and l.status = 'active')
  ) then
    raise exception using errcode = '22023', message = 'drafts.bracketResultsLocked';
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

  if p_mode is null then
    raise exception 'Draw mode is required';
  end if;
  if p_manual_order is not null then
    if coalesce(array_ndims(p_manual_order), 1) <> 1
       or exists (select 1 from unnest(p_manual_order) x(id) where x.id is null or not (x.id = any(v_entry_ids)))
       or (select count(*) <> count(distinct id) from unnest(p_manual_order) x(id)) then
      raise exception 'Manual order must contain unique approved entries from this tournament';
    end if;
  end if;

  if p_mode = 'manual' then
    -- Seed list: a supplied order first, then the rest of the approved field
    -- by seeding (seed_order; unseeded and ties by entry time). The UI sends
    -- NULL and draws the organizer's seeding.
    select coalesce(array_agg(x.id order by x.position), '{}') into v_ordered_ids
    from unnest(p_manual_order) with ordinality x(id, position);

    select coalesce(v_ordered_ids, '{}') || coalesce(array_agg(e.id order by e.seed_order nulls last, e.created_at, e.id), '{}')
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

  -- Double elimination is built by a dedicated generator that pairs
  -- neighbouring seeds; a manual draw hands it the seeded positions. Other
  -- counts go through unchanged so the generator reports them.
  if v_tournament.format = 'double_elimination' then
    if p_mode = 'manual' and (v_count & (v_count - 1)) = 0 then
      v_ordered_ids := knockout_seeded_slots(v_ordered_ids);
    end if;
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

  -- First-round slots, two per match (NULL = BYE).
  if p_mode = 'manual' then
    v_slots := knockout_seeded_slots(v_ordered_ids);
  else
    -- Random draw: give every first-round match a participant, spreading the
    -- BYEs evenly across sibling sections. Integer division decides which
    -- matches get a free pass; the drawn order fills the remaining slots.
    v_matches_in_round := v_bracket_size / 2;
    v_byes := v_bracket_size - v_count;
    for v_match in 1..v_matches_in_round loop
      v_slots := array_append(v_slots, v_ordered_ids[v_seed_index]);
      v_seed_index := v_seed_index + 1;
      if (v_match * v_byes) / v_matches_in_round
         = ((v_match - 1) * v_byes) / v_matches_in_round then
        v_slots := array_append(v_slots, v_ordered_ids[v_seed_index]);
        v_seed_index := v_seed_index + 1;
      else
        v_slots := array_append(v_slots, null::uuid);
      end if;
    end loop;
  end if;

  delete from match_sets
  where match_id in (
    select m.id
    from matches m
    where m.tournament_id = p_tournament_id
  );

  delete from matches
  where tournament_id = p_tournament_id;

  drop table if exists tmp_match_ids;
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
    v_side_a := v_slots[2 * v_match - 1];
    v_side_b := v_slots[2 * v_match];

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
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  -- Take the snapshot under the same lock generate_bracket uses, so a
  -- concurrent rebuild cannot change the bracket between the two.
  perform 1 from tournaments where id = p_tournament_id for update;

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

-- Rearranges players in first-round knockout slots before the start. Only a
-- match no other match feeds takes players (the rest fill from results), the
-- layout must move the players already in those matches without losing or
-- duplicating anyone, and every match keeps at least one player. A match left
-- with one player is a BYE: its free pass follows the player to the next round.
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
  v_next matches%rowtype;
  v_seen_matches uuid[] := '{}';
  v_before uuid[] := '{}';
  v_after uuid[] := '{}';
  v_status tournament_status;
  v_format tournament_format;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if jsonb_typeof(p_layout) is distinct from 'array' then
    raise exception 'Layout must be an array';
  end if;

  select status, format into v_status, v_format from tournaments where id = p_tournament_id for update;
  if v_status in ('in_progress', 'completed') then
    raise exception 'drafts.rulesLocked';
  end if;

  -- Check every requested change before modifying a match.
  for v_item in select * from jsonb_array_elements(p_layout)
  loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or not (v_item ?& array['match_id', 'side_a_entry_id', 'side_b_entry_id']) then
      raise exception 'Each layout item requires a match and both participant slots';
    end if;
    v_match_id := (v_item->>'match_id')::uuid;
    v_side_a := nullif(v_item->>'side_a_entry_id', '')::uuid;
    v_side_b := nullif(v_item->>'side_b_entry_id', '')::uuid;

    if v_match_id is null or v_match_id = any(v_seen_matches) then
      raise exception 'Layout requires distinct non-null match IDs';
    end if;
    v_seen_matches := array_append(v_seen_matches, v_match_id);

    select * into v_match from matches where id = v_match_id for update;
    if v_match.id is null then
      raise exception 'Match % not found', v_match_id;
    end if;
    if v_match.tournament_id <> p_tournament_id then
      raise exception 'Match does not belong to this tournament';
    end if;
    if v_format not in ('single_elimination', 'double_elimination')
       or v_match.stage not in ('main', 'winners')
       or exists (select 1 from matches f where f.next_match_id = v_match_id or f.loser_next_match_id = v_match_id) then
      raise exception 'drafts.bracketSlotLocked';
    end if;
    -- A BYE (one player, no score) may move; a played match may not.
    if v_match.status = 'finished'::match_status
       and not (num_nonnulls(v_match.side_a_entry_id, v_match.side_b_entry_id) = 1
         and v_match.side_a_score is null and v_match.side_b_score is null) then
      raise exception 'Cannot modify finished match';
    end if;
    if exists (select 1 from match_sets where match_id = v_match_id)
       or exists (select 1 from live_scores where match_id = v_match_id and status = 'active') then
      raise exception 'Cannot modify a match with scores or active live scoring';
    end if;
    if v_side_a = v_side_b then
      raise exception 'A match cannot contain the same participant twice';
    end if;
    if (v_side_a is not null and not exists (
          select 1 from entries where id = v_side_a and tournament_id = p_tournament_id and status = 'approved'
        )) or (v_side_b is not null and not exists (
          select 1 from entries where id = v_side_b and tournament_id = p_tournament_id and status = 'approved'
        )) then
      raise exception 'Participant does not belong to the approved entries of this tournament';
    end if;
    if v_side_a is null and v_side_b is null then
      raise exception 'drafts.bracketLayoutInvalid';
    end if;
    -- The free pass of a BYE has already advanced; moving it is safe only
    -- while the next match is unplayed.
    if v_match.winner_entry_id is not null and v_match.next_match_id is not null then
      select * into v_next from matches where id = v_match.next_match_id for update;
      if v_next.status = 'finished'::match_status
         or v_next.side_a_score is not null or v_next.side_b_score is not null
         or exists (select 1 from match_sets where match_id = v_next.id)
         or exists (select 1 from live_scores where match_id = v_next.id and status = 'active') then
        raise exception 'drafts.rulesLocked';
      end if;
    end if;
    v_before := v_before || array_remove(array[v_match.side_a_entry_id, v_match.side_b_entry_id], null);
    v_after := v_after || array_remove(array[v_side_a, v_side_b], null);
  end loop;

  -- Players only change places: nobody is added, dropped or put in twice.
  if (select coalesce(array_agg(x order by x), '{}') from unnest(v_before) x)
     is distinct from (select coalesce(array_agg(x order by x), '{}') from unnest(v_after) x) then
    raise exception 'drafts.bracketLayoutInvalid';
  end if;

  -- Withdraw the free passes of the old BYEs before placing anyone.
  for v_item in select * from jsonb_array_elements(p_layout)
  loop
    select * into v_match from matches where id = (v_item->>'match_id')::uuid;
    if v_match.winner_entry_id is not null and v_match.next_match_id is not null then
      update matches
      set side_a_entry_id = case when v_match.next_slot = 'A' and side_a_entry_id = v_match.winner_entry_id then null else side_a_entry_id end,
          side_b_entry_id = case when v_match.next_slot = 'B' and side_b_entry_id = v_match.winner_entry_id then null else side_b_entry_id end
      where id = v_match.next_match_id;
      update matches
      set status = case when side_a_entry_id is not null and side_b_entry_id is not null then 'ready'::match_status else 'pending'::match_status end
      where id = v_match.next_match_id;
    end if;
  end loop;

  for v_item in select * from jsonb_array_elements(p_layout)
  loop
    v_match_id := (v_item->>'match_id')::uuid;
    v_side_a := nullif(v_item->>'side_a_entry_id', '')::uuid;
    v_side_b := nullif(v_item->>'side_b_entry_id', '')::uuid;

    update matches
    set
      side_a_entry_id = v_side_a,
      side_b_entry_id = v_side_b,
      winner_entry_id = case when v_side_a is null then v_side_b when v_side_b is null then v_side_a end,
      status = case
        when v_side_a is not null and v_side_b is not null then 'ready'::match_status
        else 'finished'::match_status
      end
    where id = v_match_id;

    if v_side_a is null or v_side_b is null then
      perform propagate_winner(v_match_id, coalesce(v_side_a, v_side_b));
    end if;
  end loop;
end;
$$;

-- A slot swap is a two-match layout and goes through the same checks.
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
  if v_fs is null or v_ts is null or v_fs not in ('A', 'B') or v_ts not in ('A', 'B') then
    raise exception 'Invalid slot (use A or B)';
  end if;

  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  select * into m_from from matches where id = p_from_match_id;
  select * into m_to from matches where id = p_to_match_id;

  if m_from.id is null or m_to.id is null then
    raise exception 'Match not found';
  end if;

  if m_from.tournament_id <> p_tournament_id or m_to.tournament_id <> p_tournament_id then
    raise exception 'Match does not belong to this tournament';
  end if;

  if p_from_match_id = p_to_match_id then
    if v_fs = v_ts then
      return;
    end if;
    perform apply_bracket_layout(p_tournament_id, jsonb_build_array(jsonb_build_object(
      'match_id', m_from.id, 'side_a_entry_id', m_from.side_b_entry_id, 'side_b_entry_id', m_from.side_a_entry_id)));
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

  perform apply_bracket_layout(p_tournament_id, jsonb_build_array(
    jsonb_build_object('match_id', m_from.id, 'side_a_entry_id', nf_a, 'side_b_entry_id', nf_b),
    jsonb_build_object('match_id', m_to.id, 'side_a_entry_id', nt_a, 'side_b_entry_id', nt_b)));
end;
$$;

grant execute on function generate_bracket(uuid, draw_mode, uuid[]) to authenticated;
grant execute on function rebuild_bracket(uuid, draw_mode, uuid[]) to authenticated;
grant execute on function swap_bracket_slots(uuid, uuid, text, uuid, text) to authenticated;
grant execute on function apply_bracket_layout(uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
