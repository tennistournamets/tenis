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
