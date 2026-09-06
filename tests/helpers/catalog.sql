-- Deterministic public application catalog, independent of object OIDs.
select jsonb_build_object(
 'columns', (select jsonb_agg(to_jsonb(x) order by table_name,ordinal_position) from (
   select table_name,column_name,ordinal_position,column_default,is_nullable,data_type,udt_name
   from information_schema.columns where table_schema='public') x),
 'enums', (select jsonb_agg(to_jsonb(x) order by typname,enumsortorder) from (
   select t.typname,e.enumsortorder,e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
   join pg_namespace n on n.oid=t.typnamespace where n.nspname='public') x),
 'constraints', (select jsonb_agg(to_jsonb(x) order by relation,name) from (
   select c.conrelid::regclass::text relation,c.conname name,pg_get_constraintdef(c.oid) definition
   from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public') x),
 'indexes', (select jsonb_agg(to_jsonb(x) order by tablename,indexname) from (
   select tablename,indexname,indexdef from pg_indexes where schemaname='public') x),
 'functions', (select jsonb_agg(to_jsonb(x) order by signature) from (
   select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,
   (select jsonb_agg(a::text order by a::text) from unnest(coalesce(p.proacl,acldefault('f',p.proowner))) a) acl
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f') x),
 'policies', (select jsonb_agg(to_jsonb(x) order by tablename,policyname) from (
   select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public') x),
 'tables', (select jsonb_agg(to_jsonb(x) order by name) from (
   select c.relname name,c.relrowsecurity rls,c.relforcerowsecurity force_rls,
   (select jsonb_agg(a::text order by a::text) from unnest(coalesce(c.relacl,acldefault('r',c.relowner))) a) acl
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') x),
 'column_grants', (select jsonb_agg(to_jsonb(x) order by table_name,column_name,grantee,privilege_type) from (
   select table_name,column_name,grantee,privilege_type,is_grantable from information_schema.column_privileges where table_schema='public') x),
 'triggers', (select jsonb_agg(to_jsonb(x) order by relation,name) from (
   select t.tgrelid::regclass::text relation,t.tgname name,pg_get_triggerdef(t.oid) definition
   from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and not t.tgisinternal) x),
 'publication', (select jsonb_agg(to_jsonb(x) order by pubname,tablename) from (
   select pubname,tablename from pg_publication_tables where schemaname='public') x)
) catalog;
