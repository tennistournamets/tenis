-- Step 7: preserve drafts and reject stale writes to settings, layouts and pairs.
alter table tournaments add column if not exists settings_revision integer not null default 0;
create or replace function bump_tournament_settings_revision()
returns trigger language plpgsql set search_path=public as $$
begin new.settings_revision:=old.settings_revision+1; return new; end;
$$;
drop trigger if exists trg_tournament_settings_revision on tournaments;
create trigger trg_tournament_settings_revision before update on tournaments for each row execute function bump_tournament_settings_revision();

create or replace function tournament_match_versions(p_tournament_id uuid)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',score_revision) order by id),'[]') from matches where tournament_id=p_tournament_id;
$$;
create or replace function tournament_entry_snapshot(p_tournament_id uuid)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'display_name',e.display_name,'entry_type',e.entry_type,'status',e.status,'created_at',e.created_at,
  'entry_members',coalesce((select jsonb_agg(jsonb_build_object('id',em.id,'entry_id',em.entry_id,'member_name',em.member_name,'member_order',em.member_order) order by em.member_order) from entry_members em where em.entry_id=e.id),'[]'::jsonb)) order by e.id),'[]')
 from entries e where e.tournament_id=p_tournament_id;
$$;
create or replace function get_tournament_entry_state(p_tournament_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_admin boolean; v_result jsonb;
begin
 if not can_live_score(p_tournament_id) then raise exception 'Not allowed'; end if;
 v_admin:=is_tournament_admin(p_tournament_id);
 select jsonb_build_object('entries',coalesce((select jsonb_agg(x order by x->>'id') from jsonb_array_elements(tournament_entry_snapshot(p_tournament_id)) x where v_admin or x->>'status'='approved'),'[]'),
   'matches',tournament_match_versions(p_tournament_id),'settings_revision',(select settings_revision from tournaments where id=p_tournament_id)) into v_result;
 return v_result;
end;
$$;

create or replace function update_tournament_settings(p_tournament_id uuid,p_patch jsonb,p_expected_revision integer,p_expected_matches jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_old tournaments%rowtype; v_new tournaments%rowtype; k text; v_category_changed boolean;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_old from tournaments where id=p_tournament_id for update;
 if v_old.id is null then raise exception 'Tournament not found'; end if;
 if p_expected_revision is null or p_expected_revision<>v_old.settings_revision then raise exception 'drafts.conflict'; end if;
 if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'Invalid settings'; end if;
 for k in select jsonb_object_keys(p_patch) loop
  if k<>all(array['name','description','category','set_format','scoring_config','doubles_pairing_mode','status','is_public']) then raise exception 'Unsupported settings field'; end if;
 end loop;
 v_new:=jsonb_populate_record(v_old,p_patch);
 if v_new.name is null or btrim(v_new.name)='' or v_new.is_public is null or v_new.scoring_config is null then raise exception 'Invalid settings'; end if;
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
  scoring_config=v_new.scoring_config,doubles_pairing_mode=v_new.doubles_pairing_mode,status=v_new.status,is_public=v_new.is_public
 where id=p_tournament_id returning * into v_new;
 if v_category_changed then delete from matches where tournament_id=p_tournament_id; end if;
 return to_jsonb(v_new);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;

create or replace function save_bracket_layout(p_tournament_id uuid,p_layout jsonb,p_expected_matches jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 perform 1 from tournaments where id=p_tournament_id for update;
 if exists(select 1 from tournaments where id=p_tournament_id and status in ('in_progress','completed')) then raise exception 'drafts.rulesLocked'; end if;
 perform 1 from matches where tournament_id=p_tournament_id order by id for update nowait;
 if p_expected_matches is null or p_expected_matches is distinct from tournament_match_versions(p_tournament_id) then raise exception 'drafts.structureConflict'; end if;
 perform apply_bracket_layout(p_tournament_id,p_layout);
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;

-- References are member UUIDs, not names: two people with the same name stay
-- distinct. Splitting and regrouping are atomic and preserve member/player IDs.
create or replace function save_tournament_pairs(p_tournament_id uuid,p_pairs jsonb,p_replace boolean,
 p_expected_entries jsonb,p_expected_matches jsonb,p_expected_revision integer)
returns integer language plpgsql security definer set search_path=public as $$
declare v_t tournaments%rowtype; pair jsonb; mid uuid; used uuid[]:='{}'; v_split record; new_entry uuid; a uuid; b uuid; ea uuid; eb uuid; na text; nb text; n integer:=0;
begin
 if not is_tournament_admin(p_tournament_id) then raise exception 'Not allowed'; end if;
 select * into v_t from tournaments where id=p_tournament_id for update;
 if p_expected_revision is null or v_t.settings_revision<>p_expected_revision then raise exception 'drafts.structureConflict'; end if;
 if v_t.status in ('in_progress','completed') or v_t.category<>'doubles' or v_t.doubles_pairing_mode is distinct from 'pick_random'::doubles_pairing_mode then raise exception 'drafts.rulesLocked'; end if;
 perform 1 from matches where tournament_id=p_tournament_id order by id for update nowait;
 perform 1 from entries where tournament_id=p_tournament_id order by id for update nowait;
 perform 1 from entry_members where entry_id in(select id from entries where tournament_id=p_tournament_id) order by id for update nowait;
 if p_expected_entries is null or p_expected_entries is distinct from tournament_entry_snapshot(p_tournament_id)
  or p_expected_matches is null or p_expected_matches is distinct from tournament_match_versions(p_tournament_id) then raise exception 'drafts.structureConflict'; end if;
 if jsonb_typeof(p_pairs) is distinct from 'array' or p_replace is null then raise exception 'Invalid pairs'; end if;
 for pair in select value from jsonb_array_elements(p_pairs) loop
  if jsonb_typeof(pair) is distinct from 'array' or jsonb_array_length(pair)<>2 then raise exception 'Invalid pairs'; end if;
  for mid in select value::uuid from jsonb_array_elements_text(pair) loop
   if mid is null or mid=any(used) or not exists(select 1 from entry_members em join entries e on e.id=em.entry_id
      where em.id=mid and e.tournament_id=p_tournament_id and e.status='approved' and e.entry_type='doubles'
       and (p_replace or (select count(*) from entry_members other where other.entry_id=e.id)=1)) then raise exception 'Invalid or repeated pair member'; end if;
   used:=array_append(used,mid);
  end loop;
 end loop;
 if jsonb_array_length(p_pairs)=0 then raise exception 'At least one complete pair required'; end if;
 -- A pairing edit may reset only an unplayed bracket reviewed by the organiser.
 if exists(select 1 from matches where tournament_id=p_tournament_id and status='finished')
  or exists(select 1 from match_sets s join matches m on m.id=s.match_id where m.tournament_id=p_tournament_id)
  or exists(select 1 from live_scores where tournament_id=p_tournament_id) then raise exception 'drafts.rulesLocked'; end if;
 delete from matches where tournament_id=p_tournament_id;
 if p_replace then
  for v_split in select em.id,em.entry_id,em.member_name from entry_members em join entries en on en.id=em.entry_id
    where en.tournament_id=p_tournament_id and en.status='approved' and em.member_order=2 order by em.id loop
   insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
     values(p_tournament_id,'doubles',v_split.member_name,'split-'||gen_random_uuid(),'approved') returning id into new_entry;
   update entry_members set entry_id=new_entry,member_order=1 where id=v_split.id;
   update entries set display_name=(select member_name from entry_members where entry_id=v_split.entry_id and member_order=1) where id=v_split.entry_id;
  end loop;
 end if;
 for pair in select value from jsonb_array_elements(p_pairs) loop
  a:=(pair->>0)::uuid; b:=(pair->>1)::uuid;
  select entry_id,member_name into ea,na from entry_members where id=a;
  select entry_id,member_name into eb,nb from entry_members where id=b;
  update entry_members set entry_id=ea,member_order=2 where id=b;
  update entries set display_name=na||' / '||nb where id=ea;
  delete from entries where id=eb;
  n:=n+1;
 end loop;
 return n;
exception when lock_not_available or deadlock_detected then raise exception 'drafts.structureConflict';
end;
$$;
revoke execute on function bump_tournament_settings_revision(),tournament_match_versions(uuid),tournament_entry_snapshot(uuid) from public,anon,authenticated;
revoke execute on function get_tournament_entry_state(uuid),update_tournament_settings(uuid,jsonb,integer,jsonb),save_bracket_layout(uuid,jsonb,jsonb),save_tournament_pairs(uuid,jsonb,boolean,jsonb,jsonb,integer) from public,anon,authenticated;
grant execute on function get_tournament_entry_state(uuid),update_tournament_settings(uuid,jsonb,integer,jsonb),save_bracket_layout(uuid,jsonb,jsonb),save_tournament_pairs(uuid,jsonb,boolean,jsonb,jsonb,integer) to authenticated;
notify pgrst,'reload schema';
