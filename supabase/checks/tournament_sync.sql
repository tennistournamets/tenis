-- Step 8: read-only verification after migration. Every ok must be true.
select 'snapshot definition' as check_name, md5(pg_get_functiondef('get_tournament_sync_state(uuid)'::regprocedure))='ef75c01292d3c9531c7f8ba8fc316a68' as ok
union all select 'invoker and stable', not prosecdef and provolatile='s' from pg_proc where oid='get_tournament_sync_state(uuid)'::regprocedure
union all select 'anon execute',has_function_privilege('anon','get_tournament_sync_state(uuid)','execute')
union all select 'authenticated execute',has_function_privilege('authenticated','get_tournament_sync_state(uuid)','execute')
union all select 'no PUBLIC execute',not exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='get_tournament_sync_state(uuid)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')
union all select 'groups publication',count(*)=2 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('groups','group_entries')
union all select 'groups RLS',bool_and(relrowsecurity) and count(*)=2 from pg_class where relnamespace='public'::regnamespace and relname in ('groups','group_entries');
