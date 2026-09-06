-- Live point-by-point scoring and restricted `counter` role.

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
    insert into live_scores (match_id, tournament_id, status, state)
    values (p_match_id, v_match.tournament_id, 'active', live_score_initial_state(v_required_sets))
    returning * into v_live;
  elsif v_live.status <> 'finished' then
    update live_scores
    set status = 'active'
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
