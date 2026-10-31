-- =============================================
-- TENNIS SEEDED DRAW
-- =============================================
-- A third knockout draw mode, 'seeded', the way tennis federations draw
-- (ITF / LTS): the strongest entries by seed order are seeds, placed on fixed
-- lines, BYEs go to the seeds first, and everyone else is drawn by lot.
--   * Seeds by draw size: 2 up to 8 lines, 4 up to 16, 8 up to 32, 16 above.
--   * Seed 1 on the top line, seed 2 on the bottom line; seeds 3-4 drawn into
--     the two remaining quarters, 5-8 into the free eighths, 9-16 into the
--     free sixteenths (the ITF draw sheet layout).
--   * BYEs: opposite seeds 1, 2, 3... in seed order; any further BYEs sit
--     opposite the next lines of the standard order, so they are spread
--     evenly. The entry on such a line is drawn by lot.
--   * Unseeded entries fill the remaining lines in a random order.
-- 'manual' (strict seeding: 1 v last, no lot) and 'auto-random' keep their
-- behaviour. Double elimination (4/8/16/32 entries, no BYEs) uses the same
-- seed lines. RPC signatures do not change. Safe to re-run.

alter type public.draw_mode add value if not exists 'seeded';

-- Number of seeds for a draw of p_size lines (mirrored by src/lib/drawSeeding.js).
create or replace function public.tennis_seed_count(p_size integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select case when p_size <= 8 then 2 when p_size <= 16 then 4 when p_size <= 32 then 8 else 16 end;
$$;
revoke execute on function public.tennis_seed_count(integer) from public, anon, authenticated;

-- First-round slots (bracket order, NULL = BYE) for entries in seed order.
-- Lines are numbered as in knockout_seeded_slots: slot i holds line
-- v_lines[i], and neighbouring slots (a first-round match) hold lines that
-- add up to size + 1.
create or replace function public.knockout_tennis_slots(p_seeds uuid[])
returns uuid[]
language plpgsql
volatile
set search_path = public
as $$
declare
  v_count integer := coalesce(array_length(p_seeds, 1), 0);
  v_size integer := 1;
  v_lines integer[] := array[1];
  v_next integer[];
  v_line integer;
  v_seed_count integer;
  v_byes integer;
  v_by_line uuid[];
  v_bye boolean[];
  v_seed_line integer[];
  v_group_start integer;
  v_group_lines integer[];
  v_k integer;
  v_free integer[];
  v_unseeded uuid[];
  v_slots uuid[] := '{}';
begin
  if v_count < 2 then
    return p_seeds;
  end if;
  while v_size < v_count loop
    v_next := '{}';
    foreach v_line in array v_lines loop
      v_next := v_next || v_line || (2 * v_size + 1 - v_line);
    end loop;
    v_lines := v_next;
    v_size := v_size * 2;
  end loop;

  v_seed_count := least(tennis_seed_count(v_size), v_count);
  v_byes := v_size - v_count;
  v_by_line := array_fill(null::uuid, array[v_size]);
  v_bye := array_fill(false, array[v_size]);
  v_seed_line := array_fill(0, array[v_seed_count]);

  -- Seeds 1 and 2 on lines 1 and 2; each later group (3-4, 5-8, 9-16) is
  -- drawn into its own block of lines.
  v_seed_line[1] := 1;
  if v_seed_count >= 2 then
    v_seed_line[2] := 2;
  end if;
  v_group_start := 3;
  while v_group_start <= v_seed_count loop
    select array_agg(g order by random()) into v_group_lines
    from generate_series(v_group_start, 2 * v_group_start - 2) g;
    for v_k in v_group_start .. least(2 * v_group_start - 2, v_seed_count) loop
      v_seed_line[v_k] := v_group_lines[v_k - v_group_start + 1];
    end loop;
    v_group_start := 2 * v_group_start - 1;
  end loop;
  for v_k in 1 .. v_seed_count loop
    v_by_line[v_seed_line[v_k]] := p_seeds[v_k];
  end loop;

  -- BYEs opposite the seeds in seed order, then opposite the next lines.
  for v_k in 1 .. least(v_byes, v_seed_count) loop
    v_bye[v_size + 1 - v_seed_line[v_k]] := true;
  end loop;
  for v_line in v_seed_count + 1 .. v_byes loop
    v_bye[v_size + 1 - v_line] := true;
  end loop;

  -- Unseeded entries drawn by lot onto the remaining lines.
  select coalesce(array_agg(x order by random()), '{}') into v_unseeded
  from unnest(p_seeds[v_seed_count + 1 : v_count]) x;
  select coalesce(array_agg(l order by l), '{}') into v_free
  from generate_series(1, v_size) l
  where v_by_line[l] is null and not v_bye[l];
  for v_k in 1 .. coalesce(array_length(v_free, 1), 0) loop
    v_by_line[v_free[v_k]] := v_unseeded[v_k];
  end loop;

  -- The standard order puts line 2 at the top of the bottom half; tennis
  -- draw sheets show the bottom half mirrored (seed 2 on the last line,
  -- seeds 3-4 on lines 5 and 12 of 16). Mirroring keeps every match and
  -- the whole tree.
  for v_k in 1 .. v_size loop
    v_line := case when v_k <= v_size / 2 then v_lines[v_k] else v_lines[v_size + v_size / 2 + 1 - v_k] end;
    v_slots := array_append(v_slots, v_by_line[v_line]);
  end loop;
  return v_slots;
end;
$$;
revoke execute on function public.knockout_tennis_slots(uuid[]) from public, anon, authenticated;

-- generate_bracket: the seeded mode orders the field like a manual draw and
-- places it with knockout_tennis_slots.
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

  -- Double elimination is built by a dedicated generator that pairs
  -- neighbouring seeds; a manual or seeded draw hands it the seed lines.
  -- Other counts go through unchanged so the generator reports them.
  if v_tournament.format = 'double_elimination' then
    if p_mode = 'manual' and (v_count & (v_count - 1)) = 0 then
      v_ordered_ids := knockout_seeded_slots(v_ordered_ids);
    elsif p_mode = 'seeded' and (v_count & (v_count - 1)) = 0 then
      v_ordered_ids := knockout_tennis_slots(v_ordered_ids);
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
