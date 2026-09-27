-- Padel points formats: guards and the rules most competitors use
-- (docs/PADEL_COMPETITORS.md). Safe to re-run: functions are replaced,
-- the trigger and the policy are dropped and created again.
--
-- Guards
-- * Matches of a points tournament come only from generate_points_format and
--   generate_next_round. The knockout, round-robin and group generators
--   (generate_bracket, rebuild_bracket, generate_round_robin, generate_groups …)
--   and direct API inserts are refused: they built a playable knockout bracket
--   over the rounds. The two points generators raise a transaction-local flag
--   around their inserts; the trigger checks it for API requests only (role
--   authenticated/anon, kept inside security definer functions), so
--   maintenance scripts and tests running as the database owner are not
--   affected.
-- * Admins delete matches directly only before the start (the UI "reset
--   bracket"). A running or completed tournament keeps its matches and
--   results; generators run as the owner and are not bound by this policy.
--
-- Rules
-- * A completed round of rest earns floor(N / 2) points, N = points per match
--   (the average score of a match), instead of the player's own average.
-- * Standings: total points, then wins, draws, point difference.
-- * Mexicano / King of the Court: round 1 is a random draw by default,
--   format_config.first_round = 'seeded' follows the seeding instead.
-- * King of the Court: the number of rounds is set before the start
--   (format_config.rounds, default courts + 3 and at least 5); the next round
--   is refused after the last one. Mexicano stays open-ended.
-- * Americano: the default is a full partner cycle, floor(n(n-1)/2 / (2 *
--   courts)) rounds (every pair of players partners once as far as possible);
--   with rests the schedule is also built round by round and the candidate
--   with the fewest repeated partners wins.

create or replace function public.guard_points_format_matches()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('role', true), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if coalesce(current_setting('bracketa.points_generator', true), '') = 'on' then
    return new;
  end if;
  if exists (select 1 from tournaments t where t.id = new.tournament_id and format_is_points(t.format)) then
    raise exception using errcode = '22023', message = 'pointsFormat.useRounds';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_points_format_matches() from public, anon, authenticated;
drop trigger if exists trg_guard_points_format_matches on public.matches;
create trigger trg_guard_points_format_matches before insert on public.matches
for each row execute function public.guard_points_format_matches();

drop policy if exists matches_delete_admin on public.matches;
create policy matches_delete_admin on public.matches
for delete
to authenticated
using (
  is_tournament_admin(tournament_id)
  and exists (
    select 1 from tournaments t
    where t.id = matches.tournament_id
      and t.status not in ('in_progress', 'completed')
  )
);

-- Standings: a rest earns floor(N / 2); ties go to wins, draws, then difference.
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
      coalesce(rc.n, 0) * (points_target((select scoring_config from t), (select format from t)) / 2) as compensation,
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
      x.pf + x.compensation desc, x.won desc, x.drawn desc, x.pf - x.pa desc,
      x.seed_order nulls last, lower(x.display_name), x.id))::integer
  from ranked x;
$$;
revoke execute on function public.points_standings_rows(uuid) from public, anon, authenticated;

-- Americano schedule candidates: round by round next to the circle orders.
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
      -- Those who rested most play; among equals, those with the most partners still to meet.
      select array_agg(x order by (v_rests->>x::text)::integer desc,
          (select count(*) from unnest(p_players) y
            where y <> x and not v_partner ? (least(x::text, y::text) || ':' || greatest(x::text, y::text))) desc,
          random()) into v_play
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
  -- spread. Circle orders that keep rests within one of each other and
  -- schedules built round by round compete; the one with the fewest repeated
  -- partners, then opponents, is stored.
  for v_attempt in 1..40 loop
    select array_agg(x order by random()) into v_try from unnest(p_players) x;
    if array_length(v_try, 1) % 2 = 1 then v_try := v_try || null::uuid; end if;
    if americano_rest_spread(v_try, p_rounds, p_courts) <= 1 then
      v_orders := v_orders || array[v_try];
      exit when array_length(v_orders, 1) >= 8;
    end if;
  end loop;
  for v_attempt in 1..coalesce(array_length(v_orders, 1), 0) loop
    v_plan := americano_plan(p_players, array(select unnest(v_orders[v_attempt:v_attempt][1:])), p_rounds, p_courts);
    if v_best is null or (v_plan->>'cost')::integer < (v_best->>'cost')::integer then v_best := v_plan; end if;
  end loop;
  -- A circle repeats its partners after one cycle: longer schedules (a full
  -- partner cycle with rests) do better round by round. Within one cycle a
  -- circle order never repeats a partner, so it is kept as is.
  if v_best is null or p_rounds > array_length(v_orders[1:1][1:], 2) - 1 then
    for v_attempt in 1..8 loop
      v_plan := americano_plan(p_players, null, p_rounds, p_courts);
      if v_best is null or (v_plan->>'cost')::integer < (v_best->>'cost')::integer then v_best := v_plan; end if;
    end loop;
  end if;

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
revoke execute on function public.americano_plan(uuid[], uuid[], integer, integer) from public, anon, authenticated;

-- Generators: round 1 draw, King of the Court rounds, the full Americano cycle.
drop function if exists public.generate_points_format(uuid, integer, integer);
create or replace function public.generate_points_format(p_tournament_id uuid, p_rounds integer default null, p_courts integer default null, p_first_round text default null)
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
  v_full integer;
  v_rounds integer;
  v_first text := coalesce(p_first_round, 'random');
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  perform assert_structure_regenerable(p_tournament_id);
  select * into t from tournaments where id = p_tournament_id;
  if not format_is_points(t.format) then
    raise exception using errcode = '22023', message = 'pointsFormat.notPointsFormat';
  end if;
  if v_first not in ('random', 'seeded') then
    raise exception using errcode = '22023', message = 'pointsFormat.invalidFirstRound';
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

  perform set_config('bracketa.points_generator', 'on', true);
  if t.format::text = 'americano' then
    -- One circle cycle, and the full partner cycle: every pair of players
    -- partners once as far as the courts allow.
    v_cycle := v_n + v_n % 2 - 1;
    v_full := (v_n * (v_n - 1) / 2) / (2 * v_courts);
    v_rounds := coalesce(p_rounds, v_full);
    if v_rounds < 1 or v_rounds > greatest(3 * v_cycle, v_full) then
      raise exception using errcode = '22023', message = 'pointsFormat.invalidRounds';
    end if;
    perform build_americano_rounds(p_tournament_id, v_players, v_rounds, v_courts);
  elsif t.format::text = 'team_americano' then
    v_rounds := generate_round_robin_matches(p_tournament_id, v_players, 'main', null, 0);
  else
    if t.format::text = 'king_of_court' then
      v_rounds := coalesce(p_rounds, greatest(5, v_courts + 3));
      if v_rounds < 2 or v_rounds > 30 then
        raise exception using errcode = '22023', message = 'pointsFormat.invalidRounds';
      end if;
    end if;
    if v_first = 'random' then
      select array_agg(x order by random()) into v_players from unnest(v_players) x;
    end if;
    perform build_ranked_round(p_tournament_id, 1, v_players, v_courts);
  end if;
  perform set_config('bracketa.points_generator', '', true);

  update tournaments
  set format_config = coalesce(format_config, '{}'::jsonb) - 'courts' - 'rounds' - 'first_round'
    || jsonb_build_object('roster', to_jsonb(v_players))
    || case when v_courts is null then '{}'::jsonb else jsonb_build_object('courts', v_courts) end
    || case when t.format::text in ('americano', 'king_of_court') then jsonb_build_object('rounds', v_rounds) else '{}'::jsonb end
    || case when format_is_dynamic(t.format) then jsonb_build_object('first_round', v_first) else '{}'::jsonb end
  where id = p_tournament_id;
  -- Mexicano and King of the Court: one round now, the next ones on demand.
  return case when format_is_dynamic(t.format) then 1 else v_rounds end;
end;
$$;
revoke execute on function public.generate_points_format(uuid, integer, integer, text) from public, anon;
grant execute on function public.generate_points_format(uuid, integer, integer, text) to authenticated;

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
  -- King of the Court plays the number of rounds set before the start: the
  -- champions are the winners on court 1 in the last one.
  if t.format::text = 'king_of_court' and v_last >= coalesce((t.format_config->>'rounds')::integer, 2147483647) then
    raise exception using errcode = '22023', message = 'pointsFormat.lastRoundPlayed';
  end if;
  perform set_config('bracketa.points_generator', 'on', true);
  if t.format::text = 'king_of_court' then
    perform build_kotc_round(p_tournament_id, v_last + 1);
  else
    select array_agg(s.entry_id order by s.rank) into v_ranked from points_standings_rows(p_tournament_id) s;
    perform build_ranked_round(p_tournament_id, v_last + 1, v_ranked, (t.format_config->>'courts')::integer);
  end if;
  perform set_config('bracketa.points_generator', '', true);
  return v_last + 1;
end;
$$;
revoke execute on function public.generate_next_round(uuid) from public, anon;
grant execute on function public.generate_next_round(uuid) to authenticated;

notify pgrst, 'reload schema';
