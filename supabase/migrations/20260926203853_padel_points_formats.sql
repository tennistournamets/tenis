-- Padel points formats (docs/PADEL_FORMATS.md). Safe to re-run: columns and
-- triggers are created only when missing, functions are replaced, grants are
-- restated.
--
-- * americano / mexicano / king_of_court: an entry is one player (the
--   pick_random registration), a match side is two players: side_a_entry_id +
--   side_a2_entry_id. team_americano keeps fixed pairs (one entry per side).
-- * A match is played to a total of N points (scoring_config.points_per_match):
--   side_a_score + side_b_score = N. A draw is possible with an even N; King of
--   the Court needs an odd N, every match has a winner to move up.
-- * The generator stores the field in format_config.roster. A player of the
--   roster missing from a round rests; for every completed round of rest the
--   standings add the player's own average points per played match.

-- =============================================
-- Model
-- =============================================

alter table public.matches add column if not exists side_a2_entry_id uuid references entries (id) on delete set null;
alter table public.matches add column if not exists side_b2_entry_id uuid references entries (id) on delete set null;

-- Enum values are compared as text: a value added in the same release cannot
-- be used as an enum literal inside the transaction that adds it.
create or replace function public.format_is_points(p_format tournament_format)
returns boolean language sql immutable set search_path = public as $$
  select p_format::text = any (array['americano', 'mexicano', 'team_americano', 'king_of_court']);
$$;

-- One player per entry, two players per match side.
create or replace function public.format_is_individual(p_format tournament_format)
returns boolean language sql immutable set search_path = public as $$
  select p_format::text = any (array['americano', 'mexicano', 'king_of_court']);
$$;

-- The next round is built from the results of the previous one.
create or replace function public.format_is_dynamic(p_format tournament_format)
returns boolean language sql immutable set search_path = public as $$
  select p_format::text = any (array['mexicano', 'king_of_court']);
$$;

create or replace function public.points_target(p_scoring_config jsonb, p_format tournament_format)
returns integer language sql immutable set search_path = public as $$
  select coalesce((p_scoring_config->>'points_per_match')::integer,
    case when p_format::text = 'king_of_court' then 21 else 24 end);
$$;

-- Points formats are padel only; individual formats register single players.
create or replace function public.guard_points_format()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_target jsonb; v_n integer;
begin
  if not format_is_points(new.format) then return new; end if;
  if new.sport::text <> 'padel' then
    raise exception using errcode = '22023', message = 'pointsFormat.padelOnly';
  end if;
  new.category := 'doubles';
  if format_is_individual(new.format) then new.doubles_pairing_mode := 'pick_random'; end if;
  new.scoring_config := coalesce(new.scoring_config, '{}'::jsonb);
  if not new.scoring_config ? 'points_per_match' then
    new.scoring_config := new.scoring_config || jsonb_build_object('points_per_match', points_target('{}'::jsonb, new.format));
  end if;
  v_target := new.scoring_config->'points_per_match';
  if jsonb_typeof(v_target) is distinct from 'number' or (v_target::text)::numeric <> trunc((v_target::text)::numeric)
     or (v_target::text)::numeric < 4 or (v_target::text)::numeric > 99 then
    raise exception using errcode = '22023', message = 'pointsFormat.invalidTarget';
  end if;
  v_n := (v_target::text)::integer;
  if new.format::text = 'king_of_court' and v_n % 2 = 0 then
    raise exception using errcode = '22023', message = 'pointsFormat.oddTarget';
  end if;
  if TG_OP = 'UPDATE' and (old.scoring_config->'points_per_match') is distinct from v_target
     and (old.status in ('in_progress', 'completed')
       or exists (select 1 from matches m where m.tournament_id = old.id and m.status = 'finished')
       or exists (select 1 from live_scores l where l.tournament_id = old.id)) then
    raise exception using errcode = '22023', message = 'Scoring rules are locked after the tournament starts or scores exist';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_points_format() from public, anon, authenticated;
drop trigger if exists trg_guard_points_format on public.tournaments;
create trigger trg_guard_points_format before insert or update on public.tournaments
for each row execute function public.guard_points_format();

-- In an individual format an entry is one player: pairs are formed per match.
create or replace function public.guard_individual_entry_members()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.member_order = 2 and exists (
    select 1 from entries e join tournaments t on t.id = e.tournament_id
    where e.id = new.entry_id and format_is_individual(t.format)
  ) then
    raise exception using errcode = '22023', message = 'pointsFormat.individualEntries';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_individual_entry_members() from public, anon, authenticated;
drop trigger if exists trg_guard_individual_entry_members on public.entry_members;
create trigger trg_guard_individual_entry_members before insert or update of member_order, entry_id on public.entry_members
for each row execute function public.guard_individual_entry_members();

-- A points match has no sets: its score is the points total.
create or replace function public.guard_points_match_sets()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from matches m join tournaments t on t.id = m.tournament_id
    where m.id = new.match_id and format_is_points(t.format)
  ) then
    raise exception using errcode = '22023', message = 'pointsFormat.pointsOnly';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_points_match_sets() from public, anon, authenticated;
drop trigger if exists trg_guard_points_match_sets on public.match_sets;
create trigger trg_guard_points_match_sets before insert on public.match_sets
for each row execute function public.guard_points_match_sets();

-- The generated field: format_config.roster, or the approved entries before a draw.
create or replace function public.points_roster(p_tournament_id uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select case when t.format_config ? 'roster'
    then array(select value::uuid from jsonb_array_elements_text(t.format_config->'roster'))
    else array(select e.id from entries e where e.tournament_id = t.id and e.status = 'approved'
      order by e.seed_order nulls last, e.created_at, e.id) end
  from tournaments t where t.id = p_tournament_id;
$$;
revoke execute on function public.points_roster(uuid) from public, anon, authenticated;

-- Every participant slot of a match: side a/b, first/second player.
create or replace function public.match_participants(p_match matches)
returns uuid[] language sql immutable set search_path = public as $$
  select array_remove(array[p_match.side_a_entry_id, p_match.side_a2_entry_id, p_match.side_b_entry_id, p_match.side_b2_entry_id], null);
$$;

-- =============================================
-- Standings
-- =============================================

create or replace function public.points_standings_rows(p_tournament_id uuid)
returns table (
  entry_id uuid,
  display_name text,
  played integer,
  won integer,
  drawn integer,
  lost integer,
  points_for integer,
  points_against integer,
  diff integer,
  rests integer,
  compensation integer,
  total integer,
  court integer,
  rank integer
)
language sql
stable
security definer
set search_path = public
as $$
  with t as (
    select * from tournaments where id = p_tournament_id
  ),
  roster as (
    select e.id, e.display_name, e.seed_order, e.created_at
    from entries e
    where e.id = any (points_roster(p_tournament_id))
  ),
  slots as (
    select m.round_number, m.match_number, x.eid,
      case when x.side = 'a' then m.side_a_score else m.side_b_score end as pf,
      case when x.side = 'a' then m.side_b_score else m.side_a_score end as pa
    from matches m
    cross join lateral (values (m.side_a_entry_id, 'a'), (m.side_a2_entry_id, 'a'),
      (m.side_b_entry_id, 'b'), (m.side_b2_entry_id, 'b')) x(eid, side)
    where m.tournament_id = p_tournament_id and x.eid is not null
      and m.status = 'finished' and m.side_a_score is not null and m.side_b_score is not null
  ),
  done_rounds as (
    select m.round_number from matches m where m.tournament_id = p_tournament_id
    group by m.round_number having bool_and(m.status = 'finished')
  ),
  round_members as (
    select distinct m.round_number, x.eid
    from matches m cross join lateral unnest(match_participants(m)) x(eid)
    where m.tournament_id = p_tournament_id
  ),
  rest_counts as (
    select r.id as eid, count(*)::integer as n
    from roster r cross join done_rounds d
    where not exists (select 1 from round_members rm where rm.round_number = d.round_number and rm.eid = r.id)
    group by r.id
  ),
  agg as (
    select s.eid, count(*)::integer as played,
      count(*) filter (where s.pf > s.pa)::integer as won,
      count(*) filter (where s.pf = s.pa)::integer as drawn,
      count(*) filter (where s.pf < s.pa)::integer as lost,
      sum(s.pf)::integer as pf, sum(s.pa)::integer as pa
    from slots s group by s.eid
  ),
  last_court as (
    select s.eid, s.match_number as court, s.pf > s.pa as won_last
    from slots s where s.round_number = (select max(round_number) from done_rounds)
  ),
  ranked as (
    select r.id, r.display_name, r.seed_order, r.created_at,
      coalesce(a.played, 0) as played, coalesce(a.won, 0) as won, coalesce(a.drawn, 0) as drawn, coalesce(a.lost, 0) as lost,
      coalesce(a.pf, 0) as pf, coalesce(a.pa, 0) as pa, coalesce(rc.n, 0) as rests,
      case when coalesce(a.played, 0) > 0 then round(a.pf::numeric / a.played * coalesce(rc.n, 0))::integer else 0 end as compensation,
      lc.court, coalesce(lc.won_last, false) as won_last
    from roster r
    left join agg a on a.eid = r.id
    left join rest_counts rc on rc.eid = r.id
    left join last_court lc on lc.eid = r.id
  )
  select x.id, x.display_name, x.played, x.won, x.drawn, x.lost, x.pf, x.pa, x.pf - x.pa,
    x.rests, x.compensation, x.pf + x.compensation,
    case when (select format::text from t) = 'king_of_court' then x.court end,
    (row_number() over (order by
      case when (select format::text from t) = 'king_of_court' then coalesce(x.court, 2147483647) end,
      case when (select format::text from t) = 'king_of_court' then x.won_last end desc,
      x.pf + x.compensation desc, x.won desc, x.pf - x.pa desc,
      x.seed_order nulls last, lower(x.display_name), x.id))::integer
  from ranked x;
$$;
revoke execute on function public.points_standings_rows(uuid) from public, anon, authenticated;

create or replace function public.get_points_standings(p_tournament_id uuid)
returns table (
  entry_id uuid,
  display_name text,
  played integer,
  won integer,
  drawn integer,
  lost integer,
  points_for integer,
  points_against integer,
  diff integer,
  rests integer,
  compensation integer,
  total integer,
  court integer,
  rank integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from tournaments t where t.id = p_tournament_id) then
    raise exception 'Tournament not found';
  end if;
  if not (
    exists (select 1 from tournaments t where t.id = p_tournament_id and t.is_public)
    or is_tournament_admin(p_tournament_id)
    or can_live_score(p_tournament_id)
    or coalesce(current_setting('tenis.access_tournament', true), '') = p_tournament_id::text
  ) then
    raise exception 'Not allowed';
  end if;
  return query select * from points_standings_rows(p_tournament_id);
end;
$$;
revoke execute on function public.get_points_standings(uuid) from public;
grant execute on function public.get_points_standings(uuid) to anon, authenticated;

-- =============================================
-- Round builders (internal)
-- =============================================

-- Americano: the circle method gives every player each partner exactly once per
-- cycle (a 1-factorisation); later cycles repeat it. In each round the pairs
-- whose players rested least sit out when there are more pairs than courts
-- allow, and the playing pairs meet the opponents they have faced least.

-- Pairs of one circle round, ordered so the pairs to rest come last: the pair
-- whose most-rested player rested least, then the fewest rests in total. A
-- player paired with the odd-count placeholder is returned in "single".
create or replace function public.americano_round_pairs(p_arr uuid[], p_rests jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  with slots as (
    select i, p_arr[i] as x, p_arr[array_length(p_arr, 1) - i + 1] as y
    from generate_series(1, array_length(p_arr, 1) / 2) i
  )
  select jsonb_build_object(
    'pairs', coalesce((select jsonb_agg(jsonb_build_array(x, y) order by
        greatest(coalesce((p_rests->>x::text)::integer, 0), coalesce((p_rests->>y::text)::integer, 0)) desc,
        coalesce((p_rests->>x::text)::integer, 0) + coalesce((p_rests->>y::text)::integer, 0) desc, i desc)
      from slots where x is not null and y is not null), '[]'::jsonb),
    'single', (select coalesce(x, y) from slots where x is null or y is null));
$$;

-- Spread of rests (most minus fewest) a circle order would give over p_rounds.
create or replace function public.americano_rest_spread(p_arr uuid[], p_rounds integer, p_courts integer)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  v_arr uuid[] := p_arr;
  v_m integer := array_length(p_arr, 1);
  v_rests jsonb := '{}'::jsonb;
  v_round jsonb;
  v_pairs jsonb;
  v_playing integer;
  v_i integer;
  v_k text;
begin
  for v_i in 1..v_m loop
    if v_arr[v_i] is not null then v_rests := v_rests || jsonb_build_object(v_arr[v_i]::text, 0); end if;
  end loop;
  for v_i in 1..p_rounds loop
    v_round := americano_round_pairs(v_arr, v_rests);
    v_pairs := v_round->'pairs';
    v_playing := least(2 * p_courts, (jsonb_array_length(v_pairs) / 2) * 2);
    for v_k in select value->>0 from jsonb_array_elements(v_pairs) with ordinality e(value, n) where n > v_playing
      union all select value->>1 from jsonb_array_elements(v_pairs) with ordinality e(value, n) where n > v_playing
      union all select v_round->>'single' where v_round->>'single' is not null loop
      v_rests := v_rests || jsonb_build_object(v_k, (v_rests->>v_k)::integer + 1);
    end loop;
    v_arr := array[v_arr[1]] || array[v_arr[v_m]] || v_arr[2:v_m - 1];
  end loop;
  return (select max(value::integer) - min(value::integer) from jsonb_each_text(v_rests));
end;
$$;

-- The four player-vs-player keys of a match between two pairs.
create or replace function public.americano_opponent_keys(p_a jsonb, p_b jsonb)
returns text[]
language sql
immutable
set search_path = public
as $$
  select array_agg(least(x, y) || ':' || greatest(x, y))
  from (values (p_a->>0), (p_a->>1)) a(x) cross join (values (p_b->>0), (p_b->>1)) b(y);
$$;

-- Playing pairs into matches: the pairing with the fewest repeated opponents
-- (sum of squared meeting counts) out of a few random greedy passes.
create or replace function public.americano_match_pairs(p_pairs jsonb, p_opp jsonb)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_try integer;
  v_play jsonb;
  v_out jsonb;
  v_best jsonb;
  v_best_total integer;
  v_total integer;
  v_p jsonb;
  v_q jsonb;
  v_i integer;
  v_pick integer;
  v_pick_cost integer;
  v_cost integer;
  v_k text;
begin
  for v_try in 1..24 loop
    select coalesce(jsonb_agg(x order by random()), '[]'::jsonb) into v_play from jsonb_array_elements(p_pairs) x;
    v_out := '[]'::jsonb; v_total := 0;
    while jsonb_array_length(v_play) > 1 loop
      v_p := v_play->0; v_pick := null; v_pick_cost := null;
      for v_i in 1..(jsonb_array_length(v_play) - 1) loop
        v_cost := 0;
        foreach v_k in array americano_opponent_keys(v_p, v_play->v_i) loop
          v_cost := v_cost + power(coalesce((p_opp->>v_k)::integer, 0), 2)::integer;
        end loop;
        if v_pick_cost is null or v_cost < v_pick_cost then v_pick := v_i; v_pick_cost := v_cost; end if;
      end loop;
      v_q := v_play->v_pick;
      v_out := v_out || jsonb_build_array(jsonb_build_array(v_p, v_q));
      v_total := v_total + v_pick_cost;
      v_play := v_play - v_pick - 0;
    end loop;
    if v_best_total is null or v_total < v_best_total then v_best := v_out; v_best_total := v_total; end if;
    exit when v_best_total = 0;
  end loop;
  return coalesce(v_best, '[]'::jsonb);
end;
$$;

-- Round-by-round Americano when the circle cannot spread rests evenly (few
-- courts): the players who rested least sit out, then partners are picked
-- with the fewest repeats, out of a few random passes.
create or replace function public.americano_greedy_pairs(p_players uuid[], p_partner jsonb)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_try integer;
  v_left text[];
  v_out jsonb;
  v_best jsonb;
  v_best_total integer;
  v_total integer;
  v_x text;
  v_y text;
  v_pick text;
  v_pick_cost integer;
  v_cost integer;
begin
  for v_try in 1..24 loop
    select array_agg(x::text order by random()) into v_left from unnest(p_players) x;
    v_out := '[]'::jsonb; v_total := 0;
    while coalesce(array_length(v_left, 1), 0) > 1 loop
      v_x := v_left[1]; v_pick := null; v_pick_cost := null;
      foreach v_y in array v_left[2:] loop
        v_cost := power(coalesce((p_partner->>(least(v_x, v_y) || ':' || greatest(v_x, v_y)))::integer, 0), 2)::integer;
        if v_pick_cost is null or v_cost < v_pick_cost then v_pick := v_y; v_pick_cost := v_cost; end if;
      end loop;
      v_out := v_out || jsonb_build_array(jsonb_build_array(v_x, v_pick));
      v_total := v_total + v_pick_cost;
      v_left := array_remove(array_remove(v_left, v_x), v_pick);
    end loop;
    if v_best_total is null or v_total < v_best_total then v_best := v_out; v_best_total := v_total; end if;
    exit when v_best_total = 0;
  end loop;
  return coalesce(v_best, '[]'::jsonb);
end;
$$;

-- One candidate schedule, not yet stored: the circle order p_arr, or round by
-- round when p_arr is null. Returns its rounds of [pair, pair] matches and its
-- cost, the sum of squared opponent meetings.
create or replace function public.americano_plan(p_players uuid[], p_arr uuid[], p_rounds integer, p_courts integer)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_arr uuid[] := p_arr;
  v_m integer := array_length(p_arr, 1);
  v_round integer;
  v_pairs jsonb;
  v_step jsonb;
  v_play uuid[];
  v_rests jsonb := '{}'::jsonb;
  v_partner jsonb := '{}'::jsonb;
  v_opp jsonb := '{}'::jsonb;
  v_matches jsonb;
  v_match jsonb;
  v_rounds jsonb := '[]'::jsonb;
  v_p jsonb;
  v_q jsonb;
  v_k text;
  v_playing integer;
begin
  foreach v_k in array p_players::text[] loop v_rests := v_rests || jsonb_build_object(v_k, 0); end loop;
  for v_round in 1..p_rounds loop
    if v_arr is not null then
      v_step := americano_round_pairs(v_arr, v_rests);
      v_pairs := v_step->'pairs';
      v_playing := least(2 * p_courts, (jsonb_array_length(v_pairs) / 2) * 2);
      select coalesce(jsonb_agg(p), '[]'::jsonb) into v_pairs
      from jsonb_array_elements(v_pairs) with ordinality e(p, n) where n <= v_playing;
      -- circle rotation: first element fixed, rotate the rest
      v_arr := array[v_arr[1]] || array[v_arr[v_m]] || v_arr[2:v_m - 1];
    else
      select array_agg(x order by (v_rests->>x::text)::integer desc, random()) into v_play
      from unnest(p_players) x;
      v_pairs := americano_greedy_pairs(v_play[1:4 * p_courts], v_partner);
    end if;

    -- Everyone of the roster outside this round's pairs rests.
    foreach v_k in array p_players::text[] loop
      if not exists (select 1 from jsonb_array_elements(v_pairs) p where p->>0 = v_k or p->>1 = v_k) then
        v_rests := v_rests || jsonb_build_object(v_k, (v_rests->>v_k)::integer + 1);
      end if;
    end loop;

    v_matches := americano_match_pairs(v_pairs, v_opp);
    for v_match in select value from jsonb_array_elements(v_matches) loop
      v_p := v_match->0; v_q := v_match->1;
      foreach v_k in array americano_opponent_keys(v_p, v_q) loop
        v_opp := v_opp || jsonb_build_object(v_k, coalesce((v_opp->>v_k)::integer, 0) + 1);
      end loop;
      foreach v_k in array array[least(v_p->>0, v_p->>1) || ':' || greatest(v_p->>0, v_p->>1),
                                 least(v_q->>0, v_q->>1) || ':' || greatest(v_q->>0, v_q->>1)] loop
        v_partner := v_partner || jsonb_build_object(v_k, coalesce((v_partner->>v_k)::integer, 0) + 1);
      end loop;
    end loop;
    v_rounds := v_rounds || jsonb_build_array(v_matches);
  end loop;
  return jsonb_build_object('rounds', v_rounds,
    'cost', (select coalesce(sum(power(value::integer, 2)), 0)::integer from jsonb_each_text(v_opp))
      + 100 * (select coalesce(sum(power(value::integer - 1, 2)), 0)::integer from jsonb_each_text(v_partner)));
end;
$$;

-- Cyclic whist designs (found offline, verified): with every court in use each
-- player partners every other exactly once and faces every other exactly
-- twice per cycle. Labels are residues mod m (m = n - 1 plus the fixed player
-- -1 when n = 4k; m = n when n = 4k + 1, label 0 of the round rests). Round r
-- adds r to every label; a table is [a, b, c, d] = a+b against c+d.
create or replace function public.americano_whist_base(p_n integer)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select ('{"8":[[0,6,5,2],[4,-1,3,1]],"12":[[6,1,3,5],[0,7,2,10],[4,-1,8,9]],"13":[[7,6,4,9],[5,8,12,1],[11,2,3,10]],"16":[[-1,0,1,4],[9,10,2,12],[8,14,3,5],[7,11,13,6]],"17":[[13,10,12,1],[14,6,3,2],[4,8,5,15],[16,11,9,7]],"20":[[2,1,11,18],[10,4,17,15],[0,14,6,16],[3,7,8,-1],[12,9,5,13]],"21":[[8,14,6,16],[20,19,10,13],[5,9,2,4],[18,11,1,17],[3,12,15,7]],"24":[[22,18,5,12],[16,17,2,15],[1,7,8,3],[14,0,19,11],[13,10,21,-1],[20,9,6,4]],"25":[[20,4,3,1],[11,14,16,24],[15,22,2,8],[9,5,13,12],[10,21,19,6],[18,23,17,7]]}'::jsonb)->(p_n::text);
$$;

create or replace function public.build_americano_rounds(p_tournament_id uuid, p_players uuid[], p_rounds integer, p_courts integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_try uuid[];
  v_orders uuid[][] := '{}';
  v_attempt integer;
  v_plan jsonb;
  v_best jsonb;
  v_round jsonb;
  v_match jsonb;
  v_r integer := 0;
  v_court integer;
  v_base jsonb;
  v_m integer;
  v_n integer := array_length(p_players, 1);
  v_table jsonb;
  v_slot integer;
  v_ids uuid[];
begin
  v_base := americano_whist_base(v_n);
  if v_base is not null and p_courts = v_n / 4 then
    select array_agg(x order by random()) into v_try from unnest(p_players) x;
    v_m := case when v_n % 4 = 0 then v_n - 1 else v_n end;
    for v_r in 0..(p_rounds - 1) loop
      v_court := 0;
      for v_table in select value from jsonb_array_elements(v_base) loop
        v_court := v_court + 1;
        v_ids := '{}';
        for v_slot in 0..3 loop
          v_ids := v_ids || case when (v_table->>v_slot)::integer = -1 then v_try[v_n]
            else v_try[(((v_table->>v_slot)::integer + v_r) % v_m) + 1] end;
        end loop;
        insert into matches (tournament_id, stage, round_number, match_number,
          side_a_entry_id, side_a2_entry_id, side_b_entry_id, side_b2_entry_id, status)
        values (p_tournament_id, 'main', v_r + 1, v_court, v_ids[1], v_ids[2], v_ids[3], v_ids[4], 'ready');
      end loop;
    end loop;
    return p_rounds;
  end if;

  -- Rests follow a fixed rule, so the circle order decides how evenly they
  -- spread. Circle orders that keep rests within one of each other give every
  -- partner once; without one, rounds are built one by one. Of a few
  -- candidates the schedule with the fewest repeated opponents is stored.
  for v_attempt in 1..40 loop
    select array_agg(x order by random()) into v_try from unnest(p_players) x;
    if array_length(v_try, 1) % 2 = 1 then v_try := v_try || null::uuid; end if;
    if americano_rest_spread(v_try, p_rounds, p_courts) <= 1 then
      v_orders := v_orders || array[v_try];
      exit when array_length(v_orders, 1) >= 8;
    end if;
  end loop;
  for v_attempt in 1..8 loop
    if coalesce(array_length(v_orders, 1), 0) > 0 then
      exit when v_attempt > array_length(v_orders, 1);
      v_plan := americano_plan(p_players, array(select unnest(v_orders[v_attempt:v_attempt][1:])), p_rounds, p_courts);
    else
      v_plan := americano_plan(p_players, null, p_rounds, p_courts);
    end if;
    if v_best is null or (v_plan->>'cost')::integer < (v_best->>'cost')::integer then v_best := v_plan; end if;
  end loop;

  for v_round in select value from jsonb_array_elements(v_best->'rounds') loop
    v_r := v_r + 1;
    v_court := 0;
    for v_match in select value from jsonb_array_elements(v_round) loop
      v_court := v_court + 1;
      insert into matches (tournament_id, stage, round_number, match_number,
        side_a_entry_id, side_a2_entry_id, side_b_entry_id, side_b2_entry_id, status)
      values (p_tournament_id, 'main', v_r, v_court,
        (v_match#>>'{0,0}')::uuid, (v_match#>>'{0,1}')::uuid, (v_match#>>'{1,0}')::uuid, (v_match#>>'{1,1}')::uuid, 'ready');
    end loop;
  end loop;
  return p_rounds;
end;
$$;
revoke execute on function public.build_americano_rounds(uuid, uuid[], integer, integer) from public, anon, authenticated;
revoke execute on function public.americano_rest_spread(uuid[], integer, integer) from public, anon, authenticated;
revoke execute on function public.americano_match_pairs(jsonb, jsonb), public.americano_greedy_pairs(uuid[], jsonb), public.americano_plan(uuid[], uuid[], integer, integer) from public, anon, authenticated;

-- Rounds so far in which each roster player sat out.
create or replace function public.points_rest_counts(p_tournament_id uuid, p_before_round integer)
returns table (entry_id uuid, rests integer)
language sql stable security definer set search_path = public as $$
  select r.eid, count(x.round_number)::integer
  from unnest(points_roster(p_tournament_id)) r(eid)
  left join lateral (
    select distinct m.round_number from matches m
    where m.tournament_id = p_tournament_id and m.round_number < p_before_round
      and not exists (
        select 1 from matches o where o.tournament_id = p_tournament_id and o.round_number = m.round_number
          and r.eid = any (match_participants(o)))
  ) x on true
  group by r.eid;
$$;
revoke execute on function public.points_rest_counts(uuid, integer) from public, anon, authenticated;

-- Mexicano round (and the first King of the Court round): players ranked best
-- first; those who rested least sit out (the lowest ranked among equals), the
-- rest play in fours by rank: 1+4 against 2+3 on court 1, 5+8 against 6+7 next.
create or replace function public.build_ranked_round(p_tournament_id uuid, p_round integer, p_ranked uuid[], p_courts integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_play uuid[];
  v_court integer;
  v_rest integer := coalesce(array_length(p_ranked, 1), 0) - 4 * p_courts;
begin
  select array_agg(r.eid order by r.pos) into v_play
  from unnest(p_ranked) with ordinality r(eid, pos)
  where r.eid not in (
    select q.eid from unnest(p_ranked) with ordinality q(eid, pos)
    left join points_rest_counts(p_tournament_id, p_round) c on c.entry_id = q.eid
    order by coalesce(c.rests, 0), q.pos desc
    limit greatest(v_rest, 0)
  );
  for v_court in 1..p_courts loop
    insert into matches (tournament_id, stage, round_number, match_number,
      side_a_entry_id, side_a2_entry_id, side_b_entry_id, side_b2_entry_id, status)
    values (p_tournament_id, 'main', p_round, v_court,
      v_play[4 * v_court - 3], v_play[4 * v_court], v_play[4 * v_court - 2], v_play[4 * v_court - 1], 'ready');
  end loop;
end;
$$;
revoke execute on function public.build_ranked_round(uuid, integer, uuid[], integer) from public, anon, authenticated;

-- King of the Court: winners of court k move up to k-1 (court 1 winners stay),
-- losers move down to k+1 (last court losers stay). On the new court every
-- player coming from above partners one coming from below, so pairs change.
create or replace function public.build_kotc_round(p_tournament_id uuid, p_round integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_courts integer;
  v_k integer;
  v_win uuid[][] := '{}';
  v_lose uuid[][] := '{}';
  v_top uuid[];
  v_bottom uuid[];
  m matches%rowtype;
begin
  select count(*) into v_courts from matches where tournament_id = p_tournament_id and round_number = p_round - 1;
  for m in select * from matches where tournament_id = p_tournament_id and round_number = p_round - 1 order by match_number loop
    if m.side_a_score > m.side_b_score then
      v_win := v_win || array[[m.side_a_entry_id, m.side_a2_entry_id]];
      v_lose := v_lose || array[[m.side_b_entry_id, m.side_b2_entry_id]];
    else
      v_win := v_win || array[[m.side_b_entry_id, m.side_b2_entry_id]];
      v_lose := v_lose || array[[m.side_a_entry_id, m.side_a2_entry_id]];
    end if;
  end loop;
  for v_k in 1..v_courts loop
    v_top := case when v_k = 1 then array[v_win[1][1], v_win[1][2]] else array[v_lose[v_k - 1][1], v_lose[v_k - 1][2]] end;
    v_bottom := case when v_k = v_courts then array[v_lose[v_k][1], v_lose[v_k][2]] else array[v_win[v_k + 1][1], v_win[v_k + 1][2]] end;
    insert into matches (tournament_id, stage, round_number, match_number,
      side_a_entry_id, side_a2_entry_id, side_b_entry_id, side_b2_entry_id, status)
    values (p_tournament_id, 'main', p_round, v_k, v_top[1], v_bottom[1], v_top[2], v_bottom[2], 'ready');
  end loop;
end;
$$;
revoke execute on function public.build_kotc_round(uuid, integer) from public, anon, authenticated;

-- =============================================
-- Generators (RPC)
-- =============================================

-- Americano: the whole schedule (p_rounds, default one partner cycle). Team
-- Americano: all-play-all of the pairs. Mexicano and King of the Court: round 1.
create or replace function public.generate_points_format(p_tournament_id uuid, p_rounds integer default null, p_courts integer default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  t tournaments%rowtype;
  v_players uuid[];
  v_n integer;
  v_courts integer;
  v_cycle integer;
  v_rounds integer;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  perform assert_structure_regenerable(p_tournament_id);
  select * into t from tournaments where id = p_tournament_id;
  if not format_is_points(t.format) then
    raise exception using errcode = '22023', message = 'pointsFormat.notPointsFormat';
  end if;

  select array_agg(e.id order by e.seed_order nulls last, e.created_at, e.id) into v_players
  from entries e where e.tournament_id = p_tournament_id and e.status = 'approved';
  v_n := coalesce(array_length(v_players, 1), 0);

  if format_is_individual(t.format) then
    if v_n < 4 then raise exception using errcode = '22023', message = 'pointsFormat.minPlayers'; end if;
    if t.format::text = 'king_of_court' and (v_n < 8 or v_n % 4 <> 0) then
      raise exception using errcode = '22023', message = 'pointsFormat.kotcPlayers';
    end if;
    v_courts := coalesce(p_courts, v_n / 4);
    if v_courts < 1 or v_courts > v_n / 4 or (t.format::text = 'king_of_court' and v_courts <> v_n / 4) then
      raise exception using errcode = '22023', message = 'pointsFormat.invalidCourts';
    end if;
  else
    if v_n < 3 then raise exception using errcode = '22023', message = 'pointsFormat.minPairs'; end if;
    if exists (select 1 from entries e where e.id = any (v_players)
      and (select count(*) from entry_members em where em.entry_id = e.id) < 2) then
      raise exception using errcode = '22023', message = 'pointsFormat.pairsIncomplete';
    end if;
    v_courts := null;
  end if;

  delete from match_sets where match_id in (select id from matches where tournament_id = p_tournament_id);
  delete from matches where tournament_id = p_tournament_id;

  if t.format::text = 'americano' then
    v_cycle := v_n + v_n % 2 - 1;
    v_rounds := coalesce(p_rounds, v_cycle);
    if v_rounds < 1 or v_rounds > 3 * v_cycle then
      raise exception using errcode = '22023', message = 'pointsFormat.invalidRounds';
    end if;
    perform build_americano_rounds(p_tournament_id, v_players, v_rounds, v_courts);
  elsif t.format::text = 'team_americano' then
    v_rounds := generate_round_robin_matches(p_tournament_id, v_players, 'main', null, 0);
  else
    v_rounds := 1;
    perform build_ranked_round(p_tournament_id, 1, v_players, v_courts);
  end if;

  update tournaments
  set format_config = coalesce(format_config, '{}'::jsonb) - 'courts' - 'rounds'
    || jsonb_build_object('roster', to_jsonb(v_players))
    || case when v_courts is null then '{}'::jsonb else jsonb_build_object('courts', v_courts) end
    || case when t.format::text = 'americano' then jsonb_build_object('rounds', v_rounds) else '{}'::jsonb end
  where id = p_tournament_id;
  return v_rounds;
end;
$$;
revoke execute on function public.generate_points_format(uuid, integer, integer) from public, anon;
grant execute on function public.generate_points_format(uuid, integer, integer) to authenticated;

-- Mexicano / King of the Court: the next round once the current one is played.
create or replace function public.generate_next_round(p_tournament_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  t tournaments%rowtype;
  v_last integer;
  v_ranked uuid[];
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  select * into t from tournaments where id = p_tournament_id for update;
  if t.id is null then raise exception 'Tournament not found'; end if;
  if not format_is_dynamic(t.format) then
    raise exception using errcode = '22023', message = 'pointsFormat.notDynamic';
  end if;
  if t.status <> 'in_progress' then
    raise exception using errcode = '22023', message = 'pointsFormat.notStarted';
  end if;
  perform 1 from matches where tournament_id = p_tournament_id order by id for update;
  select max(round_number) into v_last from matches where tournament_id = p_tournament_id;
  if v_last is null then
    raise exception using errcode = '22023', message = 'pointsFormat.noRounds';
  end if;
  if exists (select 1 from matches where tournament_id = p_tournament_id and round_number = v_last and status <> 'finished') then
    raise exception using errcode = '22023', message = 'pointsFormat.roundUnfinished';
  end if;
  if t.format::text = 'king_of_court' then
    perform build_kotc_round(p_tournament_id, v_last + 1);
  else
    select array_agg(s.entry_id order by s.rank) into v_ranked from points_standings_rows(p_tournament_id) s;
    perform build_ranked_round(p_tournament_id, v_last + 1, v_ranked, (t.format_config->>'courts')::integer);
  end if;
  return v_last + 1;
end;
$$;
revoke execute on function public.generate_next_round(uuid) from public, anon;
grant execute on function public.generate_next_round(uuid) to authenticated;

-- Mexicano / King of the Court: remove the last round while nothing is scored in it.
create or replace function public.undo_last_round(p_tournament_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  t tournaments%rowtype;
  v_last integer;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  select * into t from tournaments where id = p_tournament_id for update;
  if t.id is null then raise exception 'Tournament not found'; end if;
  if not format_is_dynamic(t.format) then
    raise exception using errcode = '22023', message = 'pointsFormat.notDynamic';
  end if;
  if t.status = 'completed' then
    raise exception using errcode = '22023', message = 'lifecycle.completedLocked';
  end if;
  perform 1 from matches where tournament_id = p_tournament_id order by id for update;
  select max(round_number) into v_last from matches where tournament_id = p_tournament_id;
  if v_last is null or v_last < 2 then
    raise exception using errcode = '22023', message = 'pointsFormat.noRoundToUndo';
  end if;
  if exists (
    select 1 from matches m where m.tournament_id = p_tournament_id and m.round_number = v_last
      and (m.status = 'finished' or m.side_a_score is not null or m.side_b_score is not null
        or exists (select 1 from live_scores l where l.match_id = m.id))
  ) then
    raise exception using errcode = '22023', message = 'pointsFormat.roundHasResults';
  end if;
  delete from matches where tournament_id = p_tournament_id and round_number = v_last;
  return v_last - 1;
end;
$$;
revoke execute on function public.undo_last_round(uuid) from public, anon;
grant execute on function public.undo_last_round(uuid) to authenticated;

-- =============================================
-- Scoring
-- =============================================

create or replace function public.points_live_state(p_target integer, p_a integer, p_b integer)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object('family', 'points', 'points', jsonb_build_object('a', p_a, 'b', p_b),
    'target', p_target,
    'winner', case when p_a + p_b < p_target then null when p_a > p_b then 'a' when p_b > p_a then 'b' else 'draw' end);
$$;

create or replace function public.points_apply_point(p_state jsonb, p_side text)
returns jsonb language plpgsql immutable set search_path = public as $$
declare
  v_side text := lower(trim(p_side));
  v_a integer := coalesce((p_state#>>'{points,a}')::integer, 0);
  v_b integer := coalesce((p_state#>>'{points,b}')::integer, 0);
  v_target integer := (p_state->>'target')::integer;
begin
  if v_side not in ('a', 'b') then raise exception 'Invalid side'; end if;
  if nullif(p_state->>'winner', '') is not null then raise exception 'Match already finished'; end if;
  if v_side = 'a' then v_a := v_a + 1; else v_b := v_b + 1; end if;
  return points_live_state(v_target, v_a, v_b);
end;
$$;

-- One writer for manual saves, corrections and the end of a live match.
create or replace function public.write_points_result(p_match_id uuid, p_a integer, p_b integer, p_expected_revision integer, p_from_live boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  m matches%rowtype;
  t tournaments%rowtype;
  v_target integer;
  v_winner uuid;
begin
  select * into m from matches where id = p_match_id for update;
  if m.id is null then raise exception 'Match not found'; end if;
  select * into t from tournaments where id = m.tournament_id;
  if not can_live_score(m.tournament_id) then raise exception 'Not allowed'; end if;
  if not format_is_points(t.format) then
    raise exception using errcode = '22023', message = 'pointsFormat.notPointsFormat';
  end if;
  if t.status <> 'in_progress' then
    raise exception 'Scores can be entered only after the tournament starts';
  end if;
  if m.side_a_entry_id is null or m.side_b_entry_id is null
     or (format_is_individual(t.format) and (m.side_a2_entry_id is null or m.side_b2_entry_id is null)) then
    raise exception 'Both sides must be assigned before scoring';
  end if;
  if not p_from_live then
    if exists (select 1 from live_scores where match_id = p_match_id and status = 'active') then
      raise exception using errcode = 'P0001', message = 'scoringFlow.liveBlocked';
    end if;
    if p_expected_revision is null or p_expected_revision <> m.score_revision then
      raise exception using errcode = 'P0001', message = 'scoringFlow.conflict';
    end if;
  end if;
  v_target := points_target(t.scoring_config, t.format);
  if p_a is null or p_b is null or p_a < 0 or p_b < 0 or p_a + p_b <> v_target then
    raise exception using errcode = '22023', message = 'pointsFormat.invalidScore';
  end if;
  -- The next round of a dynamic format was built from this result.
  if format_is_dynamic(t.format) and exists (
    select 1 from matches o where o.tournament_id = m.tournament_id and o.round_number > m.round_number
  ) then
    raise exception using errcode = '22023', message = 'pointsFormat.laterRoundExists';
  end if;

  v_winner := case when p_a > p_b then m.side_a_entry_id when p_b > p_a then m.side_b_entry_id end;
  update matches
  set side_a_score = p_a, side_b_score = p_b, winner_entry_id = v_winner, status = 'finished'
  where id = p_match_id;

  -- A manual replacement becomes the live baseline; in-flight taps carry the
  -- old revision and cannot restore the pre-edit score.
  if not p_from_live then
    update live_scores set state = points_live_state(v_target, p_a, p_b), history = '[]'::jsonb,
      status = 'finished', revision = revision + 1
    where match_id = p_match_id;
  end if;
  return v_winner;
end;
$$;
revoke execute on function public.write_points_result(uuid, integer, integer, integer, boolean) from public, anon, authenticated;

create or replace function public.update_match_points(p_match_id uuid, p_a integer, p_b integer, p_expected_revision integer default null)
returns uuid
language sql
security definer
set search_path = public
as $$
  select write_points_result(p_match_id, p_a, p_b, p_expected_revision, false);
$$;
revoke execute on function public.update_match_points(uuid, integer, integer, integer) from public, anon;
grant execute on function public.update_match_points(uuid, integer, integer, integer) to authenticated;

-- =============================================
-- Live scoring: a points match counts rallies up to the total N
-- =============================================

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
  v_format tournament_format;
  v_scoring jsonb;
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
         tennis_scoring_rules(t.scoring_config), t.format, t.scoring_config
    into v_set_format, v_tournament_status, v_sport, v_rules, v_format, v_scoring
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

  if format_is_points(v_format) then
    if format_is_individual(v_format) and (v_match.side_a2_entry_id is null or v_match.side_b2_entry_id is null) then
      raise exception 'Both sides must be assigned before scoring';
    end if;
    select * into v_live from live_scores where match_id = p_match_id;
    if v_live.id is null then
      insert into live_scores (match_id, tournament_id, counter_user_id, status, state)
      values (p_match_id, v_match.tournament_id, auth.uid(), 'active', points_live_state(points_target(v_scoring, v_format), 0, 0))
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
  v_format tournament_format;
begin
  select *
    into v_match
  from matches
  where id = p_match_id
  for update;

  if v_match.id is null then
    raise exception 'Match not found';
  end if;

  select t.status, t.sport, t.format
    into v_tournament_status, v_sport, v_format
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

  if format_is_points(v_format) then
    if v_live.status = 'finished' then
      raise exception 'Match already finished';
    end if;
    v_new_state := points_apply_point(v_live.state, p_side);
    v_winner_side := v_new_state->>'winner';
    update live_scores
    set state = v_new_state,
        history = v_live.history || jsonb_build_array(v_live.state),
        status = case when v_winner_side is not null then 'finished' else 'active' end,
        revision = revision + 1
    where id = v_live.id
    returning * into v_live;
    -- The last rally of the total finishes the match with the live score.
    if v_winner_side is not null then
      perform write_points_result(p_match_id, (v_new_state#>>'{points,a}')::integer,
        (v_new_state#>>'{points,b}')::integer, null, true);
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

-- =============================================
-- Corrections, snapshot, roster, schedule and reminders know partners
-- =============================================

create or replace function public.write_correction_result(p_match_id uuid, p_result jsonb, p_expected_revision integer)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_sport sport; v_format tournament_format; v_field text;
begin
  select t.sport, t.format into v_sport, v_format from matches m join tournaments t on t.id = m.tournament_id where m.id = p_match_id;
  if format_is_points(v_format) then
    if jsonb_typeof(p_result->'a') is distinct from 'number' or jsonb_typeof(p_result->'b') is distinct from 'number' then
      raise exception using errcode = '22023', message = 'pointsFormat.invalidScore';
    end if;
    return write_points_result(p_match_id, (p_result->>'a')::numeric::integer, (p_result->>'b')::numeric::integer, p_expected_revision, false);
  end if;
  if v_sport in ('tennis','padel') then
    return write_match_sets_result(p_match_id,p_result->'sets',p_expected_revision,true);
  elsif v_sport='football' then
    foreach v_field in array array['a_goals','b_goals','a_pens','b_pens'] loop
      if p_result->v_field is not null and p_result->v_field<>'null'::jsonb then
        if jsonb_typeof(p_result->v_field)<>'number' or (p_result->>v_field)::numeric<>trunc((p_result->>v_field)::numeric) then
          raise exception 'Valid goal and penalty counts required';
        end if;
      end if;
    end loop;
    return write_football_result(p_match_id,(p_result->>'a_goals')::integer,(p_result->>'b_goals')::integer,
      (p_result->>'a_pens')::integer,(p_result->>'b_pens')::integer,p_expected_revision,true);
  end if;
  raise exception 'Unsupported sport';
end;
$$;
revoke execute on function public.write_correction_result(uuid, jsonb, integer) from public, anon, authenticated;

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
   else '{}'::jsonb end,
  'points_standings',case when format_is_points(t.format) then
   coalesce((select jsonb_agg(to_jsonb(s) order by s.rank,s.entry_id) from get_points_standings(t.id) s),'[]'::jsonb)
   else '[]'::jsonb end
 ) from tournaments t where t.id=p_tournament_id;
$$;

create or replace function public.tournament_roster_stale(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Every format places each approved entry in its first stage (round robin,
  -- groups, round 1 with BYEs), so the entries in matches are the field. A
  -- points format keeps its field in format_config.roster: a resting player
  -- is in no match of the round.
  with keeps_roster as (
    select format_is_points(t.format) and t.format_config ? 'roster' as yes
    from tournaments t where t.id = p_tournament_id
  ),
  playing as (
    select distinct x.entry_id
    from matches m
    cross join lateral unnest(match_participants(m)) x(entry_id)
    where m.tournament_id = p_tournament_id and not coalesce((select yes from keeps_roster), false)
    union
    select r.entry_id from unnest(points_roster(p_tournament_id)) r(entry_id)
    where coalesce((select yes from keeps_roster), false)
  ),
  approved as (
    select e.id as entry_id from entries e
    where e.tournament_id = p_tournament_id and e.status = 'approved'
  )
  select exists (select 1 from matches m where m.tournament_id = p_tournament_id)
    and (
      exists (select 1 from playing p where not exists (select 1 from approved a where a.entry_id = p.entry_id))
      or exists (select 1 from approved a where not exists (select 1 from playing p where p.entry_id = a.entry_id))
    );
$$;
revoke execute on function public.tournament_roster_stale(uuid) from public, anon, authenticated;

create or replace function public.match_schedule_conflicts(p_match_id uuid, p_court_id uuid, p_scheduled_at timestamptz, p_time_kind text, p_queue_order integer)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare m matches%rowtype; v_config jsonb; v_rest integer; v_out jsonb:='[]'::jsonb; r record; v_entries uuid[];
begin
 select * into m from matches where id=p_match_id;
 if m.id is null then raise exception 'Match not found'; end if;
 select schedule_config into v_config from tournaments where id=m.tournament_id;
 v_rest:=coalesce(nullif(v_config->>'min_rest_minutes','')::integer,0);
 v_entries:=match_participants(m);
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
    join lateral (select unnest(match_participants(o)) as entry_id) x on x.entry_id=any(v_entries)
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

create or replace function public.enqueue_match_reminders(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into notification_outbox (kind, tournament_id, entry_id, match_id)
  select 'match_reminder', m.tournament_id, e.id, m.id
  from match_schedule s
  join matches m on m.id = s.match_id
  join tournaments t on t.id = m.tournament_id and t.status = 'in_progress'
  cross join lateral unnest(match_participants(m)) side(entry_id)
  join entries e on e.id = side.entry_id and e.status = 'approved'
  where s.state = 'published'
    and s.time_kind = 'fixed'
    and s.scheduled_at > p_now
    and s.scheduled_at <= p_now + interval '35 minutes'
    and m.status <> 'finished'
    and m.side_a_entry_id is not null
    and m.side_b_entry_id is not null
    and entry_email(e.contact_email, e.phone_or_email) is not null
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
create or replace function public.claim_notifications(p_limit integer default 20)
returns table (
  id uuid,
  kind text,
  locale text,
  recipient text,
  entry_name text,
  tournament_name text,
  tournament_slug text,
  time_zone text,
  scheduled_at timestamptz,
  court_name text,
  opponent_name text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform enqueue_match_reminders(now());
  -- A sender that died mid-batch leaves rows in "sending"; hand them out again.
  update notification_outbox o set status = 'pending'
  where o.status = 'sending' and o.claimed_at < now() - interval '10 minutes';
  -- A reminder whose match is over, or no longer has an address, is not sent.
  update notification_outbox o set status = 'skipped'
  where o.status = 'pending' and o.kind = 'match_reminder'
    and exists (select 1 from matches m where m.id = o.match_id and m.status = 'finished');
  update notification_outbox o set status = 'skipped'
  where o.status = 'pending'
    and exists (select 1 from entries e where e.id = o.entry_id and entry_email(e.contact_email, e.phone_or_email) is null);

  return query
  with picked as (
    select o.id from notification_outbox o
    where o.status = 'pending' and o.send_after <= now()
    order by o.send_after, o.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), marked as (
    update notification_outbox o
    set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
    from picked where o.id = picked.id
    returning o.*
  )
  select
    mk.id,
    mk.kind,
    coalesce(e.notify_locale, 'lt'),
    entry_email(e.contact_email, e.phone_or_email),
    e.display_name,
    t.name,
    t.slug,
    nullif(t.schedule_config->>'timezone', ''),
    s.scheduled_at,
    c.name,
    opponent.display_name
  from marked mk
  join entries e on e.id = mk.entry_id
  join tournaments t on t.id = mk.tournament_id
  left join matches m on m.id = mk.match_id
  left join match_schedule s on s.match_id = m.id and s.state = 'published'
  left join courts c on c.id = s.court_id
  -- The other side: one entry, or the two players of a points-format match.
  left join lateral (
    select string_agg(o.display_name, ' / ' order by v.ord) as display_name
    from (values
      (case when e.id in (m.side_a_entry_id, m.side_a2_entry_id) then m.side_b_entry_id else m.side_a_entry_id end, 1),
      (case when e.id in (m.side_a_entry_id, m.side_a2_entry_id) then m.side_b2_entry_id else m.side_a2_entry_id end, 2)) v(eid, ord)
    join entries o on o.id = v.eid
  ) opponent on true;
end;
$$;

notify pgrst, 'reload schema';
