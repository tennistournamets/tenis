-- =============================================
-- SPLIT ALL PAIRS
-- =============================================
-- The pair editor can split every pair at once: save_tournament_pairs with
-- p_replace and an empty list splits all pairs (members move to new entries,
-- so ratings and contacts stay with their player). The same locks and
-- conflict checks apply; a new pairing without p_replace still needs at least
-- one complete pair. Safe to re-run.

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
 -- An empty list is allowed only when replacing: it splits every pair.
 if jsonb_array_length(p_pairs)=0 and not p_replace then raise exception 'At least one complete pair required'; end if;
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
