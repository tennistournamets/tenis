-- QA round 2 fixes. Safe to re-run: functions are replaced with their
-- signatures, owners and grants unchanged; internal helpers stay closed.
--
-- 1. Starting a tournament (update_tournament_settings -> in_progress) is
--    refused while the generated matches do not hold exactly the approved
--    field (lifecycle.rosterStale), in every format.
-- 2. Scheduling a finished or live match names the reason
--    (schedule.matchFinished / schedule.matchLive) instead of schedule.conflict.
-- 3. Standings rank a full tie (before the first result, too) by seeding,
--    then by name. The public get_standings columns stay the same.

-- ---------------------------------------------------------------------------
-- Start guard: the structure must match the approved field
-- ---------------------------------------------------------------------------
create or replace function public.tournament_roster_stale(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Every format places each approved entry in its first stage (round robin,
  -- groups, round 1 with BYEs), so the entries in matches are the field.
  with playing as (
    select distinct x.entry_id
    from matches m
    cross join lateral (values (m.side_a_entry_id), (m.side_b_entry_id)) x(entry_id)
    where m.tournament_id = p_tournament_id and x.entry_id is not null
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

create or replace function update_tournament_settings(p_tournament_id uuid,p_patch jsonb,p_expected_revision integer,p_expected_matches jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_old tournaments%rowtype; v_new tournaments%rowtype; k text; v_category_changed boolean; v_tz text; v_units text[];
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_old from tournaments where id=p_tournament_id for update;
 if v_old.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_old.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Invalid settings'; end if;
 for k in select jsonb_object_keys(p_patch) loop
  if k<>all(array['name','description','category','set_format','scoring_config','doubles_pairing_mode','status','is_public','contact_phone','contact_email','publish_contact',
   'registration_capacity','capacity_public','registration_deadline','entry_fee_mode','entry_fee_minor','entry_fee_currency','entry_fee_unit','waitlist_enabled',
   'schedule_config','visibility','venue_address','venue_lat','venue_lng']) then raise exception 'Unsupported settings field'; end if;
 end loop;
 v_new:=jsonb_populate_record(v_old,p_patch);
 -- A finished tournament stays finished: its results and champion are final.
 if v_old.status='completed' and v_new.status is distinct from 'completed' then raise exception 'lifecycle.completedLocked'; end if;
 -- Starting plays the generated structure: it must hold exactly the approved
 -- field (an approval or rejection after the draw leaves it stale).
 if v_new.status='in_progress' and v_old.status is distinct from 'in_progress' and tournament_roster_stale(p_tournament_id) then
  raise exception 'lifecycle.rosterStale';
 end if;
 if v_new.name is null or btrim(v_new.name)='' or v_new.is_public is null or v_new.scoring_config is null or v_new.publish_contact is null or v_new.capacity_public is null or v_new.waitlist_enabled is null then raise exception 'Invalid settings'; end if;
 -- Organizer contacts are checked when they change (older rows keep saving).
 if nullif(btrim(coalesce(v_new.contact_phone,'')),'') is distinct from nullif(btrim(coalesce(v_old.contact_phone,'')),'')
    and nullif(btrim(coalesce(v_new.contact_phone,'')),'') !~ '^\+?[0-9\s\-\(\)]{7,20}$' then raise exception 'registration.invalidPhone'; end if;
 if nullif(btrim(coalesce(v_new.contact_email,'')),'') is distinct from nullif(btrim(coalesce(v_old.contact_email,'')),'')
    and nullif(btrim(coalesce(v_new.contact_email,'')),'') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'registration.invalidEmail'; end if;
 if v_new.publish_contact and nullif(btrim(coalesce(v_new.contact_phone,'')),'') is null and nullif(btrim(coalesce(v_new.contact_email,'')),'') is null then raise exception 'Contact required'; end if;
 if v_new.registration_capacity is not null and v_new.registration_capacity<=0 then raise exception 'registration.invalidCapacity'; end if;
 -- Lowering the limit never removes approved participants silently.
 if v_new.registration_capacity is not null and v_new.registration_capacity is distinct from v_old.registration_capacity
    and v_new.registration_capacity<registration_occupancy(p_tournament_id,null) then raise exception 'registration.capacityBelowOccupied'; end if;
 -- A waitlist queues entries beyond the limit, so it needs one.
 if v_new.waitlist_enabled and v_new.registration_capacity is null
    and (v_new.waitlist_enabled,v_new.registration_capacity) is distinct from (v_old.waitlist_enabled,v_old.registration_capacity) then raise exception 'registration.waitlistNeedsCapacity'; end if;
 if v_new.entry_fee_mode is distinct from 'paid' then
  v_new.entry_fee_minor:=null; v_new.entry_fee_currency:=null; v_new.entry_fee_unit:=null;
  if v_new.entry_fee_mode is not null and v_new.entry_fee_mode<>'free' then raise exception 'registration.invalidFee'; end if;
 else
  v_new.entry_fee_currency:=upper(btrim(coalesce(v_new.entry_fee_currency,'')));
  if v_new.entry_fee_minor is null or v_new.entry_fee_minor<0 or v_new.entry_fee_currency!~'^[A-Z]{3}$'
     or v_new.entry_fee_unit is null or v_new.entry_fee_unit<>all(array['player','pair','team']) then raise exception 'registration.invalidFee'; end if;
  -- A newly set fee is a real amount per a unit that exists in this tournament.
  if (v_new.entry_fee_mode,v_new.entry_fee_minor,v_new.entry_fee_unit) is distinct from (v_old.entry_fee_mode,v_old.entry_fee_minor,v_old.entry_fee_unit) then
   if v_new.entry_fee_minor=0 then raise exception 'registration.zeroFee'; end if;
   v_units:=case when v_new.sport='football' then array['team','player'] when v_new.category='doubles' then array['pair','player'] else array['player'] end;
   if v_new.entry_fee_unit<>all(v_units) then raise exception 'registration.feeUnitMismatch'; end if;
  end if;
 end if;
 -- Venue: an address of sane length, and a point that is either complete or absent.
 v_new.venue_address:=nullif(btrim(coalesce(v_new.venue_address,'')),'');
 if v_new.venue_address is not null and length(v_new.venue_address)>300 then raise exception 'venue.invalidAddress'; end if;
 if (v_new.venue_lat is null)<>(v_new.venue_lng is null) then raise exception 'venue.invalidPoint'; end if;
 if v_new.venue_lat is not null and (v_new.venue_lat< -90 or v_new.venue_lat>90 or v_new.venue_lng< -180 or v_new.venue_lng>180) then raise exception 'venue.invalidPoint'; end if;
 -- Schedule settings: a minimum rest in whole minutes and an IANA time zone name.
 if v_new.schedule_config is null or jsonb_typeof(v_new.schedule_config) is distinct from 'object' then raise exception 'schedule.invalidConfig'; end if;
 for k in select jsonb_object_keys(v_new.schedule_config) loop
  if k<>all(array['min_rest_minutes','timezone']) then raise exception 'schedule.invalidConfig'; end if;
 end loop;
 if v_new.schedule_config ? 'min_rest_minutes' and (jsonb_typeof(v_new.schedule_config->'min_rest_minutes') is distinct from 'number'
    or (v_new.schedule_config->>'min_rest_minutes')::numeric<0 or (v_new.schedule_config->>'min_rest_minutes')::numeric<>floor((v_new.schedule_config->>'min_rest_minutes')::numeric)) then
  raise exception 'schedule.invalidConfig';
 end if;
 if v_new.schedule_config ? 'timezone' then
  v_tz:=v_new.schedule_config->>'timezone';
  if jsonb_typeof(v_new.schedule_config->'timezone') is distinct from 'string' or v_tz!~'^[A-Za-z_]+(/[A-Za-z0-9_+\-]+)*$' or length(v_tz)>64 then raise exception 'schedule.invalidConfig'; end if;
 end if;
 if v_new.visibility is null or v_new.visibility<>all(array['public','link','private','password']) then raise exception 'access.invalidVisibility'; end if;
 if v_new.visibility='password' and v_old.access_password_hash is null then raise exception 'access.passwordRequired'; end if;
 v_category_changed:=v_old.category is distinct from v_new.category;
 if v_category_changed then
  if v_old.status in ('in_progress','completed') then raise exception 'drafts.rulesLocked'; end if;
  perform 1 from matches where tournament_id=p_tournament_id order by id for update nowait;
  if exists(select 1 from matches where tournament_id=p_tournament_id) and p_expected_matches is distinct from tournament_match_versions(p_tournament_id) then raise exception 'drafts.structureConflict'; end if;
  if exists(select 1 from matches where tournament_id=p_tournament_id and (status='finished' or winner_entry_id is not null))
    or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=p_tournament_id)
    or exists(select 1 from live_scores where tournament_id=p_tournament_id) then raise exception 'drafts.rulesLocked'; end if;
 end if;
 update tournaments set name=v_new.name,description=v_new.description,category=v_new.category,set_format=v_new.set_format,
  scoring_config=v_new.scoring_config,doubles_pairing_mode=v_new.doubles_pairing_mode,status=v_new.status,is_public=v_new.is_public,
  contact_phone=nullif(btrim(coalesce(v_new.contact_phone,'')),''),contact_email=nullif(btrim(coalesce(v_new.contact_email,'')),''),publish_contact=v_new.publish_contact,
  registration_capacity=v_new.registration_capacity,capacity_public=v_new.capacity_public,registration_deadline=v_new.registration_deadline,
  entry_fee_mode=v_new.entry_fee_mode,entry_fee_minor=v_new.entry_fee_minor,entry_fee_currency=v_new.entry_fee_currency,entry_fee_unit=v_new.entry_fee_unit,
  waitlist_enabled=v_new.waitlist_enabled,schedule_config=v_new.schedule_config,visibility=v_new.visibility,
  venue_address=v_new.venue_address,venue_lat=v_new.venue_lat,venue_lng=v_new.venue_lng
 where id=p_tournament_id returning * into v_new;
 if v_category_changed then delete from matches where tournament_id=p_tournament_id; end if;
 return to_jsonb(v_new);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;

-- ---------------------------------------------------------------------------
-- Schedule: finished and live matches get their own error codes
-- ---------------------------------------------------------------------------
create or replace function public.set_match_schedule(p_match_id uuid, p_court_id uuid, p_scheduled_at timestamptz, p_time_kind text, p_queue_order integer, p_ignore_warnings boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tid uuid; v_conflicts jsonb; v_row match_schedule%rowtype;
begin
 select tournament_id into v_tid from matches where id=p_match_id;
 if v_tid is null or not is_tournament_admin(v_tid) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=v_tid for update;
 if p_time_kind is not null and p_time_kind<>all(array['fixed','not_before']) then raise exception 'schedule.invalidAssignment'; end if;
 if (p_scheduled_at is null)<>(p_time_kind is null) then raise exception 'schedule.invalidAssignment'; end if;
 if p_court_id is null and p_scheduled_at is null then raise exception 'schedule.invalidAssignment'; end if;
 if p_queue_order is not null and (p_court_id is null or p_queue_order<=0) then raise exception 'schedule.invalidAssignment'; end if;
 v_conflicts:=match_schedule_conflicts(p_match_id,p_court_id,p_scheduled_at,p_time_kind,p_queue_order);
 -- A played or live match keeps its slot; say so instead of a generic conflict.
 if exists(select 1 from jsonb_array_elements(v_conflicts) c where c->>'kind'='match_finished') then raise exception 'schedule.matchFinished'; end if;
 if exists(select 1 from jsonb_array_elements(v_conflicts) c where c->>'kind'='match_live') then raise exception 'schedule.matchLive'; end if;
 if exists(select 1 from jsonb_array_elements(v_conflicts) c where c->>'severity'='hard') then raise exception 'schedule.conflict'; end if;
 if not p_ignore_warnings and jsonb_array_length(v_conflicts)>0 then raise exception 'schedule.warnings'; end if;
 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  values(v_tid,p_match_id,'draft',p_court_id,p_scheduled_at,p_time_kind,p_queue_order)
  on conflict(match_id,state) do update set court_id=excluded.court_id,scheduled_at=excluded.scheduled_at,
   time_kind=excluded.time_kind,queue_order=excluded.queue_order
  returning * into v_row;
 return jsonb_build_object('schedule',to_jsonb(v_row),'conflicts',v_conflicts);
end;
$$;

create or replace function public.place_match_in_court_queue(
  p_match_id uuid, p_court_id uuid, p_order uuid[], p_ignore_warnings boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tid uuid; v_row match_schedule%rowtype; v_old_court uuid; v_conflicts jsonb; v_moved uuid[];
begin
 select tournament_id into v_tid from matches where id=p_match_id;
 if v_tid is null or not is_tournament_admin(v_tid) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=v_tid for update;
 if p_court_id is null or not exists(select 1 from courts c where c.id=p_court_id and c.tournament_id=v_tid) then
  raise exception 'schedule.invalidCourt';
 end if;
 if p_order is null or coalesce(array_length(p_order,1),0)=0
    or not (p_match_id=any(p_order))
    or array_length(p_order,1)<>(select count(distinct x) from unnest(p_order) x)
    or exists(select 1 from unnest(p_order) x where not exists(select 1 from matches m where m.id=x and m.tournament_id=v_tid))
 then raise exception 'schedule.invalidAssignment'; end if;

 select * into v_row from match_schedule where match_id=p_match_id and state='draft';
 v_old_court:=v_row.court_id;
 -- queue_taken cannot apply: this function is the only assigner of the numbers
 -- and they are unique by construction, so the check runs without one.
 v_conflicts:=match_schedule_conflicts(p_match_id,p_court_id,v_row.scheduled_at,v_row.time_kind,null);
 -- A played or live match keeps its slot; say so instead of a generic conflict.
 if exists(select 1 from jsonb_array_elements(v_conflicts) c where c->>'kind'='match_finished') then raise exception 'schedule.matchFinished'; end if;
 if exists(select 1 from jsonb_array_elements(v_conflicts) c where c->>'kind'='match_live') then raise exception 'schedule.matchLive'; end if;
 if exists(select 1 from jsonb_array_elements(v_conflicts) c where c->>'severity'='hard') then raise exception 'schedule.conflict'; end if;
 if not p_ignore_warnings and jsonb_array_length(v_conflicts)>0 then raise exception 'schedule.warnings'; end if;

 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  values(v_tid,p_match_id,'draft',p_court_id,v_row.scheduled_at,v_row.time_kind,null)
  on conflict(match_id,state) do update set court_id=excluded.court_id;

 -- Renumber the target queue 1..N. Rows the caller did not list keep a place
 -- after the listed ones, so a stale board never discards another organizer's
 -- work. Rows without a number stay unnumbered: they are the timed head.
 with wanted as (select x.match_id, x.ord from unnest(p_order) with ordinality x(match_id,ord)),
 target as (
  select s.match_id,
         (case when w.ord is null then 1 else 0 end) as tail,
         coalesce(w.ord, s.queue_order) as ord
  from match_schedule s left join wanted w on w.match_id=s.match_id
  where s.tournament_id=v_tid and s.state='draft' and s.court_id=p_court_id
    and (w.ord is not null or s.queue_order is not null)),
 numbered as (select match_id, row_number() over (order by tail, ord, match_id) n from target),
 upd as (update match_schedule s set queue_order=numbered.n from numbered
   where s.match_id=numbered.match_id and s.state='draft' and s.queue_order is distinct from numbered.n
   returning s.match_id)
 select coalesce(array_agg(match_id),'{}'::uuid[]) into v_moved from upd;

 -- A live or finished match never changes its place in a queue; raising here
 -- rolls the whole renumbering back, so a column is never left half-moved.
 if exists(select 1 from matches m where m.id=any(v_moved) and m.id<>p_match_id
   and (m.status='finished' or exists(select 1 from live_scores l where l.match_id=m.id and l.status='active')))
 then raise exception 'schedule.queueLocked'; end if;

 -- Close the gap the match left on its previous court. Compaction keeps the
 -- relative order, so it is not a change of place and needs no extra check.
 if v_old_court is not null and v_old_court<>p_court_id then
  with numbered as (select s.match_id, row_number() over (order by s.queue_order, s.match_id) n
   from match_schedule s where s.tournament_id=v_tid and s.state='draft' and s.court_id=v_old_court and s.queue_order is not null)
  update match_schedule s set queue_order=numbered.n from numbered
   where s.match_id=numbered.match_id and s.state='draft' and s.queue_order is distinct from numbered.n;
 end if;

 select * into v_row from match_schedule where match_id=p_match_id and state='draft';
 return jsonb_build_object('schedule',to_jsonb(v_row),'conflicts',v_conflicts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Standings: seeding before the name as the last tie-break
-- ---------------------------------------------------------------------------
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
    select e.id, e.display_name, e.seed_order
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
           p.seed_order,
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
                     mg.seed_order asc nulls last, mg.display_name asc, mg.entry_id asc
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

notify pgrst, 'reload schema';
