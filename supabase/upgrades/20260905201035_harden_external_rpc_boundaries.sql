-- Step 1b: validate tournament boundaries and restrict direct graph writes.
-- Apply only this current-model patch, never the historical migration directory.
-- CREATE OR REPLACE preserves owners and existing function execution grants.
begin;

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

create or replace function clear_downstream(p_match_id uuid, p_stale_winner uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_next_match_id uuid;
  v_next_slot text;
  v_next_winner uuid;
begin
  if p_stale_winner is null then
    return;
  end if;

  select tournament_id, next_match_id, next_slot
    into v_tournament_id, v_next_match_id, v_next_slot
  from matches
  where id = p_match_id
  for update;

  if v_next_match_id is null then
    return;
  end if;

  if not exists (
    select 1 from matches where id = v_next_match_id and tournament_id = v_tournament_id
  ) then
    raise exception 'Next match does not belong to this tournament';
  end if;

  if v_next_slot = 'A' then
    update matches
    set side_a_entry_id = null
    where id = v_next_match_id
      and side_a_entry_id = p_stale_winner;
  else
    update matches
    set side_b_entry_id = null
    where id = v_next_match_id
      and side_b_entry_id = p_stale_winner;
  end if;

  select winner_entry_id
    into v_next_winner
  from matches
  where id = v_next_match_id;

  if v_next_winner is not null then
    delete from match_sets where match_id = v_next_match_id;
    perform clear_downstream(v_next_match_id, v_next_winner);
  end if;

  update matches
  set winner_entry_id = null,
      status = case
        when side_a_entry_id is not null and side_b_entry_id is not null then 'ready'::match_status
        else 'pending'::match_status
      end
  where id = v_next_match_id
    and status = 'finished'::match_status;
end;
$$;

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
  for v_match in 1..v_matches_in_round loop
    v_side_a := null;
    v_side_b := null;

    if (2 * v_match - 1) <= v_count then
      v_side_a := v_ordered_ids[2 * v_match - 1];
    end if;

    if (2 * v_match) <= v_count then
      v_side_b := v_ordered_ids[2 * v_match];
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

create or replace function get_standings(
  p_tournament_id uuid,
  p_group_id uuid default null
)
returns table (
  entry_id uuid,
  display_name text,
  played integer,
  won integer,
  drawn integer,
  lost integer,
  score_for integer,
  score_against integer,
  diff integer,
  points integer,
  rank integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sport sport;
  v_cfg jsonb;
  v_win integer;
  v_draw integer;
  v_loss integer;
begin
  select t.sport, coalesce(t.scoring_config, '{}'::jsonb)
    into v_sport, v_cfg
  from tournaments t
  where t.id = p_tournament_id;

  if v_sport is null then
    raise exception 'Tournament not found';
  end if;

  if not (
    exists (select 1 from tournaments t where t.id = p_tournament_id and t.is_public)
    or is_tournament_admin(p_tournament_id)
    or can_live_score(p_tournament_id)
  ) then
    raise exception 'Not allowed';
  end if;

  if p_group_id is not null and not exists (
    select 1 from groups where id = p_group_id and tournament_id = p_tournament_id
  ) then
    raise exception 'Group does not belong to this tournament';
  end if;

  -- points defaults: goals sports use 3/1/0, sets sports 1/0/0; scoring_config may override
  if v_sport in ('tennis', 'padel') then
    v_win := coalesce((v_cfg->>'points_win')::integer, 1);
    v_draw := coalesce((v_cfg->>'points_draw')::integer, 0);
    v_loss := coalesce((v_cfg->>'points_loss')::integer, 0);
  else
    v_win := coalesce((v_cfg->>'points_win')::integer, 3);
    v_draw := coalesce((v_cfg->>'points_draw')::integer, 1);
    v_loss := coalesce((v_cfg->>'points_loss')::integer, 0);
  end if;

  return query
  with participants as (
    select e.id, e.display_name
    from entries e
    where e.tournament_id = p_tournament_id
      and e.status = 'approved'
      and (
        p_group_id is null
        or e.id in (select ge.entry_id from group_entries ge where ge.group_id = p_group_id)
      )
  ),
  played_matches as (
    select m.*
    from matches m
    where m.tournament_id = p_tournament_id
      and m.status = 'finished'
      and (p_group_id is null or m.group_id = p_group_id)
      and m.side_a_entry_id is not null
      and m.side_b_entry_id is not null
  ),
  sides as (
    select side_a_entry_id as eid,
           coalesce(side_a_score, 0) as gf,
           coalesce(side_b_score, 0) as ga,
           winner_entry_id
    from played_matches
    union all
    select side_b_entry_id as eid,
           coalesce(side_b_score, 0) as gf,
           coalesce(side_a_score, 0) as ga,
           winner_entry_id
    from played_matches
  ),
  agg as (
    select s.eid,
           count(*)::integer as played,
           count(*) filter (where s.winner_entry_id = s.eid)::integer as won,
           count(*) filter (where s.winner_entry_id is null)::integer as drawn,
           count(*) filter (where s.winner_entry_id is not null and s.winner_entry_id <> s.eid)::integer as lost,
           coalesce(sum(s.gf), 0)::integer as score_for,
           coalesce(sum(s.ga), 0)::integer as score_against
    from sides s
    group by s.eid
  ),
  merged as (
    select p.id as entry_id,
           p.display_name,
           coalesce(a.played, 0) as played,
           coalesce(a.won, 0) as won,
           coalesce(a.drawn, 0) as drawn,
           coalesce(a.lost, 0) as lost,
           coalesce(a.score_for, 0) as score_for,
           coalesce(a.score_against, 0) as score_against,
           (coalesce(a.score_for, 0) - coalesce(a.score_against, 0)) as diff,
           (coalesce(a.won, 0) * v_win + coalesce(a.drawn, 0) * v_draw + coalesce(a.lost, 0) * v_loss) as points
    from participants p
    left join agg a on a.eid = p.id
  ),
  -- Head-to-head points, counting only matches between entries tied on total points.
  -- Breaks pairwise/group ties correctly; circular ties fall through to diff.
  h2h as (
    select e.entry_id, coalesce(sum(e.pts), 0) as h2h_points
    from (
      select pm.side_a_entry_id as entry_id,
             case when pm.winner_entry_id = pm.side_a_entry_id then v_win
                  when pm.winner_entry_id is null then v_draw
                  else v_loss end as pts
      from played_matches pm
      join merged ma on ma.entry_id = pm.side_a_entry_id
      join merged mb on mb.entry_id = pm.side_b_entry_id
      where ma.points = mb.points
      union all
      select pm.side_b_entry_id as entry_id,
             case when pm.winner_entry_id = pm.side_b_entry_id then v_win
                  when pm.winner_entry_id is null then v_draw
                  else v_loss end as pts
      from played_matches pm
      join merged ma on ma.entry_id = pm.side_a_entry_id
      join merged mb on mb.entry_id = pm.side_b_entry_id
      where ma.points = mb.points
    ) e
    group by e.entry_id
  )
  select mg.entry_id,
         mg.display_name,
         mg.played,
         mg.won,
         mg.drawn,
         mg.lost,
         mg.score_for,
         mg.score_against,
         mg.diff,
         mg.points,
         (row_number() over (
            order by mg.points desc, coalesce(h.h2h_points, 0) desc,
                     mg.diff desc, mg.score_for desc, mg.display_name asc
         ))::integer as rank
  from merged mg
  left join h2h h on h.entry_id = mg.entry_id
  order by rank;
end;
$$;

create or replace function form_manual_pairs(
  p_tournament_id uuid,
  p_pairs jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pair jsonb;
  v_entry_a uuid;
  v_entry_b uuid;
  v_name_a text;
  v_name_b text;
  v_pairs_formed integer := 0;
  v_seen uuid[] := '{}';
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if not exists (
    select 1 from tournaments
    where id = p_tournament_id
      and category = 'doubles'
      and doubles_pairing_mode = 'pick_random'
  ) then
    raise exception 'Tournament is not configured for random pairing';
  end if;

  if jsonb_typeof(p_pairs) is distinct from 'array' then
    raise exception 'Pairs must be an array';
  end if;

  -- Validate the entire batch before merging/deleting any entry.
  for v_pair in select * from jsonb_array_elements(p_pairs)
  loop
    if jsonb_typeof(v_pair) is distinct from 'array' then
      raise exception 'Each pair must contain two entry IDs';
    end if;
    if jsonb_array_length(v_pair) <> 2 then
      raise exception 'Each pair must contain two entry IDs';
    end if;
    v_entry_a := (v_pair->>0)::uuid;
    v_entry_b := (v_pair->>1)::uuid;
    if v_entry_a is null or v_entry_b is null or v_entry_a = v_entry_b
       or v_entry_a = any(v_seen) or v_entry_b = any(v_seen) then
      raise exception 'Pairs must contain distinct non-null entries without reuse';
    end if;
    if (select count(*) from entries e
        where e.id in (v_entry_a, v_entry_b) and e.tournament_id = p_tournament_id
          and e.status = 'approved' and e.entry_type = 'doubles'
          and exists (select 1 from entry_members em where em.entry_id = e.id and em.member_order = 1)
          and not exists (select 1 from entry_members em where em.entry_id = e.id and em.member_order = 2)
       ) <> 2 then
      raise exception 'Pairs require approved unpaired entries from this tournament';
    end if;
    v_seen := v_seen || array[v_entry_a, v_entry_b];
  end loop;

  for v_pair in select * from jsonb_array_elements(p_pairs)
  loop
    v_entry_a := (v_pair->>0)::uuid;
    v_entry_b := (v_pair->>1)::uuid;

    if not exists (
      select 1 from entries
      where id = v_entry_a
        and tournament_id = p_tournament_id
        and status = 'approved'
        and not exists (
          select 1 from entry_members em where em.entry_id = v_entry_a and em.member_order = 2
        )
    ) then
      raise exception 'Entry % is not a valid unpaired entry', v_entry_a;
    end if;

    if not exists (
      select 1 from entries
      where id = v_entry_b
        and tournament_id = p_tournament_id
        and status = 'approved'
        and not exists (
          select 1 from entry_members em where em.entry_id = v_entry_b and em.member_order = 2
        )
    ) then
      raise exception 'Entry % is not a valid unpaired entry', v_entry_b;
    end if;

    select em.member_name into v_name_a
    from entry_members em
    where em.entry_id = v_entry_a and em.member_order = 1;

    select em.member_name into v_name_b
    from entry_members em
    where em.entry_id = v_entry_b and em.member_order = 1;

    insert into entry_members (entry_id, member_name, member_order)
    values (v_entry_a, v_name_b, 2);

    update entries
    set display_name = v_name_a || ' / ' || v_name_b
    where id = v_entry_a;

    delete from entry_members where entry_id = v_entry_b;
    delete from entries where id = v_entry_b;

    v_pairs_formed := v_pairs_formed + 1;
  end loop;

  return v_pairs_formed;
end;
$$;

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

  select * into m_from from matches where id = p_from_match_id for update;
  select * into m_to from matches where id = p_to_match_id for update;

  if m_from.id is null or m_to.id is null then
    raise exception 'Match not found';
  end if;

  if m_from.tournament_id <> p_tournament_id or m_to.tournament_id <> p_tournament_id then
    raise exception 'Match does not belong to this tournament';
  end if;

  if m_from.status = 'finished'::match_status or m_to.status = 'finished'::match_status then
    raise exception 'Cannot move players in finished matches';
  end if;

  if exists (
    select 1
    from match_sets ms
    where ms.match_id in (p_from_match_id, p_to_match_id)
  ) then
    raise exception 'Cannot move players when match scores exist';
  end if;

  if p_from_match_id = p_to_match_id then
    if v_fs = v_ts then
      return;
    end if;
    update matches
    set
      side_a_entry_id = m_from.side_b_entry_id,
      side_b_entry_id = m_from.side_a_entry_id,
      winner_entry_id = null,
      status = case
        when m_from.side_b_entry_id is not null and m_from.side_a_entry_id is not null then 'ready'::match_status
        else 'pending'::match_status
      end
    where id = p_from_match_id;
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

  update matches
  set
    side_a_entry_id = nf_a,
    side_b_entry_id = nf_b,
    winner_entry_id = null,
    status = case
      when nf_a is not null and nf_b is not null then 'ready'::match_status
      else 'pending'::match_status
    end
  where id = p_from_match_id;

  update matches
  set
    side_a_entry_id = nt_a,
    side_b_entry_id = nt_b,
    winner_entry_id = null,
    status = case
      when nt_a is not null and nt_b is not null then 'ready'::match_status
      else 'pending'::match_status
    end
  where id = p_to_match_id;
end;
$$;

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
  v_seen_matches uuid[] := '{}';
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if jsonb_typeof(p_layout) is distinct from 'array' then
    raise exception 'Layout must be an array';
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
    if v_match.status = 'finished'::match_status then
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
      winner_entry_id = null,
      status = case
        when v_side_a is not null and v_side_b is not null then 'ready'::match_status
        else 'pending'::match_status
      end
    where id = v_match_id;
  end loop;
end;
$$;

drop policy if exists matches_update_admin on matches;
create policy matches_update_admin on matches
for update
to authenticated
using (is_tournament_admin(tournament_id))
with check (
  is_tournament_admin(tournament_id)
  and winner_entry_id is null
  and status = 'ready'::match_status
);

-- Client writes must not bypass the authorized graph/scoring RPCs.
-- Keep only the direct writes currently used by the administration screen:
-- entries.status approval, match result reset, and bracket/sets deletion.
revoke insert, update on public.matches, public.match_sets from public, anon, authenticated;
revoke insert, update, delete on public.groups, public.group_entries, public.live_scores from public, anon, authenticated;
revoke update on public.entries from public, anon, authenticated;

-- Table REVOKE does not remove older column grants. Clear those too, including
-- any extra deployed columns, before granting the narrow supported interface.
do $$
declare
  v_table text;
  v_columns text;
begin
  foreach v_table in array array['matches', 'match_sets', 'groups', 'group_entries', 'live_scores', 'entries']
  loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_columns
    from pg_attribute a
    where a.attrelid = format('public.%I', v_table)::regclass
      and a.attnum > 0 and not a.attisdropped;
    execute format('revoke update (%s) on public.%I from public, anon, authenticated', v_columns, v_table);
    if v_table <> 'entries' then
      execute format('revoke insert (%s) on public.%I from public, anon, authenticated', v_columns, v_table);
    end if;
  end loop;
end;
$$;

grant update (status) on public.entries to authenticated;
grant update (winner_entry_id, status) on public.matches to authenticated;

commit;
