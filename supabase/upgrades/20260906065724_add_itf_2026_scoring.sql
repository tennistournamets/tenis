-- ITF 2026 scoring formats. Existing results and legacy rules are preserved.
begin;
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

  if v_new_winner is not null then
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
    v_live := start_live_match(p_match_id);
    select * into v_live
    from live_scores
    where match_id = p_match_id
    for update;
  end if;

  if p_expected_revision is not null and v_live.revision <> p_expected_revision then
    raise exception 'Live score changed. Refresh and try again.';
  end if;

  if v_live.status = 'stopped' then raise exception 'Resume live scoring before recording points'; end if;

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
drop trigger if exists trg_tennis_scoring_settings on public.tournaments;
create trigger trg_tennis_scoring_settings before insert or update of scoring_config,set_format,sport
  on public.tournaments for each row execute function public.guard_tennis_scoring_settings();
revoke execute on function tennis_scoring_rules(jsonb), tennis_set_rule(jsonb,integer,integer),
  tennis_race_result(integer,integer,integer,integer), tennis_set_result(jsonb,jsonb),
  tennis_live_state(uuid,jsonb,integer), guard_tennis_scoring_settings()
  from public,anon,authenticated;
revoke execute on function tennis_apply_point(jsonb,text),sync_live_match_sets(uuid,jsonb) from public,anon,authenticated;
notify pgrst,'reload schema';

commit;
