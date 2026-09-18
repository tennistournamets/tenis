-- Stage B: manual schedule. Courts and per-match assignments in a hybrid time
-- model (fixed time, "not before", or a place in a court queue). Assignments
-- are drafted, checked for conflicts on the server and published explicitly;
-- the public page only ever sees published rows.
create table if not exists public.courts (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tournament_id, name)
);
create index if not exists idx_courts_tournament on courts (tournament_id, sort_order);

-- Kept apart from matches: to_jsonb(matches) is public, a draft must not be.
create table if not exists public.match_schedule (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments (id) on delete cascade,
  match_id uuid not null references matches (id) on delete cascade,
  state text not null check (state in ('draft', 'published')),
  court_id uuid references courts (id) on delete set null,
  scheduled_at timestamptz,
  time_kind text check (time_kind in ('fixed', 'not_before')),
  queue_order integer check (queue_order is null or queue_order > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, state),
  check ((scheduled_at is null) = (time_kind is null)),
  check (court_id is not null or scheduled_at is not null)
);
create index if not exists idx_match_schedule_tournament on match_schedule (tournament_id, state);
drop trigger if exists trg_match_schedule_updated_at on match_schedule;
create trigger trg_match_schedule_updated_at before update on match_schedule for each row execute function set_updated_at();

alter table public.tournaments
  add column if not exists schedule_config jsonb not null default '{}'::jsonb,
  add column if not exists schedule_published_at timestamptz;
revoke select on public.tournaments from anon, authenticated;
grant select (
  id, name, slug, description, sport, format, category, set_format, status,
  is_public, doubles_pairing_mode, format_config, scoring_config, created_by,
  created_at, updated_at, settings_revision, publish_contact,
  registration_capacity, capacity_public, registration_deadline,
  entry_fee_mode, entry_fee_minor, entry_fee_currency, entry_fee_unit, waitlist_enabled,
  schedule_config, schedule_published_at
) on public.tournaments to anon, authenticated;

alter table courts enable row level security;
alter table match_schedule enable row level security;
drop policy if exists courts_public_or_admin_select on courts;
create policy courts_public_or_admin_select on courts
for select
using (
  exists (
    select 1 from tournaments t
    where t.id = courts.tournament_id
      and (t.is_public = true or is_tournament_admin(t.id) or can_live_score(t.id))
  )
);
drop policy if exists match_schedule_select on match_schedule;
create policy match_schedule_select on match_schedule
for select
using (
  exists (
    select 1 from tournaments t
    where t.id = match_schedule.tournament_id
      and (is_tournament_admin(t.id)
        or (match_schedule.state = 'published' and (t.is_public = true or can_live_score(t.id))))
  )
);
-- Writes only through the RPCs below.
revoke insert, update, delete on public.courts, public.match_schedule from public, anon, authenticated;
grant select on public.courts, public.match_schedule to anon, authenticated;
-- DELETE payloads carry tournament_id so clients can scope them.
alter table public.courts replica identity full;
alter table public.match_schedule replica identity full;
do $$
begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='courts') then
  alter publication supabase_realtime add table courts;
 end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='match_schedule') then
  alter publication supabase_realtime add table match_schedule;
 end if;
end $$;

-- Conflicts against the current draft. Hard ones block, soft ones warn.
-- Without match durations only identical fixed times collide; the minimum
-- rest is measured between fixed start times.
create or replace function public.match_schedule_conflicts(p_match_id uuid, p_court_id uuid, p_scheduled_at timestamptz, p_time_kind text, p_queue_order integer)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare m matches%rowtype; v_config jsonb; v_rest integer; v_out jsonb:='[]'::jsonb; r record; v_entries uuid[];
begin
 select * into m from matches where id=p_match_id;
 if m.id is null then raise exception 'Match not found'; end if;
 select schedule_config into v_config from tournaments where id=m.tournament_id;
 v_rest:=coalesce(nullif(v_config->>'min_rest_minutes','')::integer,0);
 v_entries:=array_remove(array[m.side_a_entry_id,m.side_b_entry_id],null);
 if p_court_id is not null and not exists(select 1 from courts c where c.id=p_court_id and c.tournament_id=m.tournament_id) then
  raise exception 'schedule.invalidCourt';
 end if;
 if exists(select 1 from live_scores l where l.match_id=m.id and l.status='active') then
  v_out:=v_out||jsonb_build_object('kind','match_live','severity','hard');
 end if;
 if m.status='finished' then
  v_out:=v_out||jsonb_build_object('kind','match_finished','severity','hard');
 end if;
 if p_court_id is not null and p_queue_order is not null then
  for r in select s.match_id from match_schedule s where s.tournament_id=m.tournament_id and s.state='draft' and s.match_id<>m.id
    and s.court_id=p_court_id and s.queue_order=p_queue_order loop
   v_out:=v_out||jsonb_build_object('kind','queue_taken','severity','hard','match_id',r.match_id,'court_id',p_court_id);
  end loop;
 end if;
 if p_time_kind='fixed' and p_scheduled_at is not null then
  if p_court_id is not null then
   for r in select s.match_id from match_schedule s where s.tournament_id=m.tournament_id and s.state='draft' and s.match_id<>m.id
     and s.court_id=p_court_id and s.time_kind='fixed' and s.scheduled_at=p_scheduled_at loop
    v_out:=v_out||jsonb_build_object('kind','court_busy','severity','hard','match_id',r.match_id,'court_id',p_court_id);
   end loop;
  end if;
  for r in select s.match_id,s.scheduled_at,x.entry_id from match_schedule s join matches o on o.id=s.match_id
    join lateral (select unnest(array[o.side_a_entry_id,o.side_b_entry_id]) as entry_id) x on x.entry_id=any(v_entries)
    where s.tournament_id=m.tournament_id and s.state='draft' and s.match_id<>m.id and s.time_kind='fixed' and s.scheduled_at is not null loop
   if r.scheduled_at=p_scheduled_at then
    v_out:=v_out||jsonb_build_object('kind','participant_busy','severity','hard','match_id',r.match_id,'entry_id',r.entry_id);
   elsif v_rest>0 and abs(extract(epoch from (r.scheduled_at-p_scheduled_at)))<v_rest*60 then
    v_out:=v_out||jsonb_build_object('kind','rest_short','severity','soft','match_id',r.match_id,'entry_id',r.entry_id,
      'minutes',floor(abs(extract(epoch from (r.scheduled_at-p_scheduled_at)))/60));
   end if;
  end loop;
 end if;
 if p_scheduled_at is not null then
  -- Feeder matches must come earlier; matches fed by this one must come later.
  for r in select s.match_id from match_schedule s join matches f on f.id=s.match_id
    where s.state='draft' and s.scheduled_at is not null and (f.next_match_id=m.id or f.loser_next_match_id=m.id) and s.scheduled_at>=p_scheduled_at loop
   v_out:=v_out||jsonb_build_object('kind','order_violation','severity','soft','match_id',r.match_id);
  end loop;
  for r in select s.match_id from match_schedule s where s.state='draft' and s.scheduled_at is not null
    and s.match_id in (m.next_match_id,m.loser_next_match_id) and s.scheduled_at<=p_scheduled_at loop
   v_out:=v_out||jsonb_build_object('kind','order_violation','severity','soft','match_id',r.match_id);
  end loop;
 end if;
 return v_out;
end;
$$;
revoke execute on function public.match_schedule_conflicts(uuid,uuid,timestamptz,text,integer) from public, anon, authenticated;

create or replace function public.check_match_schedule(p_match_id uuid, p_court_id uuid, p_scheduled_at timestamptz, p_time_kind text, p_queue_order integer)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_tid uuid;
begin
 select tournament_id into v_tid from matches where id=p_match_id;
 if v_tid is null or not is_tournament_admin(v_tid) then raise exception 'Not allowed'; end if;
 return match_schedule_conflicts(p_match_id,p_court_id,p_scheduled_at,p_time_kind,p_queue_order);
end;
$$;

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

create or replace function public.clear_match_schedule(p_match_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_tid uuid;
begin
 select tournament_id into v_tid from matches where id=p_match_id;
 if v_tid is null or not is_tournament_admin(v_tid) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=v_tid for update;
 delete from match_schedule where match_id=p_match_id and state='draft';
end;
$$;

-- All draft conflicts at once, for the organizer's summary.
create or replace function public.schedule_draft_conflicts(p_tournament_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r record; v_out jsonb:='[]'::jsonb; c jsonb;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 for r in select * from match_schedule where tournament_id=p_tournament_id and state='draft' order by match_id loop
  c:=match_schedule_conflicts(r.match_id,r.court_id,r.scheduled_at,r.time_kind,r.queue_order);
  if jsonb_array_length(c)>0 then v_out:=v_out||jsonb_build_object('match_id',r.match_id,'conflicts',c); end if;
 end loop;
 return v_out;
end;
$$;

-- Replace the court list. Removed courts leave their matches without a court.
create or replace function public.save_courts(p_tournament_id uuid, p_courts jsonb, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_t tournaments%rowtype; item jsonb; v_keep uuid[]:='{}'; v_id uuid; v_name text; v_names text[]:='{}'; v_pos integer:=0;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_t from tournaments where id=p_tournament_id for update;
 if v_t.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_t.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_courts) is distinct from 'array' then raise exception 'schedule.invalidCourts'; end if;
 for item in select value from jsonb_array_elements(p_courts) loop
  v_name:=btrim(coalesce(item->>'name',''));
  if v_name='' or length(v_name)>60 or v_name=any(v_names) then raise exception 'schedule.invalidCourts'; end if;
  v_names:=array_append(v_names,v_name);
  v_pos:=v_pos+1;
  v_id:=nullif(item->>'id','')::uuid;
  if v_id is not null and exists(select 1 from courts where id=v_id and tournament_id=p_tournament_id) then
   update courts set name=v_name,sort_order=v_pos where id=v_id;
  else
   insert into courts(tournament_id,name,sort_order) values(p_tournament_id,v_name,v_pos) returning id into v_id;
  end if;
  v_keep:=array_append(v_keep,v_id);
 end loop;
 delete from courts where tournament_id=p_tournament_id and not (id=any(v_keep));
 -- Any settings-level change bumps the revision so stale forms are rejected.
 update tournaments set schedule_config=schedule_config where id=p_tournament_id;
 return coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.name,c.id) from courts c where c.tournament_id=p_tournament_id),'[]'::jsonb);
exception when unique_violation then raise exception 'schedule.invalidCourts';
end;
$$;

create or replace function public.publish_schedule(p_tournament_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r record; v_count integer;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=p_tournament_id for update;
 for r in select * from match_schedule where tournament_id=p_tournament_id and state='draft' loop
  if exists(select 1 from jsonb_array_elements(match_schedule_conflicts(r.match_id,r.court_id,r.scheduled_at,r.time_kind,r.queue_order)) c
            where c->>'severity'='hard' and c->>'kind' not in ('match_finished','match_live')) then
   raise exception 'schedule.conflict';
  end if;
 end loop;
 delete from match_schedule where tournament_id=p_tournament_id and state='published';
 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  select tournament_id,match_id,'published',court_id,scheduled_at,time_kind,queue_order
  from match_schedule where tournament_id=p_tournament_id and state='draft';
 get diagnostics v_count=row_count;
 update tournaments set schedule_published_at=now() where id=p_tournament_id;
 return jsonb_build_object('published',v_count);
end;
$$;

-- Discard draft edits: the draft becomes a copy of what is published.
create or replace function public.revert_schedule_draft(p_tournament_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=p_tournament_id for update;
 delete from match_schedule where tournament_id=p_tournament_id and state='draft';
 insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind,queue_order)
  select tournament_id,match_id,'draft',court_id,scheduled_at,time_kind,queue_order
  from match_schedule where tournament_id=p_tournament_id and state='published';
 get diagnostics v_count=row_count;
 return jsonb_build_object('restored',v_count);
end;
$$;

revoke execute on function public.check_match_schedule(uuid,uuid,timestamptz,text,integer),
  public.set_match_schedule(uuid,uuid,timestamptz,text,integer,boolean), public.clear_match_schedule(uuid),
  public.schedule_draft_conflicts(uuid), public.save_courts(uuid,jsonb,integer),
  public.publish_schedule(uuid), public.revert_schedule_draft(uuid) from public, anon, authenticated;
grant execute on function public.check_match_schedule(uuid,uuid,timestamptz,text,integer),
  public.set_match_schedule(uuid,uuid,timestamptz,text,integer,boolean), public.clear_match_schedule(uuid),
  public.schedule_draft_conflicts(uuid), public.save_courts(uuid,jsonb,integer),
  public.publish_schedule(uuid), public.revert_schedule_draft(uuid) to authenticated;

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
   'schedule_config']) then raise exception 'Unsupported settings field'; end if;
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
  waitlist_enabled=v_new.waitlist_enabled,schedule_config=v_new.schedule_config
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
   'waitlist_enabled',t.waitlist_enabled,'schedule_config',t.schedule_config,'schedule_published_at',t.schedule_published_at),
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
