-- =============================================
-- DOUBLE ELIMINATION FOR ANY FIELD SIZE
-- =============================================
-- Double elimination no longer needs 4/8/16/32 entries. The winners bracket
-- is built like a knockout draw of the next power of two, with BYEs placed by
-- the draw mode (random: spread evenly; strict and tennis seeding: opposite
-- the top seeds), and the losers bracket absorbs the gaps:
--   * a first-round BYE match is decided at once; it has no loser, so its
--     losers-bracket link is removed;
--   * a losers-bracket first-round match that both of its feeders skip (two
--     BYE matches) would never be played and is deleted;
--   * a match whose other slot has no feeder left is a BYE in the losers
--     bracket: the entrant moves on as soon as they arrive (de_resolve_bye,
--     called from propagate_winner, so result corrections replay it too).
-- In a double-elimination draw the BYE places are fixed by the draw:
-- rearranging may swap players but not move a BYE. Single elimination and
-- group playoffs are unchanged. Safe to re-run.

-- First-round slots for a random draw (entries already shuffled): every
-- match gets a player and the BYEs are spread evenly, as in generate_bracket.
create or replace function public.knockout_random_slots(p_ids uuid[])
returns uuid[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v_count integer := coalesce(array_length(p_ids, 1), 0);
  v_size integer := 1;
  v_matches integer;
  v_byes integer;
  v_next integer := 1;
  v_slots uuid[] := '{}';
  v_m integer;
begin
  while v_size < v_count loop
    v_size := v_size * 2;
  end loop;
  v_matches := v_size / 2;
  v_byes := v_size - v_count;
  for v_m in 1 .. v_matches loop
    v_slots := array_append(v_slots, p_ids[v_next]);
    v_next := v_next + 1;
    if (v_m * v_byes) / v_matches = ((v_m - 1) * v_byes) / v_matches then
      v_slots := array_append(v_slots, p_ids[v_next]);
      v_next := v_next + 1;
    else
      v_slots := array_append(v_slots, null::uuid);
    end if;
  end loop;
  return v_slots;
end;
$$;
revoke execute on function public.knockout_random_slots(uuid[]) from public, anon, authenticated;

-- A double-elimination match holding one entrant whose other slot can never
-- be filled (no match feeds it any more) is decided for that entrant.
create or replace function public.de_resolve_bye(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m matches%rowtype;
  v_entrant uuid;
  v_empty text;
begin
  if p_match_id is null then return; end if;
  select * into m from matches where id = p_match_id for update;
  if m.id is null or m.status = 'finished' or m.winner_entry_id is not null then return; end if;
  if m.stage not in ('winners', 'losers', 'grand_final') then return; end if;
  if not exists (select 1 from tournaments t where t.id = m.tournament_id and t.format = 'double_elimination') then return; end if;
  if num_nonnulls(m.side_a_entry_id, m.side_b_entry_id) <> 1 then return; end if;
  v_entrant := coalesce(m.side_a_entry_id, m.side_b_entry_id);
  v_empty := case when m.side_a_entry_id is null then 'A' else 'B' end;
  if exists (
    select 1 from matches f
    where (f.next_match_id = m.id and f.next_slot = v_empty)
       or (f.loser_next_match_id = m.id and f.loser_next_slot = v_empty)
  ) then return; end if;
  update matches set winner_entry_id = v_entrant, status = 'finished' where id = m.id;
  perform propagate_winner(m.id, v_entrant);
end;
$$;
revoke execute on function public.de_resolve_bye(uuid) from public, anon, authenticated;

-- p_slots: first-round slots in bracket order, a power of two long, NULL = BYE
-- (generate_bracket builds them from the draw mode). Two slots and no BYE is
-- the old two-player case.
create or replace function public.generate_double_elim(
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
  v_entrants integer;
  v_b integer;
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
  v_byes uuid[] := '{}';
  v_bye record;
begin
  v_count := coalesce(array_length(p_seeds, 1), 0);
  v_entrants := (select count(*) from unnest(p_seeds) x where x is not null);
  if v_entrants < 2 then
    raise exception 'At least 2 seeds required';
  end if;
  -- A plain list of entries (no BYE slots) is padded like a random draw.
  if (v_count & (v_count - 1)) <> 0 then
    if v_entrants <> v_count then
      raise exception 'Invalid double elimination slots';
    end if;
    p_seeds := knockout_random_slots(p_seeds);
    v_count := array_length(p_seeds, 1);
  end if;
  v_b := v_count;

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

  drop table if exists tmp_de;
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

  -- Seed winners bracket round 1. A BYE match has no loser: its link to the
  -- losers bracket goes.
  v_cnt := v_b / 2;
  for v_m in 1..v_cnt loop
    v_side_a := p_seeds[2 * v_m - 1];
    v_side_b := p_seeds[2 * v_m];
    select id into v_id from tmp_de where br = 'W' and rnd = 1 and mno = v_m;
    if v_side_a is null or v_side_b is null then
      update matches set side_a_entry_id = v_side_a, side_b_entry_id = v_side_b,
        winner_entry_id = coalesce(v_side_a, v_side_b), status = 'finished'::match_status,
        loser_next_match_id = null, loser_next_slot = null
      where id = v_id;
      v_byes := v_byes || v_id;
    else
      update matches set side_a_entry_id = v_side_a, side_b_entry_id = v_side_b,
        status = 'ready'::match_status where id = v_id;
    end if;
  end loop;

  -- A losers-bracket first-round match fed by two BYE matches would never be
  -- played: drop it (the next round then sees a slot nobody feeds).
  delete from matches d
  where d.id in (select id from tmp_de where br = 'L' and rnd = 1)
    and not exists (select 1 from matches f where f.loser_next_match_id = d.id or f.next_match_id = d.id);

  -- BYE winners move on; the matches they enter resolve their own BYEs.
  for v_bye in select m.id, m.winner_entry_id from matches m where m.id = any(v_byes) order by m.match_number loop
    perform propagate_winner(v_bye.id, v_bye.winner_entry_id);
  end loop;

  drop table if exists tmp_de;
end;
$$;
revoke execute on function public.generate_double_elim(uuid, uuid[]) from public, anon, authenticated;

-- propagate_winner: after routing, resolve losers-bracket BYEs.
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

  -- Double elimination: a match reached may have no opponent left to come.
  perform de_resolve_bye(v_next_match_id);
  perform de_resolve_bye(v_loser_next_id);
end;
$$;

-- generate_bracket: double elimination takes every draw mode and field size.
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

  if p_mode in ('manual', 'seeded') then
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

  -- Double elimination is built by a dedicated generator from first-round
  -- slots (NULL = BYE).
  if v_tournament.format = 'double_elimination' then
    -- Any field size: the draw mode lays out the winners bracket with its
    -- BYEs and generate_double_elim builds the losers bracket around them.
    if p_mode = 'manual' then
      v_ordered_ids := knockout_seeded_slots(v_ordered_ids);
    elsif p_mode = 'seeded' then
      v_ordered_ids := knockout_tennis_slots(v_ordered_ids);
    else
      v_ordered_ids := knockout_random_slots(v_ordered_ids);
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
  elsif p_mode = 'seeded' then
    -- Tennis draw: seeds on fixed lines with the BYEs, the rest by lot.
    v_slots := knockout_tennis_slots(v_ordered_ids);
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

-- apply_bracket_layout: BYE places are fixed in double elimination.
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
  -- The losers bracket is built around the draw's BYEs: in double
  -- elimination players may swap places, a BYE may not move. Checked after
  -- the slot and player rules, so their errors keep priority.
  if v_format = 'double_elimination' then
    for v_item in select * from jsonb_array_elements(p_layout)
    loop
      select * into v_match from matches where id = (v_item->>'match_id')::uuid;
      if num_nonnulls(nullif(v_item->>'side_a_entry_id', '')::uuid, nullif(v_item->>'side_b_entry_id', '')::uuid)
         <> num_nonnulls(v_match.side_a_entry_id, v_match.side_b_entry_id) then
        raise exception 'drafts.byeFixedDoubleElim';
      end if;
    end loop;
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
