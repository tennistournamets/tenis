-- Step 4: validate manual set replacements and enforce sport boundaries.
-- CREATE OR REPLACE retains owners and ACLs. Existing results are not rewritten.
begin;

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
  v_sport sport;
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
  v_set_index integer;
  v_a_games integer;
  v_b_games integer;
begin
  select m.tournament_id,
         m.side_a_entry_id,
         m.side_b_entry_id,
         m.winner_entry_id,
         t.set_format,
         t.sport,
         t.status
    into v_tournament_id,
         v_side_a_id,
         v_side_b_id,
         v_previous_winner,
         v_set_format,
         v_sport,
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

  if v_sport not in ('tennis', 'padel') then
    raise exception 'Set scores are supported only for tennis and padel';
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
         or v_number > (case when v_field = 'set_index' then v_max_sets else 7 end) then
        raise exception using errcode = '22023', message = 'Set index or game score is outside the allowed integer range';
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

    -- Standard tiebreak set: 6:0..4, 7:5 or 7:6 (and reversed).
    -- tiebreak_to configures points within the tiebreak, not set game totals.
    v_complete := (greatest(v_a_games, v_b_games) = 6 and least(v_a_games, v_b_games) <= 4)
      or (greatest(v_a_games, v_b_games) = 7 and least(v_a_games, v_b_games) in (5, 6));
    if v_complete then
      if v_a_games > v_b_games then
        v_a_wins := v_a_wins + 1;
      else
        v_b_wins := v_b_wins + 1;
      end if;
    else
      if not (greatest(v_a_games, v_b_games) <= 5
          or (greatest(v_a_games, v_b_games) = 6 and least(v_a_games, v_b_games) in (5, 6))) then
        raise exception using errcode = '22023', message = 'Invalid set score: a completed set must be 6:0-4, 7:5 or 7:6';
      end if;
      if v_set_index <> v_set_count then
        raise exception using errcode = '22023', message = 'Only the final entered set may be unfinished';
      end if;
    end if;
  end loop;

  delete from match_sets where match_id = p_match_id;
  insert into match_sets (match_id, set_index, side_a_games, side_b_games)
  select p_match_id,
         (value->>'set_index')::numeric::integer,
         (value->>'side_a_games')::numeric::integer,
         (value->>'side_b_games')::numeric::integer
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

  if v_new_winner is not null then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  -- status transitions are managed explicitly via the admin UI

  return v_new_winner;
end;
$$;

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
  where m.id = p_match_id;

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
  v_sport sport;
  v_required_sets integer;
  v_tiebreak_to integer;
  v_live live_scores%rowtype;
begin
  select *
    into v_match
  from matches
  where id = p_match_id;

  if v_match.id is null then
    raise exception 'Match not found';
  end if;

  select t.set_format, t.status, t.sport,
         coalesce((t.scoring_config->>'tiebreak_to')::integer, 7)
    into v_set_format, v_tournament_status, v_sport, v_tiebreak_to
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

  if v_match.status = 'finished'::match_status then
    raise exception 'Match already finished';
  end if;

  v_required_sets := case when v_set_format = 'best_of_5' then 3 else 2 end;

  select * into v_live
  from live_scores
  where match_id = p_match_id;

  if v_live.id is null then
    insert into live_scores (match_id, tournament_id, counter_user_id, status, state)
    values (p_match_id, v_match.tournament_id, auth.uid(), 'active', live_score_initial_state(v_required_sets, v_tiebreak_to))
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
  where id = p_match_id;

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
       or v_old_state->'sets' is distinct from v_live.state->'sets' then
      perform sync_live_match_sets(p_match_id, v_live.state);
    end if;

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
     or v_old_state->'sets' is distinct from v_new_state->'sets' then
    -- Game (or set) completed: mirror progress into match_sets so the main
    -- score table follows the live match game by game.
    perform sync_live_match_sets(p_match_id, v_new_state);
  end if;

  return v_live;
end;
$$;

commit;
