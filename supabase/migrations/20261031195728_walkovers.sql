-- =============================================
-- WALKOVERS, RETIREMENTS, WITHDRAWALS
-- =============================================
-- A match can end without being played out:
--   * W.O. (walkover): a side did not come. Tennis / padel: the winner gets
--     the match in straight sets to love (6:0 6:0, 4:0 in short sets, the
--     deciding match tie-break 10:0); football: 3:0.
--   * RET (retired): a side stopped during the match. The sets played stay;
--     the unfinished set and the remaining sets go to the winner (ITF rule:
--     6:3 2:1 RET counts as 6:3 6:1).
-- The result is written through the ordinary validators, so standings, the
-- bracket and the schedule treat it like any finished match;
-- matches.result_type only labels it. Any later ordinary result write clears
-- the label.
--
-- A withdrawn participant (entries.withdrawn_at, organizers only, while the
-- tournament runs) keeps the results played; every unfinished match becomes a
-- walkover for the opponent, and a match the withdrawn participant reaches
-- later (knockout, losers bracket) becomes one as soon as both sides are
-- known. Mexicano: the player sits out every next round and earns no rest
-- points after leaving. Americano, Team Americano and King of the Court have
-- a fixed field: replace the player in the entry instead. Safe to re-run.

alter table public.matches add column if not exists result_type text;
alter table public.matches drop constraint if exists matches_result_type_ck;
alter table public.matches add constraint matches_result_type_ck
  check (result_type is null or result_type in ('walkover', 'retired'));

alter table public.entries add column if not exists withdrawn_at timestamptz;
grant select (withdrawn_at) on public.entries to anon, authenticated;

-- The completed sets for a walkover (no sets played) or a retirement (the
-- sets played so far; the last one may be unfinished). p_winner is 'a' or 'b'.
create or replace function public.special_result_sets(p_rules jsonb, p_required integer, p_played jsonb, p_winner text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_rule jsonb;
  v_res integer;
  v_count integer := coalesce(jsonb_array_length(p_played), 0);
  v_idx integer := 0;
  v_wins integer := 0;
  v_losses integer := 0;
  w integer; l integer; wt integer; lt integer;
  g integer; at_game integer; target integer; margin integer;
  wk text := case when p_winner = 'a' then 'side_a' else 'side_b' end;
  lk text := case when p_winner = 'a' then 'side_b' else 'side_a' end;
begin
  if p_winner is null or p_winner not in ('a', 'b') then
    raise exception 'walkover.invalidWinner';
  end if;
  if p_played is not null and jsonb_typeof(p_played) <> 'array' then
    raise exception 'walkover.invalidSets';
  end if;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_played, '[]'::jsonb))
    order by (value->>'set_index')::numeric
  loop
    v_idx := v_idx + 1;
    if jsonb_typeof(v_item) <> 'object' or (v_item->>'set_index')::numeric is distinct from v_idx
       or v_wins = p_required or v_losses = p_required then
      raise exception 'walkover.invalidSets';
    end if;
    v_rule := tennis_set_rule(p_rules, v_idx, p_required);
    v_res := tennis_set_result(v_item - 'score_kind', v_rule);
    if v_res = -1 then
      raise exception 'walkover.invalidSets';
    end if;
    w := (v_item->>(wk || '_games'))::numeric::integer;
    l := (v_item->>(lk || '_games'))::numeric::integer;
    wt := (v_item->>(wk || '_tiebreak'))::numeric::integer;
    lt := (v_item->>(lk || '_tiebreak'))::numeric::integer;
    if v_res > 0 then
      if (v_res = 1) = (p_winner = 'a') then v_wins := v_wins + 1; else v_losses := v_losses + 1; end if;
    else
      if v_idx <> v_count then
        raise exception 'walkover.invalidSets';
      end if;
      -- The unfinished set goes to the winner by the smallest complete score.
      target := (v_rule->>'target')::integer;
      margin := (v_rule->>'margin')::integer;
      if v_rule->>'kind' = 'match_tiebreak' then
        lt := coalesce(lt, 0);
        wt := greatest(target, lt + margin);
        w := 0; l := 0;
      else
        g := (v_rule->>'games_to')::integer;
        at_game := (v_rule->>'at')::integer;
        if at_game is not null and l >= at_game then
          w := at_game + 1; l := at_game;
          lt := coalesce(lt, 0);
          wt := greatest(target, lt + margin);
        else
          w := greatest(g, l + 2);
          wt := null; lt := null;
        end if;
      end if;
      v_wins := v_wins + 1;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'set_index', v_idx,
      'side_a_games', case when p_winner = 'a' then w else l end,
      'side_b_games', case when p_winner = 'a' then l else w end,
      'side_a_tiebreak', case when p_winner = 'a' then wt else lt end,
      'side_b_tiebreak', case when p_winner = 'a' then lt else wt end)));
  end loop;

  -- The remaining sets to love.
  while v_wins < p_required loop
    v_idx := v_idx + 1;
    v_rule := tennis_set_rule(p_rules, v_idx, p_required);
    if v_rule->>'kind' = 'match_tiebreak' then
      w := 0; l := 0; wt := (v_rule->>'target')::integer; lt := 0;
    else
      w := (v_rule->>'games_to')::integer; l := 0; wt := null; lt := null;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'set_index', v_idx,
      'side_a_games', case when p_winner = 'a' then w else l end,
      'side_b_games', case when p_winner = 'a' then l else w end,
      'side_a_tiebreak', case when p_winner = 'a' then wt else lt end,
      'side_b_tiebreak', case when p_winner = 'a' then lt else wt end)));
    v_wins := v_wins + 1;
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.special_result_sets(jsonb, integer, jsonb, text) from public, anon, authenticated;

-- An ordinary result write clears the label: a changed score, winner or side,
-- or new set rows. The special write marks its own match in
-- bracketa.special_result so its own rows keep the label.
create or replace function public.matches_result_type_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.result_type is null then return new; end if;
  if new.winner_entry_id is null then
    new.result_type := null;
    return new;
  end if;
  if new.result_type is distinct from old.result_type
     or coalesce(current_setting('bracketa.special_result', true), '') = new.id::text then
    return new;
  end if;
  if (new.side_a_score, new.side_b_score, new.side_a_pens, new.side_b_pens,
      new.winner_entry_id, new.side_a_entry_id, new.side_b_entry_id)
     is distinct from
     (old.side_a_score, old.side_b_score, old.side_a_pens, old.side_b_pens,
      old.winner_entry_id, old.side_a_entry_id, old.side_b_entry_id) then
    new.result_type := null;
  end if;
  return new;
end;
$$;
revoke execute on function public.matches_result_type_guard() from public, anon, authenticated;
drop trigger if exists trg_matches_result_type_guard on public.matches;
create trigger trg_matches_result_type_guard before update on public.matches
for each row execute function public.matches_result_type_guard();

create or replace function public.match_sets_clear_result_type()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('bracketa.special_result', true), '') <> new.match_id::text then
    update matches set result_type = null where id = new.match_id and result_type is not null;
  end if;
  return null;
end;
$$;
revoke execute on function public.match_sets_clear_result_type() from public, anon, authenticated;
drop trigger if exists trg_match_sets_clear_result_type on public.match_sets;
create trigger trg_match_sets_clear_result_type after insert or update on public.match_sets
for each row execute function public.match_sets_clear_result_type();

-- The write shared by the RPCs and the automatic walkover. No permission
-- check here: callers check, and the ordinary writers check again.
create or replace function public.write_special_result(p_match_id uuid, p_type text, p_winner uuid, p_played jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  m matches%rowtype;
  t tournaments%rowtype;
  v_side text;
  v_played jsonb;
  v_required integer;
  v_new uuid;
begin
  if p_type is null or p_type not in ('walkover', 'retired') then
    raise exception 'walkover.invalidType';
  end if;
  select * into m from matches where id = p_match_id for update;
  if m.id is null then raise exception 'Match not found'; end if;
  select * into t from tournaments where id = m.tournament_id;
  if format_is_points(t.format) then raise exception 'walkover.pointsFormat'; end if;
  if m.status = 'finished' or m.winner_entry_id is not null then raise exception 'walkover.finished'; end if;
  if m.side_a_entry_id is null or m.side_b_entry_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;
  v_side := case when p_winner = m.side_a_entry_id then 'a' when p_winner = m.side_b_entry_id then 'b' end;
  if v_side is null then raise exception 'walkover.invalidWinner'; end if;
  if t.sport = 'football' and p_type <> 'walkover' then raise exception 'walkover.footballRetired'; end if;

  -- A retirement keeps what was played: the given sets, else the stored ones
  -- (live scoring stores finished and current games as it goes).
  if p_type = 'retired' then
    v_played := coalesce(p_played, (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'set_index', s.set_index, 'side_a_games', s.side_a_games, 'side_b_games', s.side_b_games,
        'side_a_tiebreak', s.side_a_tiebreak, 'side_b_tiebreak', s.side_b_tiebreak)) order by s.set_index)
      from match_sets s where s.match_id = m.id), '[]'::jsonb);
  end if;

  -- An active live session ends with the result.
  update live_scores set status = 'stopped', revision = revision + 1 where match_id = m.id and status = 'active';

  perform set_config('bracketa.special_result', m.id::text, true);
  if t.sport = 'football' then
    v_new := write_football_result(m.id, case when v_side = 'a' then 3 else 0 end, case when v_side = 'b' then 3 else 0 end,
      null, null, (select score_revision from matches where id = m.id), false);
  else
    v_required := case when t.set_format = 'best_of_5' then 3 else 2 end;
    v_new := write_match_sets_result(m.id,
      special_result_sets(tennis_scoring_rules(t.scoring_config), v_required, coalesce(v_played, '[]'::jsonb), v_side),
      (select score_revision from matches where id = m.id), false);
  end if;
  perform set_config('bracketa.special_result', m.id::text, true);
  update matches set result_type = p_type where id = m.id;
  perform set_config('bracketa.special_result', '', true);
  return v_new;
end;
$$;
revoke execute on function public.write_special_result(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- W.O. or RET from the score forms: owners, editors and results-only counters.
-- p_sets (RET only): the sets played; null takes the stored ones.
create or replace function public.record_special_result(
  p_match_id uuid,
  p_type text,
  p_winner_entry_id uuid,
  p_sets jsonb default null,
  p_expected_revision integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare m matches%rowtype;
begin
  select * into m from matches where id = p_match_id;
  if m.id is null then raise exception 'Match not found'; end if;
  if not can_live_score(m.tournament_id) then raise exception 'Not allowed'; end if;
  if p_expected_revision is null or p_expected_revision <> m.score_revision then
    raise exception using errcode = 'P0001', message = 'scoringFlow.conflict';
  end if;
  return write_special_result(p_match_id, p_type, p_winner_entry_id, p_sets);
end;
$$;
revoke execute on function public.record_special_result(uuid, text, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.record_special_result(uuid, text, uuid, jsonb, integer) to authenticated;

-- Withdraw a participant (p_withdrawn) or take the withdrawal back. Returns
-- the number of walkovers written. Taking it back keeps those results.
create or replace function public.set_entry_withdrawn(p_entry_id uuid, p_withdrawn boolean)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  e entries%rowtype;
  t tournaments%rowtype;
  r record;
  n integer := 0;
begin
  select * into e from entries where id = p_entry_id;
  if e.id is null then raise exception 'entryEdit.notFound'; end if;
  if not is_tournament_admin(e.tournament_id) then raise exception 'Not allowed'; end if;
  select * into t from tournaments where id = e.tournament_id for update;
  perform 1 from matches where tournament_id = t.id order by id for update;
  select * into e from entries where id = p_entry_id for update;
  if t.status <> 'in_progress' then raise exception 'walkover.notStarted'; end if;
  if e.status <> 'approved' then raise exception 'walkover.notApproved'; end if;
  if format_is_points(t.format) and t.format::text <> 'mexicano' then raise exception 'walkover.replaceInstead'; end if;

  if not coalesce(p_withdrawn, false) then
    update entries set withdrawn_at = null where id = e.id and withdrawn_at is not null;
    return 0;
  end if;
  if e.withdrawn_at is not null then return 0; end if;
  if exists (
    select 1 from matches mm join live_scores l on l.match_id = mm.id and l.status = 'active'
    where mm.tournament_id = t.id and mm.status <> 'finished' and e.id = any (match_participants(mm))
  ) then
    raise exception 'walkover.liveMatch';
  end if;

  update entries set withdrawn_at = now() where id = e.id;
  if format_is_points(t.format) then return 0; end if;

  for r in
    select mm.id, case when mm.side_a_entry_id = e.id then mm.side_b_entry_id else mm.side_a_entry_id end as other
    from matches mm
    where mm.tournament_id = t.id and mm.status <> 'finished' and mm.winner_entry_id is null
      and e.id in (mm.side_a_entry_id, mm.side_b_entry_id)
      and mm.side_a_entry_id is not null and mm.side_b_entry_id is not null
    order by mm.stage, mm.round_number, mm.match_number
  loop
    -- A walkover written earlier in the loop may have resolved it already;
    -- two withdrawn sides are left to the organizer.
    if exists (select 1 from matches where id = r.id and status <> 'finished' and winner_entry_id is null)
       and (select withdrawn_at from entries where id = r.other) is null then
      perform write_special_result(r.id, 'walkover', r.other, null);
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke execute on function public.set_entry_withdrawn(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_entry_withdrawn(uuid, boolean) to authenticated;

-- A withdrawn participant reached a match whose other side is known: the
-- opponent gets the walkover at once. A failure leaves the match to the
-- organizer and never undoes the action that placed the participant.
create or replace function public.matches_auto_walkover()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  wa timestamptz;
  wb timestamptz;
  t tournaments%rowtype;
begin
  if new.status = 'finished' or new.winner_entry_id is not null
     or new.side_a_entry_id is null or new.side_b_entry_id is null then
    return null;
  end if;
  select withdrawn_at into wa from entries where id = new.side_a_entry_id;
  select withdrawn_at into wb from entries where id = new.side_b_entry_id;
  if (wa is null) = (wb is null) then return null; end if;
  select * into t from tournaments where id = new.tournament_id;
  if t.status <> 'in_progress' or format_is_points(t.format) then return null; end if;
  begin
    perform write_special_result(new.id, 'walkover',
      case when wa is null then new.side_a_entry_id else new.side_b_entry_id end, null);
  exception when others then
    null;
  end;
  return null;
end;
$$;
revoke execute on function public.matches_auto_walkover() from public, anon, authenticated;
drop trigger if exists trg_matches_auto_walkover on public.matches;
create trigger trg_matches_auto_walkover after update of side_a_entry_id, side_b_entry_id on public.matches
for each row execute function public.matches_auto_walkover();

-- Mexicano: withdrawn players sit out the next rounds.
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
    -- Withdrawn players sit out; fewer players can fill fewer courts.
    select array_agg(s.entry_id order by s.rank) into v_ranked from points_standings_rows(p_tournament_id) s
    where not exists (select 1 from entries w where w.id = s.entry_id and w.withdrawn_at is not null);
    if coalesce(array_length(v_ranked, 1), 0) < 4 then
      raise exception using errcode = '22023', message = 'walkover.notEnoughPlayers';
    end if;
    perform build_ranked_round(p_tournament_id, v_last + 1, v_ranked,
      least((t.format_config->>'courts')::integer, array_length(v_ranked, 1) / 4));
  end if;
  perform set_config('bracketa.points_generator', '', true);
  return v_last + 1;
end;
$$;
revoke execute on function public.generate_next_round(uuid) from public, anon;
grant execute on function public.generate_next_round(uuid) to authenticated;

-- Points table: no rest compensation after a player withdrew.
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
      -- no rest points for rounds made after the player withdrew
      and not exists (select 1 from entries w where w.id = r.id and w.withdrawn_at is not null
        and w.withdrawn_at < (select min(m.created_at) from matches m
          where m.tournament_id = p_tournament_id and m.round_number = d.round_number))
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

-- The pair editor compares its copy of the entries with this snapshot, so it
-- carries withdrawn_at like the sync state.
create or replace function tournament_entry_snapshot(p_tournament_id uuid)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,'seed_order',e.seed_order,
  'withdrawn_at',e.withdrawn_at,
  'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,'member_name',em.member_name,'member_order',em.member_order) order by em.member_order) from entry_members em where em.entry_id=e.id),'[]'::jsonb)) order by e.id),'[]')
 from entries e where e.tournament_id=p_tournament_id;
$$;

-- Snapshot: entries carry withdrawn_at; matches carry result_type (to_jsonb).
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
   'entry_type',e.entry_type,'status',e.status,'withdrawn_at',e.withdrawn_at,'created_at',e.created_at,'seed_order',e.seed_order,
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

notify pgrst, 'reload schema';
