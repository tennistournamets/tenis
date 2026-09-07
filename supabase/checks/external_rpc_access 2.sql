-- Read-only check 1: after the migration every row must have passed=true.
-- has_column_privilege includes table-level, PUBLIC and inherited grants.
with clients(role_name) as (values ('anon'),('authenticated')),
columns as (
  select c.relname as table_name,a.attname as column_name
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  where n.nspname='public' and c.relname in ('matches','match_sets','groups','group_entries','live_scores','entries')
), checks as (
  select role_name,table_name,'UPDATE columns' as check_name,
    bool_and(has_column_privilege(role_name,'public.'||table_name,column_name,'UPDATE') =
      (role_name='authenticated' and ((table_name='entries' and column_name='status')
        or (table_name='matches' and column_name in ('winner_entry_id','status'))))) as passed
  from clients cross join columns group by role_name,table_name
  union all
  select role_name,table_name,'INSERT columns',
    bool_and(not has_column_privilege(role_name,'public.'||table_name,column_name,'INSERT'))
  from clients cross join columns where table_name<>'entries' group by role_name,table_name
  union all
  select role_name,table_name,'DELETE',not has_table_privilege(role_name,'public.'||table_name,'DELETE')
  from clients cross join (values ('groups'),('group_entries'),('live_scores')) t(table_name)
)
select * from checks order by table_name,role_name,check_name;

-- Read-only check 2: inspect the update policy; only null winner + ready allowed.
select policyname,roles,qual,with_check from pg_policies
where schemaname='public' and tablename='matches' and policyname='matches_update_admin';

-- Read-only check 3: existing links must not cross tournament boundaries.
select 'matches' as check_name,count(*) as invalid_links
from matches m
where exists (select 1 from entries e where e.id in (m.side_a_entry_id,m.side_b_entry_id,m.winner_entry_id) and e.tournament_id<>m.tournament_id)
   or exists (select 1 from matches target where target.id in (m.next_match_id,m.loser_next_match_id) and target.tournament_id<>m.tournament_id)
   or exists (select 1 from groups g where g.id=m.group_id and g.tournament_id<>m.tournament_id)
union all
select 'group_entries',count(*) from group_entries ge
join groups g on g.id=ge.group_id join entries e on e.id=ge.entry_id
where g.tournament_id<>e.tournament_id;

-- Read-only check 4: all eight functions retain postgres owner and SECURITY DEFINER.
-- Six external RPCs allow authenticated; the two internal helpers remain closed.
-- Hashes help compare exact tested definitions.
select p.proname,pg_get_userbyid(p.proowner) as owner,p.prosecdef as security_definer,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  md5(pg_get_functiondef(p.oid)) as definition_hash
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('propagate_winner','clear_downstream','generate_bracket','rebuild_bracket','get_standings','form_manual_pairs','swap_bracket_slots','apply_bracket_layout')
order by p.proname;
-- propagate_winner/clear_downstream are internal: authenticated_execute=false.
-- Also run internal_rpc_access.sql to confirm all six helpers stay closed.
