-- Drag-and-drop placement on the court board.
-- 1. place_match_in_court_queue: renumbers a whole court queue atomically,
--    because set_match_schedule writes one row per call and queue_taken is a
--    hard conflict, so a client-side renumbering cannot avoid a duplicate.
-- 2. save_courts: a queue-only row used to break court deletion outright.

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
 -- A queue-only row cannot survive losing its court: the table requires a
 -- court or a time, and the foreign key would null the court out from under
 -- the check. Timed rows keep their time and only lose the court and its
 -- place in the queue, which is what the hint under the editor promises.
 delete from match_schedule where tournament_id=p_tournament_id
  and court_id is not null and not (court_id=any(v_keep)) and scheduled_at is null;
 update match_schedule set queue_order=null where tournament_id=p_tournament_id
  and court_id is not null and not (court_id=any(v_keep)) and queue_order is not null;
 delete from courts where tournament_id=p_tournament_id and not (id=any(v_keep));
 -- Any settings-level change bumps the revision so stale forms are rejected.
 update tournaments set schedule_config=schedule_config where id=p_tournament_id;
 return coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.name,c.id) from courts c where c.tournament_id=p_tournament_id),'[]'::jsonb);
exception when unique_violation then raise exception 'schedule.invalidCourts';
end;
$$;

-- Drag-and-drop on the court board. set_match_schedule writes one row per call
-- and queue_taken is a hard conflict, so renumbering a queue from the client
-- would have to pass through a duplicate (court_id, queue_order). Here the whole
-- queue is renumbered under the same per-tournament lock, and rows that only
-- shift a number are not re-validated: neither their court nor their time moves.
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
revoke execute on function public.place_match_in_court_queue(uuid,uuid,uuid[],boolean) from public, anon, authenticated;
grant execute on function public.place_match_in_court_queue(uuid,uuid,uuid[],boolean) to authenticated;
notify pgrst, 'reload schema';
