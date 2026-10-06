-- Automatic schedule. The client plans the matches that are still to be played
-- (src/lib/autoSchedule.js: start time, one match duration, courts, rest) and
-- apply_auto_schedule writes the plan as the schedule draft in one step; the
-- organizer reviews and publishes it as before. schedule_config remembers the
-- start and the duration for the next recalculation.
-- Safe to re-run.

-- Schedule settings, shared by the settings form and the automatic schedule:
-- a minimum rest in whole minutes, an IANA time zone name, a match duration of
-- 5..600 whole minutes and the start of the first match.
create or replace function public.assert_schedule_config(p_config jsonb)
returns void language plpgsql stable set search_path=public as $$
declare k text; v_tz text;
begin
 if p_config is null or jsonb_typeof(p_config) is distinct from 'object' then raise exception 'schedule.invalidConfig'; end if;
 for k in select jsonb_object_keys(p_config) loop
  if k<>all(array['min_rest_minutes','timezone','match_minutes','start_at']) then raise exception 'schedule.invalidConfig'; end if;
 end loop;
 if p_config ? 'min_rest_minutes' and (jsonb_typeof(p_config->'min_rest_minutes') is distinct from 'number'
    or (p_config->>'min_rest_minutes')::numeric<0 or (p_config->>'min_rest_minutes')::numeric<>floor((p_config->>'min_rest_minutes')::numeric)) then
  raise exception 'schedule.invalidConfig';
 end if;
 if p_config ? 'timezone' then
  v_tz:=p_config->>'timezone';
  if jsonb_typeof(p_config->'timezone') is distinct from 'string' or v_tz!~'^[A-Za-z_]+(/[A-Za-z0-9_+\-]+)*$' or length(v_tz)>64 then raise exception 'schedule.invalidConfig'; end if;
 end if;
 if p_config ? 'match_minutes' and (jsonb_typeof(p_config->'match_minutes') is distinct from 'number'
    or (p_config->>'match_minutes')::numeric<5 or (p_config->>'match_minutes')::numeric>600
    or (p_config->>'match_minutes')::numeric<>floor((p_config->>'match_minutes')::numeric)) then
  raise exception 'schedule.invalidConfig';
 end if;
 if p_config ? 'start_at' then
  -- An ISO instant; words like 'now' or 'tomorrow' would cast too.
  if jsonb_typeof(p_config->'start_at') is distinct from 'string' or length(p_config->>'start_at')>40
     or p_config->>'start_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' then raise exception 'schedule.invalidConfig'; end if;
  begin
   perform (p_config->>'start_at')::timestamptz;
  exception when others then raise exception 'schedule.invalidConfig';
  end;
 end if;
end;
$$;
revoke execute on function public.assert_schedule_config(jsonb) from public, anon, authenticated;

create or replace function update_tournament_settings(p_tournament_id uuid,p_patch jsonb,p_expected_revision integer,p_expected_matches jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_old tournaments%rowtype; v_new tournaments%rowtype; k text; v_category_changed boolean; v_units text[];
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
 -- Schedule settings: see assert_schedule_config.
 perform assert_schedule_config(v_new.schedule_config);
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

-- Replace the draft of every match still to be played with the plan. Played
-- and live matches keep their rows (a row for one in the plan is ignored: it
-- finished between the preview and the save). Rows have the shape of
-- set_match_schedule; a blocking conflict rejects the whole plan.
create or replace function public.apply_auto_schedule(p_tournament_id uuid, p_rows jsonb, p_config jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_config jsonb; v_count integer; r record;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select schedule_config into v_config from tournaments where id=p_tournament_id for update;
 if not found then raise exception 'Tournament not found'; end if;
 if jsonb_typeof(p_config) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_config) k where k<>all(array['match_minutes','start_at','min_rest_minutes']))
    or not (p_config ? 'match_minutes' and p_config ? 'start_at') then
  raise exception 'schedule.invalidConfig';
 end if;
 v_config:=coalesce(v_config,'{}'::jsonb)||p_config;
 perform assert_schedule_config(v_config);
 if jsonb_typeof(p_rows) is distinct from 'array'
    or exists(select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e) is distinct from 'object'
      or (jsonb_typeof(e->'scheduled_at')='string' and e->>'scheduled_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}')
      or jsonb_typeof(e->'scheduled_at') not in ('string','null')) then
  raise exception 'schedule.invalidAssignment';
 end if;

 create temp table if not exists auto_schedule_rows (match_id uuid, court_id uuid, scheduled_at timestamptz, time_kind text, queue_order integer) on commit drop;
 truncate auto_schedule_rows;
 begin
  insert into auto_schedule_rows
   select * from jsonb_to_recordset(p_rows) as x(match_id uuid, court_id uuid, scheduled_at timestamptz, time_kind text, queue_order integer);
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  raise exception 'schedule.invalidAssignment';
 end;
 if exists(select 1 from auto_schedule_rows x where x.match_id is null
      or (x.time_kind is not null and x.time_kind<>all(array['fixed','not_before']))
      or (x.scheduled_at is null)<>(x.time_kind is null)
      or (x.court_id is null and x.scheduled_at is null)
      or (x.queue_order is not null and (x.court_id is null or x.queue_order<=0))
      or not exists(select 1 from matches m where m.id=x.match_id and m.tournament_id=p_tournament_id))
    or (select count(*) from auto_schedule_rows)<>(select count(distinct match_id) from auto_schedule_rows) then
  raise exception 'schedule.invalidAssignment';
 end if;
 if exists(select 1 from auto_schedule_rows x where x.court_id is not null
      and not exists(select 1 from courts c where c.id=x.court_id and c.tournament_id=p_tournament_id)) then
  raise exception 'schedule.invalidCourt';
 end if;

 delete from auto_schedule_rows x using matches m where m.id=x.match_id
  and (m.status='finished' or exists(select 1 from live_scores l where l.match_id=m.id and l.status='active'));
 delete from match_schedule s using matches m
  where s.tournament_id=p_tournament_id and s.state='draft' and m.id=s.match_id and m.status<>'finished'
    and not exists(select 1 from live_scores l where l.match_id=m.id and l.status='active');
 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  select p_tournament_id,match_id,'draft',court_id,scheduled_at,time_kind,queue_order from auto_schedule_rows;
 get diagnostics v_count=row_count;
 for r in select s.* from match_schedule s join auto_schedule_rows x on x.match_id=s.match_id where s.state='draft' loop
  if exists(select 1 from jsonb_array_elements(match_schedule_conflicts(r.match_id,r.court_id,r.scheduled_at,r.time_kind,r.queue_order)) c
            where c->>'severity'='hard') then
   raise exception 'schedule.conflict';
  end if;
 end loop;
 update tournaments set schedule_config=v_config where id=p_tournament_id;
 return jsonb_build_object('scheduled',v_count,'schedule_config',v_config);
end;
$$;
revoke execute on function public.apply_auto_schedule(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.apply_auto_schedule(uuid,jsonb,jsonb) to authenticated;
notify pgrst, 'reload schema';
