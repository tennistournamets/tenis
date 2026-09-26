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
