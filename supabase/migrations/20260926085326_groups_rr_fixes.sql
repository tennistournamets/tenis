-- Round robin and groups + playoff fixes (QA stream B). Safe to re-run: every
-- function is replaced (generate_groups is dropped first because its
-- signature changes) and grants are restated.
--
-- * Standings: one internal computation (standings_rows) shared by the public
--   RPC and the playoff seeding. Ties on points break by head-to-head, set or
--   goal difference, then game difference (sets sports) before the name, so a
--   circular tie no longer falls through to the alphabet. Password viewers
--   with a valid token read standings inside their snapshot.
-- * Generators refuse to wipe recorded results of a running or completed
--   tournament (round robin, groups, playoff).
-- * Playoff seeding follows the organizer decision: group winners by strength,
--   then the best runners-up, BYEs go to the top seeds, and players from the
--   same group never meet in the first round. The playoff tree is built here
--   from a positional slot list, independent of generate_single_elim.
-- * A group correction rebuilds the playoff only when the qualifiers or their
--   placement change; the rebuilt playoff keeps its schedule slots, and the
--   preview reports scheduled and published matches it touches.

-- =============================================
-- Standings
-- =============================================

create or replace function public.standings_rows(p_tournament_id uuid, p_group_id uuid default null)
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
  rank integer,
  games_for integer,
  games_against integer,
  games_diff integer
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
  -- Games per match for the sets family. A deciding match tie-break counts as
  -- one game for its winner, the usual convention for game totals.
  match_games as (
    select ms.match_id,
           sum(case when ms.score_kind = 'match_tiebreak'
                    then case when coalesce(ms.side_a_tiebreak, 0) > coalesce(ms.side_b_tiebreak, 0) then 1 else 0 end
                    else ms.side_a_games end)::integer as a_games,
           sum(case when ms.score_kind = 'match_tiebreak'
                    then case when coalesce(ms.side_b_tiebreak, 0) > coalesce(ms.side_a_tiebreak, 0) then 1 else 0 end
                    else ms.side_b_games end)::integer as b_games
    from match_sets ms
    where ms.match_id in (select pm.id from played_matches pm)
    group by ms.match_id
  ),
  sides as (
    select pm.side_a_entry_id as eid,
           coalesce(pm.side_a_score, 0) as gf,
           coalesce(pm.side_b_score, 0) as ga,
           coalesce(g.a_games, 0) as games_f,
           coalesce(g.b_games, 0) as games_a,
           pm.winner_entry_id
    from played_matches pm left join match_games g on g.match_id = pm.id
    union all
    select pm.side_b_entry_id as eid,
           coalesce(pm.side_b_score, 0) as gf,
           coalesce(pm.side_a_score, 0) as ga,
           coalesce(g.b_games, 0) as games_f,
           coalesce(g.a_games, 0) as games_a,
           pm.winner_entry_id
    from played_matches pm left join match_games g on g.match_id = pm.id
  ),
  agg as (
    select s.eid,
           count(*)::integer as played,
           count(*) filter (where s.winner_entry_id = s.eid)::integer as won,
           count(*) filter (where s.winner_entry_id is null)::integer as drawn,
           count(*) filter (where s.winner_entry_id is not null and s.winner_entry_id <> s.eid)::integer as lost,
           coalesce(sum(s.gf), 0)::integer as score_for,
           coalesce(sum(s.ga), 0)::integer as score_against,
           coalesce(sum(s.games_f), 0)::integer as games_for,
           coalesce(sum(s.games_a), 0)::integer as games_against
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
           (coalesce(a.won, 0) * v_win + coalesce(a.drawn, 0) * v_draw + coalesce(a.lost, 0) * v_loss) as points,
           coalesce(a.games_for, 0) as games_for,
           coalesce(a.games_against, 0) as games_against,
           (coalesce(a.games_for, 0) - coalesce(a.games_against, 0)) as games_diff
    from participants p
    left join agg a on a.eid = p.id
  ),
  -- Head-to-head points, counting only matches between entries tied on total points.
  -- Breaks pairwise/group ties; a circular tie falls through to the differences.
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
                     mg.diff desc, mg.games_diff desc, mg.score_for desc, mg.games_for desc,
                     mg.display_name asc, mg.entry_id asc
         ))::integer as rank,
         mg.games_for,
         mg.games_against,
         mg.games_diff
  from merged mg
  left join h2h h on h.entry_id = mg.entry_id
  order by rank;
end;
$$;
revoke execute on function public.standings_rows(uuid, uuid) from public, anon, authenticated;

-- The public contract keeps its columns (historical patches replace it with
-- the same row type); the game totals only order the ranking.
create or replace function public.get_standings(
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
begin
  if not exists (select 1 from tournaments t where t.id = p_tournament_id) then
    raise exception 'Tournament not found';
  end if;
  -- tenis.access_tournament is set, transaction-local, only by
  -- get_tournament_sync_state_with_token after it has validated the token.
  if not (
    exists (select 1 from tournaments t where t.id = p_tournament_id and t.is_public)
    or is_tournament_admin(p_tournament_id)
    or can_live_score(p_tournament_id)
    or coalesce(current_setting('tenis.access_tournament', true), '') = p_tournament_id::text
  ) then
    raise exception 'Not allowed';
  end if;
  if p_group_id is not null and not exists (
    select 1 from groups where id = p_group_id and tournament_id = p_tournament_id
  ) then
    raise exception 'Group does not belong to this tournament';
  end if;
  return query
  select s.entry_id, s.display_name, s.played, s.won, s.drawn, s.lost,
         s.score_for, s.score_against, s.diff, s.points, s.rank
  from standings_rows(p_tournament_id, p_group_id) s;
end;
$$;
revoke execute on function public.get_standings(uuid, uuid) from public;
grant execute on function public.get_standings(uuid, uuid) to anon, authenticated;

-- Password viewers get the same snapshot reduced to its public projection. The
-- snapshot computes standings through get_standings, which admits this viewer
-- through the transaction-local grant set here and cleared right after.
create or replace function public.get_tournament_sync_state_with_token(p_tournament_id uuid, p_token text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v jsonb;
begin
 if not valid_access_token(p_tournament_id,p_token) then raise exception 'access.tokenExpired'; end if;
 perform set_config('tenis.access_tournament',p_tournament_id::text,true);
 v:=get_tournament_sync_state(p_tournament_id);
 perform set_config('tenis.access_tournament','',true);
 if v is null then return null; end if;
 v:=jsonb_set(v,'{entries}',coalesce((select jsonb_agg(e) from jsonb_array_elements(v->'entries') e where e->>'status'='approved'),'[]'::jsonb));
 v:=jsonb_set(v,'{schedule}',coalesce((select jsonb_agg(s) from jsonb_array_elements(v->'schedule') s where s->>'state'='published'),'[]'::jsonb));
 v:=jsonb_set(v,'{registration}',coalesce(tournament_registration_state(p_tournament_id,true),'null'::jsonb));
 v:=jsonb_set(v,'{tournament,access_password_set}','null'::jsonb);
 v:=jsonb_set(v,'{tournament,contact_phone}','null'::jsonb);
 v:=jsonb_set(v,'{tournament,contact_email}','null'::jsonb);
 v:=jsonb_set(v,'{tournament,publish_contact}','false'::jsonb);
 return v;
end;
$$;
revoke execute on function public.get_tournament_sync_state_with_token(uuid,text) from public;
grant execute on function public.get_tournament_sync_state_with_token(uuid,text) to anon, authenticated;

-- =============================================
-- Generator guards
-- =============================================

-- Anything a regeneration would erase: a played (non-BYE) result, a saved
-- score or set, or a live-scoring row. p_stages narrows the check.
create or replace function public.tournament_has_results(p_tournament_id uuid, p_stages match_stage[] default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from matches m
    where m.tournament_id = p_tournament_id
      and (p_stages is null or m.stage = any(p_stages))
      and (
        m.side_a_score is not null or m.side_b_score is not null
        or (m.status = 'finished' and m.side_a_entry_id is not null and m.side_b_entry_id is not null)
        or exists (select 1 from match_sets s where s.match_id = m.id)
        or exists (select 1 from live_scores l where l.match_id = m.id)
      )
  );
$$;
revoke execute on function public.tournament_has_results(uuid, match_stage[]) from public, anon, authenticated;

-- A completed tournament is final; a running one keeps its recorded results.
create or replace function public.assert_structure_regenerable(p_tournament_id uuid, p_stages match_stage[] default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_status tournament_status;
begin
  select status into v_status from tournaments where id = p_tournament_id for update;
  if v_status is null then
    raise exception 'Tournament not found';
  end if;
  if v_status = 'completed'
     or (v_status = 'in_progress' and tournament_has_results(p_tournament_id, p_stages)) then
    raise exception using errcode = '22023', message = 'groupsFlow.regenerateLocked';
  end if;
end;
$$;
revoke execute on function public.assert_structure_regenerable(uuid, match_stage[]) from public, anon, authenticated;

create or replace function public.generate_round_robin(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entries uuid[];
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  perform assert_structure_regenerable(p_tournament_id);

  select array_agg(e.id order by coalesce(e.seed_order, 999999), e.created_at)
    into v_entries
  from entries e
  where e.tournament_id = p_tournament_id
    and e.status = 'approved';

  if coalesce(array_length(v_entries, 1), 0) < 2 then
    raise exception 'At least 2 approved entries required';
  end if;

  delete from match_sets
  where match_id in (select id from matches where tournament_id = p_tournament_id);
  delete from matches where tournament_id = p_tournament_id;

  perform generate_round_robin_matches(p_tournament_id, v_entries, 'main', null, 0);
end;
$$;
grant execute on function public.generate_round_robin(uuid) to authenticated;

-- Snake-distribute approved entries into N groups, then round-robin within each
-- group. p_advance_per_group (optional) stores how many leave each group; it
-- must fit the smallest group.
drop function if exists public.generate_groups(uuid, integer);
create or replace function public.generate_groups(
  p_tournament_id uuid,
  p_group_count integer default 2,
  p_advance_per_group integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entries uuid[];
  v_n integer;
  v_g integer;
  v_i integer;
  v_group_ids uuid[] := '{}';
  v_gid uuid;
  v_target integer;
  v_pos integer;
  v_group_members uuid[];
  v_advance integer;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if p_group_count is null or p_group_count < 2 then
    raise exception 'At least 2 groups required';
  end if;
  perform assert_structure_regenerable(p_tournament_id);

  select array_agg(e.id order by coalesce(e.seed_order, 999999), e.created_at)
    into v_entries
  from entries e
  where e.tournament_id = p_tournament_id and e.status = 'approved';

  v_n := coalesce(array_length(v_entries, 1), 0);
  if v_n < p_group_count * 2 then
    raise exception 'Need at least 2 entries per group';
  end if;

  select coalesce(p_advance_per_group, (format_config->>'advance_per_group')::integer, 2)
    into v_advance from tournaments where id = p_tournament_id;
  -- The smallest group has floor(n / groups) entries.
  if v_advance < 1 or v_advance > v_n / p_group_count then
    raise exception using errcode = '22023', message = 'groupsFlow.invalidAdvance';
  end if;
  if p_advance_per_group is not null then
    update tournaments
      set format_config = jsonb_set(coalesce(format_config, '{}'::jsonb), '{advance_per_group}', to_jsonb(p_advance_per_group))
    where id = p_tournament_id
      and (format_config->>'advance_per_group') is distinct from p_advance_per_group::text;
  end if;

  -- wipe existing structure
  delete from match_sets where match_id in (select id from matches where tournament_id = p_tournament_id);
  delete from matches where tournament_id = p_tournament_id;
  delete from groups where tournament_id = p_tournament_id;  -- cascades group_entries

  -- create groups A, B, C, ...
  for v_g in 0..(p_group_count - 1) loop
    insert into groups (tournament_id, name, group_index)
    values (p_tournament_id, chr(65 + v_g), v_g)
    returning id into v_gid;
    v_group_ids := v_group_ids || v_gid;
  end loop;

  -- snake distribution
  for v_i in 1..v_n loop
    v_pos := ((v_i - 1) / p_group_count);           -- row index (0-based)
    if v_pos % 2 = 0 then
      v_target := ((v_i - 1) % p_group_count);      -- left to right
    else
      v_target := p_group_count - 1 - ((v_i - 1) % p_group_count); -- right to left
    end if;
    insert into group_entries (group_id, entry_id, seed)
    values (v_group_ids[v_target + 1], v_entries[v_i], v_i);
  end loop;

  -- round-robin per group; round_offset keeps round numbers unique across groups
  for v_g in 0..(p_group_count - 1) loop
    select array_agg(ge.entry_id order by ge.seed)
      into v_group_members
    from group_entries ge
    where ge.group_id = v_group_ids[v_g + 1];

    perform generate_round_robin_matches(
      p_tournament_id, v_group_members, 'group', v_group_ids[v_g + 1], v_g * 1000
    );
  end loop;
end;
$$;
revoke execute on function public.generate_groups(uuid, integer, integer) from public;
grant execute on function public.generate_groups(uuid, integer, integer) to authenticated;

-- =============================================
-- Groups -> playoff seeding
-- =============================================

-- Positional first-round slots of the playoff: slot 2k-1 and 2k meet in match
-- k, a NULL entry is a BYE. Qualifiers are seeded by group place, then by
-- strength across groups (per-match points, difference, game difference,
-- score), then group order. Standard seeding puts 1 and 2 in different halves
-- and gives the BYEs to the top seeds; a first-round meeting of two players
-- from the same group is resolved by swapping the weaker one with the closest
-- seed of the same place (else the closest seed) from another full match.
create or replace function public.group_playoff_seeding(p_tournament_id uuid)
returns table (
  slot integer,
  entry_id uuid,
  seed integer,
  group_id uuid,
  group_name text,
  group_rank integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_advance integer;
  v_min integer;
  v_n integer;
  v_b integer := 1;
  v_ids uuid[];
  v_gids uuid[];
  v_gnames text[];
  v_gidx integer[];
  v_ranks integer[];
  v_order integer[] := array[1];
  v_next integer[];
  v_len integer := 1;
  v_s integer;
  v_slots integer[] := '{}';
  v_k integer;
  v_q integer;
  v_qpos integer;
  v_a integer;
  v_bb integer;
  v_weak integer;
  v_wpos integer;
  v_partner_w integer;
  v_partner_q integer;
  v_best integer;
  v_best_dist integer;
  v_dist integer;
  v_changed boolean;
  v_pass integer;
begin
  select coalesce((format_config->>'advance_per_group')::integer, 2)
    into v_advance from tournaments where id = p_tournament_id;
  if v_advance is null then
    raise exception 'Tournament not found';
  end if;
  if not exists (select 1 from groups g where g.tournament_id = p_tournament_id) then
    raise exception 'No groups found';
  end if;
  select min(c) into v_min from (
    select count(*) c from groups g
    join group_entries ge on ge.group_id = g.id
    join entries e on e.id = ge.entry_id and e.status = 'approved'
    where g.tournament_id = p_tournament_id group by g.id
    union all
    select 0 from groups g where g.tournament_id = p_tournament_id
      and not exists (select 1 from group_entries ge join entries e on e.id = ge.entry_id and e.status = 'approved' where ge.group_id = g.id)
  ) x;
  if v_advance < 1 or v_advance > v_min then
    raise exception using errcode = '22023', message = 'groupsFlow.invalidAdvance';
  end if;

  with q as (
    select s.entry_id, g.id as gid, g.name as gname, g.group_index, s.rank as grank,
           case when s.played > 0 then s.points::numeric / s.played else 0 end as ppm,
           case when s.played > 0 then s.diff::numeric / s.played else 0 end as dpm,
           case when s.played > 0 then s.games_diff::numeric / s.played else 0 end as gpm,
           case when s.played > 0 then s.score_for::numeric / s.played else 0 end as fpm
    from groups g
    cross join lateral standings_rows(p_tournament_id, g.id) s
    where g.tournament_id = p_tournament_id and s.rank <= v_advance
  ), ranked as (
    select q.*, row_number() over (order by q.grank, q.ppm desc, q.dpm desc, q.gpm desc, q.fpm desc, q.group_index) as sn
    from q
  )
  select array_agg(r.entry_id order by r.sn), array_agg(r.gid order by r.sn), array_agg(r.gname order by r.sn),
         array_agg(r.group_index order by r.sn), array_agg(r.grank order by r.sn)
    into v_ids, v_gids, v_gnames, v_gidx, v_ranks
  from ranked r;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n < 2 then
    raise exception 'Not enough qualifiers for a playoff';
  end if;
  while v_b < v_n loop v_b := v_b * 2; end loop;

  -- Standard seed order: [1,2] -> [1,4,2,3] -> [1,8,4,5,2,7,3,6] ...
  while v_len < v_b loop
    v_next := '{}';
    foreach v_s in array v_order loop
      v_next := v_next || v_s || (2 * v_len + 1 - v_s);
    end loop;
    v_order := v_next;
    v_len := v_len * 2;
  end loop;
  for v_k in 1..v_b loop
    v_slots := v_slots || case when v_order[v_k] <= v_n then v_order[v_k] else 0 end;
  end loop;

  -- Every swap removes one same-group pair without creating another, so the
  -- loop ends; passes are bounded anyway.
  for v_pass in 1..v_b loop
    v_changed := false;
    for v_k in 1..(v_b / 2) loop
      v_a := v_slots[2 * v_k - 1];
      v_bb := v_slots[2 * v_k];
      continue when v_a = 0 or v_bb = 0 or v_gidx[v_a] <> v_gidx[v_bb];
      v_weak := greatest(v_a, v_bb);
      v_partner_w := least(v_a, v_bb);
      v_wpos := case when v_a > v_bb then 2 * v_k - 1 else 2 * v_k end;
      v_best := 0;
      v_best_dist := null;
      for v_qpos in 1..v_b loop
        continue when (v_qpos + 1) / 2 = v_k;
        v_q := v_slots[v_qpos];
        continue when v_q = 0;
        v_partner_q := v_slots[case when v_qpos % 2 = 1 then v_qpos + 1 else v_qpos - 1 end];
        -- A seed holding a BYE keeps it: free passes stay with the top seeds.
        continue when v_partner_q = 0;
        continue when v_gidx[v_q] = v_gidx[v_partner_w] or v_gidx[v_weak] = v_gidx[v_partner_q];
        v_dist := case when v_ranks[v_q] = v_ranks[v_weak] then 0 else 1000 end + abs(v_q - v_weak);
        if v_best_dist is null or v_dist < v_best_dist then
          v_best := v_qpos;
          v_best_dist := v_dist;
        end if;
      end loop;
      if v_best > 0 then
        v_slots[v_wpos] := v_slots[v_best];
        v_slots[v_best] := v_weak;
        v_changed := true;
      end if;
    end loop;
    exit when not v_changed;
  end loop;

  for v_k in 1..v_b loop
    slot := v_k;
    v_s := v_slots[v_k];
    if v_s = 0 then
      entry_id := null; seed := null; group_id := null; group_name := null; group_rank := null;
    else
      entry_id := v_ids[v_s]; seed := v_s; group_id := v_gids[v_s]; group_name := v_gnames[v_s]; group_rank := v_ranks[v_s];
    end if;
    return next;
  end loop;
end;
$$;
revoke execute on function public.group_playoff_seeding(uuid) from public, anon, authenticated;

create or replace function public.group_playoff_slots(p_tournament_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select array_agg(s.entry_id order by s.slot) from group_playoff_seeding(p_tournament_id) s;
$$;
revoke execute on function public.group_playoff_slots(uuid) from public, anon, authenticated;

-- Replaces the playoff (stage 'winners') with a fresh tree for the current
-- seeding. Group matches are untouched. Schedule rows follow their bracket
-- position (round, match number): courts and times belong to the slot.
create or replace function public.build_group_playoff(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slots uuid[];
  v_b integer;
  v_rounds integer := 0;
  v_round integer;
  v_k integer;
  v_cnt integer;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_offset integer;
  v_next_offset integer;
  v_a uuid;
  v_bb uuid;
  v_winner uuid;
  v_schedule jsonb;
begin
  v_slots := group_playoff_slots(p_tournament_id);
  v_b := array_length(v_slots, 1);
  v_cnt := v_b;
  while v_cnt > 1 loop v_rounds := v_rounds + 1; v_cnt := v_cnt / 2; end loop;

  select coalesce(jsonb_agg(jsonb_build_object('round_number', m.round_number, 'match_number', m.match_number,
           'state', s.state, 'court_id', s.court_id, 'scheduled_at', s.scheduled_at, 'time_kind', s.time_kind,
           'queue_order', s.queue_order)), '[]'::jsonb)
    into v_schedule
  from match_schedule s join matches m on m.id = s.match_id
  where m.tournament_id = p_tournament_id and m.stage = 'winners';

  delete from match_sets
  where match_id in (select id from matches where tournament_id = p_tournament_id and stage = 'winners');
  delete from matches where tournament_id = p_tournament_id and stage = 'winners';

  -- Match (r, k) sits at index offset(r) + k, offset(r) = b - b / 2^(r-1).
  for v_round in 1..v_rounds loop
    for v_k in 1..(v_b / (2 ^ v_round)::integer) loop
      insert into matches (tournament_id, stage, round_number, match_number, status)
      values (p_tournament_id, 'winners', v_round, v_k, 'pending'::match_status)
      returning id into v_id;
      v_ids := v_ids || v_id;
    end loop;
  end loop;
  for v_round in 1..(v_rounds - 1) loop
    v_offset := v_b - v_b / (2 ^ (v_round - 1))::integer;
    v_next_offset := v_b - v_b / (2 ^ v_round)::integer;
    for v_k in 1..(v_b / (2 ^ v_round)::integer) loop
      update matches
        set next_match_id = v_ids[v_next_offset + (v_k + 1) / 2],
            next_slot = case when v_k % 2 = 1 then 'A' else 'B' end
      where id = v_ids[v_offset + v_k];
    end loop;
  end loop;

  for v_k in 1..(v_b / 2) loop
    v_a := v_slots[2 * v_k - 1];
    v_bb := v_slots[2 * v_k];
    v_winner := case when v_a is null then v_bb when v_bb is null then v_a else null end;
    update matches
      set side_a_entry_id = v_a,
          side_b_entry_id = v_bb,
          winner_entry_id = v_winner,
          status = case
            when v_winner is not null then 'finished'::match_status
            when v_a is not null and v_bb is not null then 'ready'::match_status
            else 'pending'::match_status
          end
    where id = v_ids[v_k];
    if v_winner is not null then
      perform propagate_winner(v_ids[v_k], v_winner);
    end if;
  end loop;

  insert into match_schedule (tournament_id, match_id, state, court_id, scheduled_at, time_kind, queue_order)
  select p_tournament_id, m.id, x.state, x.court_id, x.scheduled_at, x.time_kind, x.queue_order
  from jsonb_to_recordset(v_schedule) as x(round_number integer, match_number integer, state text, court_id uuid,
         scheduled_at timestamptz, time_kind text, queue_order integer)
  join matches m on m.tournament_id = p_tournament_id and m.stage = 'winners'
    and m.round_number = x.round_number and m.match_number = x.match_number
  where not (m.status = 'finished' and (m.side_a_entry_id is null) <> (m.side_b_entry_id is null))
  on conflict (match_id, state) do nothing;
end;
$$;
revoke execute on function public.build_group_playoff(uuid) from public, anon, authenticated;

-- After all group matches finish, seed the knockout (stage 'winners'). A
-- playoff with recorded results is replaced only through a group correction.
create or replace function public.generate_group_playoff(p_tournament_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_status tournament_status;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  select status into v_status from tournaments where id = p_tournament_id for update;
  if v_status = 'completed' then
    raise exception using errcode = '22023', message = 'groupsFlow.regenerateLocked';
  end if;
  if not exists (select 1 from groups where tournament_id = p_tournament_id) then
    raise exception 'No groups found';
  end if;
  if exists (
    select 1 from matches
    where tournament_id = p_tournament_id and stage = 'group' and status <> 'finished'
  ) then
    raise exception 'All group matches must be finished first';
  end if;
  if tournament_has_results(p_tournament_id, array['winners']::match_stage[]) then
    raise exception using errcode = '22023', message = 'groupsFlow.playoffStarted';
  end if;
  perform build_group_playoff(p_tournament_id);
end;
$$;
grant execute on function public.generate_group_playoff(uuid) to authenticated;

-- What "Start playoff" will create, for the confirmation dialog.
create or replace function public.get_group_playoff_preview(p_tournament_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_slots jsonb;
begin
  if not is_tournament_admin(p_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if exists (
    select 1 from matches
    where tournament_id = p_tournament_id and stage = 'group' and status <> 'finished'
  ) then
    raise exception 'All group matches must be finished first';
  end if;
  select jsonb_agg(jsonb_build_object('slot', s.slot, 'entry_id', s.entry_id, 'name', e.display_name,
           'seed', s.seed, 'group_name', s.group_name, 'group_rank', s.group_rank) order by s.slot)
    into v_slots
  from group_playoff_seeding(p_tournament_id) s left join entries e on e.id = s.entry_id;
  return jsonb_build_object(
    'bracket_size', jsonb_array_length(v_slots),
    'qualifiers', (select count(*) from jsonb_array_elements(v_slots) x where x->>'entry_id' is not null),
    'pairs', (select jsonb_agg(jsonb_build_object('match_number', k,
                'a', case when v_slots->(2*k-2)->>'entry_id' is null then null else v_slots->(2*k-2) end,
                'b', case when v_slots->(2*k-1)->>'entry_id' is null then null else v_slots->(2*k-1) end) order by k)
              from generate_series(1, jsonb_array_length(v_slots) / 2) k));
end;
$$;
revoke execute on function public.get_group_playoff_preview(uuid) from public, anon;
grant execute on function public.get_group_playoff_preview(uuid) to authenticated;

-- =============================================
-- Result corrections
-- =============================================

-- The sport-specific validated write shared by the preview dry run and the
-- confirmed correction; the bracket side effects are left to the caller.
create or replace function public.write_correction_result(p_match_id uuid, p_result jsonb, p_expected_revision integer)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_sport sport; v_field text;
begin
  select t.sport into v_sport from matches m join tournaments t on t.id = m.tournament_id where m.id = p_match_id;
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

-- A group result changes the playoff only when the qualifiers or their
-- placement change. The preview applies the result inside a subtransaction,
-- compares the playoff slots and rolls the write back; it reports whether the
-- playoff is rebuilt and which scheduled / published playoff matches it touches.
create or replace function public.get_match_correction_preview(p_match_id uuid,p_result jsonb,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare m matches%rowtype; t tournaments%rowtype; v_ids uuid[]; v_data jsonb; v_state jsonb; v_group boolean; v_reseed boolean:=false; v_token text;
  v_before uuid[]; v_after uuid[]; v_scheduled integer:=0; v_published integer:=0;
begin
  select * into m from matches where id=p_match_id;
  if m.id is null then raise exception 'Match not found'; end if;
  if not can_live_score(m.tournament_id) then raise exception 'Not allowed'; end if;
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
    v_before:=group_playoff_slots(t.id);
    begin
      perform write_correction_result(m.id,p_result,p_expected_revision);
      v_after:=group_playoff_slots(t.id);
      raise exception using errcode='YB001',message='correction preview rollback';
    exception
      when sqlstate 'YB001' then null;
      -- An invalid result fails the confirmed write anyway; assume a rebuild.
      when others then v_after:=null;
    end;
    v_reseed:=v_after is null or v_after is distinct from v_before;
  end if;
  if v_group and v_reseed then
    select coalesce(array_agg(id order by id),'{}') into v_ids from matches where tournament_id=t.id and stage='winners';
    select count(distinct s.match_id), count(distinct s.match_id) filter (where s.state='published')
      into v_scheduled, v_published
    from match_schedule s where s.match_id=any(v_ids);
  elsif v_group then v_ids:='{}';
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
  -- also depends on the other group scores, qualifiers, tournament settings and
  -- the playoff schedule that follows the rebuilt bracket.
  select jsonb_build_object('tournament',to_jsonb(t),'result',p_result,
    'matches',(select jsonb_agg(to_jsonb(x) order by x.id) from matches x where case when v_group then x.tournament_id=t.id else x.id=any(v_ids||m.id) end),
    'sets',(select jsonb_agg(to_jsonb(x) order by x.match_id,x.set_index) from match_sets x join matches d on d.id=x.match_id where case when v_group then d.tournament_id=t.id else d.id=any(v_ids||m.id) end),
    'live',(select jsonb_agg(to_jsonb(x) order by x.match_id) from live_scores x where x.match_id=any(v_ids||m.id)),
    'groups',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from groups x where x.tournament_id=t.id) end,
    'qualifiers',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from group_entries x join groups g on g.id=x.group_id where g.tournament_id=t.id) end,
    'schedule',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from match_schedule x join matches d on d.id=x.match_id where d.tournament_id=t.id and d.stage='winners') end
  ) into v_state;
  v_token:=encode(extensions.digest(v_state::text,'sha256'),'hex');
  return jsonb_build_object('token',v_token,'matches',v_data,'reseed_playoff',v_group and v_reseed,'group_stage',v_group,
    'schedule_matches',v_scheduled,'schedule_published',v_published,
    'blocked_live',exists(select 1 from live_scores where match_id=any(v_ids) and status='active'));
exception when lock_not_available or deadlock_detected then
  raise exception 'scoringFlow.correctionConflict';
end;
$$;

create or replace function public.apply_match_correction(p_match_id uuid,p_result jsonb,p_expected_revision integer,p_confirmation_token text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_preview jsonb; m matches%rowtype; v_new uuid;
begin
  -- This repeats permission, LIVE, revision and graph checks under row locks.
  v_preview:=get_match_correction_preview(p_match_id,p_result,p_expected_revision);
  if p_confirmation_token is null or p_confirmation_token is distinct from v_preview->>'token' then
    raise exception 'scoringFlow.correctionConflict';
  end if;
  if (v_preview->>'blocked_live')::boolean then raise exception 'scoringFlow.correctionLive'; end if;
  select * into m from matches where id=p_match_id;
  -- Reuse the exact validators used by ordinary manual saves. Nothing in the
  -- graph changes unless the full result is valid; every write is one transaction.
  v_new:=write_correction_result(m.id,p_result,p_expected_revision);
  if (v_preview->>'reseed_playoff')::boolean then
    -- New UUIDs fence every old playoff form/session. Other group results stay.
    perform build_group_playoff(m.tournament_id);
  elsif coalesce((v_preview->>'group_stage')::boolean,false) then
    -- Same qualifiers in the same places: the playoff stays as it is.
    null;
  elsif m.winner_entry_id is distinct from v_new then
    perform reset_correction_descendants(m.id);
    perform propagate_winner(m.id,v_new);
  end if;
  return v_new;
exception when lock_not_available or deadlock_detected then
  raise exception 'scoringFlow.correctionConflict';
end;
$$;

revoke execute on function public.get_match_correction_preview(uuid,jsonb,integer),public.apply_match_correction(uuid,jsonb,integer,text) from public,anon,authenticated;
grant execute on function public.get_match_correction_preview(uuid,jsonb,integer),public.apply_match_correction(uuid,jsonb,integer,text) to authenticated;

notify pgrst, 'reload schema';
