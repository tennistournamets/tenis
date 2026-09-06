-- Step 3: first-round BYE distribution and the two-player DE grand final.
-- Replaces generators only. Existing brackets/results remain unchanged.
-- CREATE OR REPLACE retains owners and the restricted helper EXECUTE grants.
begin;

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

commit;
