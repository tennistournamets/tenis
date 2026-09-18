-- Stage D: access. The `counter` role becomes "results only": it keeps live
-- scoring and additionally saves, stops and corrects results. Ownership can be
-- granted or removed only by an owner and the last owner cannot be lost.
-- Visibility gets three explicit modes; `is_public` stays the RLS gate and is
-- kept in sync by a trigger, so no policy changes.

create or replace function add_tournament_admin_by_email(
  p_tournament_id uuid,
  p_email text,
  p_role text default 'editor'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_caller text;
  v_current text;
  v_owners integer;
begin
  v_caller := get_my_tournament_role(p_tournament_id);
  if v_caller is null or v_caller not in ('owner', 'editor') then
    raise exception 'Not authorized';
  end if;
  if p_role is null or p_role not in ('owner', 'editor', 'counter') then
    raise exception 'access.invalidRole';
  end if;

  select id into v_user_id
  from auth.users
  where email = lower(trim(p_email));

  if v_user_id is null then
    raise exception 'User with email % not found', p_email;
  end if;

  perform 1 from tournaments where id = p_tournament_id for update;
  select role into v_current from tournament_admins where tournament_id = p_tournament_id and user_id = v_user_id;
  -- Only an owner grants ownership or changes another owner's role.
  if (p_role = 'owner' or v_current = 'owner') and v_caller <> 'owner' then
    raise exception 'access.ownerOnly';
  end if;
  if v_current = 'owner' and p_role <> 'owner' then
    select count(*) into v_owners from tournament_admins where tournament_id = p_tournament_id and role = 'owner';
    if v_owners <= 1 then
      raise exception 'access.lastOwner';
    end if;
  end if;

  insert into tournament_admins (tournament_id, user_id, role)
  values (p_tournament_id, v_user_id, p_role)
  on conflict (tournament_id, user_id)
  do update set role = excluded.role;
end;
$$;

create or replace function remove_tournament_admin(
  p_tournament_id uuid,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller text;
  v_target tournament_admins%rowtype;
  v_owners integer;
begin
  v_caller := get_my_tournament_role(p_tournament_id);
  if v_caller is null or v_caller not in ('owner', 'editor') then
    raise exception 'Not authorized';
  end if;
  perform 1 from tournaments where id = p_tournament_id for update;
  select * into v_target from tournament_admins where id = p_admin_id and tournament_id = p_tournament_id;
  if v_target.id is null then
    return;
  end if;
  if v_target.role = 'owner' then
    if v_caller <> 'owner' then
      raise exception 'access.ownerOnly';
    end if;
    select count(*) into v_owners from tournament_admins where tournament_id = p_tournament_id and role = 'owner';
    if v_owners <= 1 then
      raise exception 'access.lastOwner';
    end if;
  end if;

  delete from tournament_admins where id = v_target.id;
end;
$$;

-- Membership changes go through the RPCs above only.
revoke insert, update, delete on public.tournament_admins from public, anon, authenticated;

-- Three visibility modes. "link" is what every existing public tournament
-- already was: open to anyone holding the link, not listed anywhere.
alter table public.tournaments add column if not exists visibility text not null default 'link';
do $$
begin
 if not exists (select 1 from pg_constraint where conname='tournaments_visibility_check') then
  alter table public.tournaments add constraint tournaments_visibility_check check (visibility in ('public', 'link', 'private'));
 end if;
end $$;
-- Backfill without touching revisions or timestamps of existing rows.
alter table public.tournaments disable trigger trg_tournament_settings_revision;
alter table public.tournaments disable trigger trg_tournaments_updated_at;
update public.tournaments set visibility = 'private' where is_public = false and visibility = 'link';
alter table public.tournaments enable trigger trg_tournament_settings_revision;
alter table public.tournaments enable trigger trg_tournaments_updated_at;

-- is_public follows visibility; a bare is_public write (older clients,
-- create_tournament) still picks a matching mode.
create or replace function public.sync_tournament_visibility()
returns trigger language plpgsql set search_path=public as $$
begin
 if tg_op = 'INSERT' then
  if new.is_public is false then new.visibility := 'private'; end if;
 elsif new.visibility is distinct from old.visibility then
  null;
 elsif new.is_public is distinct from old.is_public then
  new.visibility := case when new.is_public then (case when old.visibility = 'private' then 'link' else old.visibility end) else 'private' end;
 end if;
 new.is_public := new.visibility <> 'private';
 return new;
end;
$$;
revoke execute on function public.sync_tournament_visibility() from public, anon, authenticated;
drop trigger if exists trg_tournaments_visibility on tournaments;
create trigger trg_tournaments_visibility before insert or update on tournaments for each row execute function sync_tournament_visibility();

revoke select on public.tournaments from anon, authenticated;
grant select (
  id, name, slug, description, sport, format, category, set_format, status,
  is_public, doubles_pairing_mode, format_config, scoring_config, created_by,
  created_at, updated_at, settings_revision, publish_contact,
  registration_capacity, capacity_public, registration_deadline,
  entry_fee_mode, entry_fee_minor, entry_fee_currency, entry_fee_unit, waitlist_enabled,
  schedule_config, schedule_published_at, visibility
) on public.tournaments to anon, authenticated;

-- Results role: the four checks below now accept every scoring role.
create or replace function stop_live_match(p_match_id uuid, p_expected_revision integer default null)
returns live_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live live_scores%rowtype;
  v_tournament_id uuid;
begin
  select m.tournament_id into v_tournament_id
  from matches m
  where m.id = p_match_id for update;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not can_live_score(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  select * into v_live
  from live_scores
  where match_id = p_match_id for update;

  if v_live.id is null then
    raise exception 'Live match not found';
  end if;

  if p_expected_revision is null or p_expected_revision<>v_live.revision then
    raise exception using errcode='P0001',message='scoringFlow.liveConflict';
  end if;
  if v_live.status = 'active' then
    update live_scores
    set status = 'stopped',
        revision = revision + 1
    where id = v_live.id
    returning * into v_live;
  end if;

  update matches set score_revision=score_revision+1 where id=p_match_id;
  return v_live;
end;
$$;

create or replace function write_match_sets_result(
  p_match_id uuid,
  p_sets jsonb,
  p_expected_revision integer default null,
  p_defer_bracket boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_tournament_status tournament_status;
  v_set_format set_format;
  v_sport sport;
  v_rules jsonb;
  v_rule jsonb;
  v_result integer;
  v_max_sets integer;
  v_set_count integer;
  v_expected_index integer := 1;
  v_field text;
  v_number numeric;
  v_complete boolean;
  v_required_wins integer;
  v_side_a_id uuid;
  v_side_b_id uuid;
  v_previous_winner uuid;
  v_new_winner uuid;
  v_a_wins integer := 0;
  v_b_wins integer := 0;
  v_item jsonb;
  v_revision integer;
  v_set_index integer;
  v_a_games integer;
  v_b_games integer;
begin
  select m.tournament_id,
         m.side_a_entry_id,
         m.side_b_entry_id,
         m.winner_entry_id,
         t.set_format,
         tennis_scoring_rules(t.scoring_config),
         t.sport,
         t.status
    into v_tournament_id,
         v_side_a_id,
         v_side_b_id,
         v_previous_winner,
         v_set_format,
         v_rules,
         v_sport,
         v_tournament_status
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id
  for update of m;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;

  if not can_live_score(v_tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_sport not in ('tennis', 'padel') then
    raise exception 'Set scores are supported only for tennis and padel';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Scores can be entered only after the tournament starts';
  end if;

  if v_side_a_id is null or v_side_b_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;

  select score_revision into v_revision from matches where id=p_match_id;
  if exists(select 1 from live_scores where match_id=p_match_id and status='active') then
    raise exception using errcode='P0001',message='scoringFlow.liveBlocked';
  end if;
  if p_expected_revision is null or p_expected_revision<>v_revision then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
  end if;

  v_required_wins := case
    when v_set_format = 'best_of_5' then 3
    else 2
  end;

  v_max_sets := 2 * v_required_wins - 1;

  -- Validate the entire replacement before deleting sets or changing the graph.
  -- Only complete results are accepted; reset is a separate confirmed operation.
  if jsonb_typeof(p_sets) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Sets must be a JSON array';
  end if;
  v_set_count := jsonb_array_length(p_sets);
  if v_set_count > v_max_sets then
    raise exception using errcode = '22023', message = 'Too many sets for this match format';
  end if;

  for v_item in select value from jsonb_array_elements(p_sets) loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Each set must be an object with an index and both game scores';
    end if;
    foreach v_field in array array['set_index', 'side_a_games', 'side_b_games'] loop
      if jsonb_typeof(v_item->v_field) is distinct from 'number' then
        raise exception using errcode = '22023', message = 'Set index and game scores must be non-null JSON numbers';
      end if;
      v_number := (v_item->>v_field)::numeric;
      if v_number <> trunc(v_number)
         or v_number < (case when v_field = 'set_index' then 1 else 0 end)
         or v_number > (case when v_field = 'set_index' then v_max_sets else 2147483647 end) then
        raise exception using errcode = '22023', message = 'Set index or game score is outside the allowed integer range';
      end if;
    end loop;
    foreach v_field in array array['side_a_tiebreak','side_b_tiebreak'] loop
      if v_item ? v_field and v_item->v_field <> 'null'::jsonb then
        if jsonb_typeof(v_item->v_field) is distinct from 'number' then
          raise exception using errcode='22023',message='Tiebreak scores must be JSON integers';
        end if;
        v_number:=(v_item->>v_field)::numeric;
        if v_number<>trunc(v_number) or v_number<0 or v_number>2147483647 then
          raise exception using errcode='22023',message='Tiebreak score is outside the allowed integer range';
        end if;
      end if;
    end loop;
  end loop;

  -- Indices define chronology, independently of the JSON array order.
  for v_item in
    select value from jsonb_array_elements(p_sets)
    order by (value->>'set_index')::numeric
  loop
    v_set_index := (v_item->>'set_index')::numeric::integer;
    v_a_games := (v_item->>'side_a_games')::numeric::integer;
    v_b_games := (v_item->>'side_b_games')::numeric::integer;
    if v_set_index <> v_expected_index then
      raise exception using errcode = '22023', message = 'Set indices must be unique and contiguous starting at 1';
    end if;
    v_expected_index := v_expected_index + 1;

    if v_a_wins = v_required_wins or v_b_wins = v_required_wins then
      raise exception using errcode = '22023', message = 'No further sets are allowed after the match is won';
    end if;

    v_rule:=tennis_set_rule(v_rules,v_set_index,v_required_wins);
    v_result:=tennis_set_result(v_item,v_rule);
    if v_result=-1 then
      raise exception using errcode='22023',message='Invalid set or tiebreak score for the tournament rules';
    end if;
    v_complete:=v_result>0;
    if v_complete then
      if v_result=1 then v_a_wins:=v_a_wins+1; else v_b_wins:=v_b_wins+1; end if;
    else
      if v_set_index <> v_set_count then
        raise exception using errcode = '22023', message = 'Only the final entered set may be unfinished';
      end if;
    end if;
  end loop;

  if v_a_wins<v_required_wins and v_b_wins<v_required_wins then
    raise exception using errcode='22023',message='scoringFlow.finalRequired';
  end if;
  v_new_winner:=case when v_a_wins>=v_required_wins then v_side_a_id else v_side_b_id end;
  if not p_defer_bracket and v_previous_winner is distinct from v_new_winner then
    perform assert_score_correction_safe(p_match_id);
  end if;

  if not p_defer_bracket and exists(select 1 from matches where id=p_match_id and stage='group')
     and exists(select 1 from matches where tournament_id=v_tournament_id and stage='winners') then
    raise exception 'scoringFlow.downstreamStarted';
  end if;

  delete from match_sets where match_id = p_match_id;
  insert into match_sets (match_id,set_index,side_a_games,side_b_games,score_kind,side_a_tiebreak,side_b_tiebreak)
  select p_match_id,(value->>'set_index')::numeric::integer,
    (value->>'side_a_games')::numeric::integer,(value->>'side_b_games')::numeric::integer,
    tennis_set_rule(v_rules,(value->>'set_index')::numeric::integer,v_required_wins)->>'kind',
    (value->>'side_a_tiebreak')::numeric::integer,(value->>'side_b_tiebreak')::numeric::integer
  from jsonb_array_elements(p_sets);

  v_new_winner := case
    when v_a_wins >= v_required_wins then v_side_a_id
    when v_b_wins >= v_required_wins then v_side_b_id
    else null
  end;

  update matches
  set winner_entry_id = v_new_winner,
      side_a_score = v_a_wins,
      side_b_score = v_b_wins,
      status = case
        when v_new_winner is null then 'ready'::match_status
        else 'finished'::match_status
      end
  where id = p_match_id;

  if not p_defer_bracket and v_previous_winner is not null and v_previous_winner is distinct from v_new_winner then
    perform clear_downstream(p_match_id, v_previous_winner);
  end if;

  if not p_defer_bracket and v_new_winner is not null and v_new_winner is distinct from v_previous_winner then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  -- A manual replacement becomes the next live baseline. In-flight taps
  -- carry the old revision and cannot restore the pre-edit score.
  update live_scores set state=tennis_live_state(p_match_id,v_rules,v_required_wins),history='[]'::jsonb,
    status=case when v_new_winner is null then 'stopped' else 'finished' end,revision=revision+1
  where match_id=p_match_id;

  -- status transitions are managed explicitly via the admin UI

  return v_new_winner;
end;
$$;

create or replace function write_football_result(
  p_match_id uuid,
  p_a_goals integer,
  p_b_goals integer,
  p_a_pens integer default null,
  p_b_pens integer default null,
  p_expected_revision integer default null,
  p_defer_bracket boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id uuid;
  v_status tournament_status;
  v_sport sport;
  v_format tournament_format;
  v_stage match_stage;
  v_side_a uuid;
  v_side_b uuid;
  v_prev_winner uuid;
  v_new_winner uuid;
  v_draw_allowed boolean;
begin
  select m.tournament_id, t.status, t.sport, t.format, m.stage,
         m.side_a_entry_id, m.side_b_entry_id, m.winner_entry_id
    into v_tournament_id, v_status, v_sport, v_format, v_stage,
         v_side_a, v_side_b, v_prev_winner
  from matches m
  join tournaments t on t.id = m.tournament_id
  where m.id = p_match_id for update of m;

  if v_tournament_id is null then
    raise exception 'Match not found';
  end if;
  if not can_live_score(v_tournament_id) then
    raise exception 'Not allowed';
  end if;
  if v_sport <> 'football' then
    raise exception 'Goal scores are supported only for football';
  end if;
  if v_status <> 'in_progress'::tournament_status then
    raise exception 'Scores can be entered only after the tournament starts';
  end if;
  if v_side_a is null or v_side_b is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;
  if p_a_goals is null or p_b_goals is null or p_a_goals < 0 or p_b_goals < 0 then
    raise exception 'Valid goal counts required';
  end if;

  if p_expected_revision is null or p_expected_revision<>(select score_revision from matches where id=p_match_id) then
    raise exception using errcode='P0001',message='scoringFlow.conflict';
  end if;
  if (p_a_pens is not null and p_a_pens<0) or (p_b_pens is not null and p_b_pens<0) then raise exception 'Valid penalty counts required'; end if;
  v_draw_allowed := (v_format = 'round_robin') or (v_stage = 'group');

  if p_a_goals > p_b_goals then
    v_new_winner := v_side_a;
  elsif p_b_goals > p_a_goals then
    v_new_winner := v_side_b;
  else
    -- tie
    if v_draw_allowed then
      v_new_winner := null;
    else
      if p_a_pens is null or p_b_pens is null or p_a_pens = p_b_pens then
        raise exception 'Penalty shootout result required to break a knockout tie';
      end if;
      v_new_winner := case when p_a_pens > p_b_pens then v_side_a else v_side_b end;
    end if;
  end if;

  if not p_defer_bracket and v_prev_winner is distinct from v_new_winner then
    perform assert_score_correction_safe(p_match_id);
  end if;
  if not p_defer_bracket and exists(select 1 from matches where id=p_match_id and stage='group')
     and exists(select 1 from matches where tournament_id=v_tournament_id and stage='winners') then
    raise exception 'scoringFlow.downstreamStarted';
  end if;

  update matches
  set side_a_score = p_a_goals,
      side_b_score = p_b_goals,
      side_a_pens = p_a_pens,
      side_b_pens = p_b_pens,
      winner_entry_id = v_new_winner,
      status = 'finished'::match_status
  where id = p_match_id;

  if not p_defer_bracket and v_prev_winner is not null and v_prev_winner is distinct from v_new_winner then
    perform clear_downstream(p_match_id, v_prev_winner);
  end if;

  if not p_defer_bracket and v_new_winner is not null and v_new_winner is distinct from v_prev_winner then
    perform propagate_winner(p_match_id, v_new_winner);
  end if;

  return v_new_winner;
end;
$$;

create or replace function get_match_correction_preview(p_match_id uuid,p_result jsonb,p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare m matches%rowtype; t tournaments%rowtype; v_ids uuid[]; v_data jsonb; v_state jsonb; v_group boolean; v_token text;
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
    select coalesce(array_agg(id order by id),'{}') into v_ids from matches where tournament_id=t.id and stage='winners';
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
  -- also depends on the other group scores, qualifiers and tournament settings.
  select jsonb_build_object('tournament',to_jsonb(t),'result',p_result,
    'matches',(select jsonb_agg(to_jsonb(x) order by x.id) from matches x where case when v_group then x.tournament_id=t.id else x.id=any(v_ids||m.id) end),
    'sets',(select jsonb_agg(to_jsonb(x) order by x.match_id,x.set_index) from match_sets x join matches d on d.id=x.match_id where case when v_group then d.tournament_id=t.id else d.id=any(v_ids||m.id) end),
    'live',(select jsonb_agg(to_jsonb(x) order by x.match_id) from live_scores x where x.match_id=any(v_ids||m.id)),
    'groups',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from groups x where x.tournament_id=t.id) end,
    'qualifiers',case when v_group then (select jsonb_agg(to_jsonb(x) order by x.id) from group_entries x join groups g on g.id=x.group_id where g.tournament_id=t.id) end
  ) into v_state;
  v_token:=encode(extensions.digest(v_state::text,'sha256'),'hex');
  return jsonb_build_object('token',v_token,'matches',v_data,'reseed_playoff',v_group,
    'blocked_live',exists(select 1 from live_scores where match_id=any(v_ids) and status='active'));
exception when lock_not_available or deadlock_detected then
  raise exception 'scoringFlow.correctionConflict';
end;
$$;

create or replace function update_tournament_settings(p_tournament_id uuid,p_patch jsonb,p_expected_revision integer,p_expected_matches jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_old tournaments%rowtype; v_new tournaments%rowtype; k text; v_category_changed boolean; v_tz text;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_old from tournaments where id=p_tournament_id for update;
 if v_old.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_old.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Invalid settings'; end if;
 for k in select jsonb_object_keys(p_patch) loop
  if k<>all(array['name','description','category','set_format','scoring_config','doubles_pairing_mode','status','is_public','contact_phone','contact_email','publish_contact',
   'registration_capacity','capacity_public','registration_deadline','entry_fee_mode','entry_fee_minor','entry_fee_currency','entry_fee_unit','waitlist_enabled',
   'schedule_config','visibility']) then raise exception 'Unsupported settings field'; end if;
 end loop;
 v_new:=jsonb_populate_record(v_old,p_patch);
 if v_new.name is null or btrim(v_new.name)='' or v_new.is_public is null or v_new.scoring_config is null or v_new.publish_contact is null or v_new.capacity_public is null or v_new.waitlist_enabled is null then raise exception 'Invalid settings'; end if;
 if v_new.publish_contact and nullif(btrim(coalesce(v_new.contact_phone,'')),'') is null and nullif(btrim(coalesce(v_new.contact_email,'')),'') is null then raise exception 'Contact required'; end if;
 if v_new.registration_capacity is not null and v_new.registration_capacity<=0 then raise exception 'registration.invalidCapacity'; end if;
 -- Lowering the limit never removes approved participants silently.
 if v_new.registration_capacity is not null and v_new.registration_capacity is distinct from v_old.registration_capacity
    and v_new.registration_capacity<registration_occupancy(p_tournament_id,null) then raise exception 'registration.capacityBelowOccupied'; end if;
 if v_new.entry_fee_mode is distinct from 'paid' then
  v_new.entry_fee_minor:=null; v_new.entry_fee_currency:=null; v_new.entry_fee_unit:=null;
  if v_new.entry_fee_mode is not null and v_new.entry_fee_mode<>'free' then raise exception 'registration.invalidFee'; end if;
 else
  v_new.entry_fee_currency:=upper(btrim(coalesce(v_new.entry_fee_currency,'')));
  if v_new.entry_fee_minor is null or v_new.entry_fee_minor<0 or v_new.entry_fee_currency!~'^[A-Z]{3}$'
     or v_new.entry_fee_unit is null or v_new.entry_fee_unit<>all(array['player','pair','team']) then raise exception 'registration.invalidFee'; end if;
 end if;
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
 if v_new.visibility is null or v_new.visibility<>all(array['public','link','private']) then raise exception 'access.invalidVisibility'; end if;
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
  waitlist_enabled=v_new.waitlist_enabled,schedule_config=v_new.schedule_config,visibility=v_new.visibility
 where id=p_tournament_id returning * into v_new;
 if v_category_changed then delete from matches where tournament_id=p_tournament_id; end if;
 return to_jsonb(v_new);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;

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
   'waitlist_enabled',t.waitlist_enabled,'schedule_config',t.schedule_config,'schedule_published_at',t.schedule_published_at,'visibility',t.visibility),
  'registration', tournament_registration_state(t.id),
  'entries', coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,
   'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,
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
   else '{}'::jsonb end
 ) from tournaments t where t.id=p_tournament_id;
$$;
notify pgrst, 'reload schema';
