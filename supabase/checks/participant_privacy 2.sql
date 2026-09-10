-- 1. Read-only: every ACL check must pass. Column checks include table/PUBLIC grants.
with roles(name) as (values ('anon'),('authenticated')),
checks as (
  select name as role_name,'entries contact unreadable' as check_name,
    not has_column_privilege(name,'public.entries','phone_or_email','SELECT') as passed from roles
  union all
  select name,'entries public projection readable',bool_and(has_column_privilege(name,'public.entries',c,'SELECT'))
    from roles cross join unnest(array['id','tournament_id','display_name','entry_type','status','created_at']) as cols(c) group by name
  union all
  select name,'players SELECT limited to authenticated',has_table_privilege(name,'public.players','SELECT')=(name='authenticated') from roles
  union all
  select name,'players UPDATE limited to profile fields',bool_and(
    has_column_privilege(name,'public.players',a.attname,'UPDATE')=
      (name='authenticated' and a.attname in ('display_name','avatar_url','birth_year','gender','country')))
    from roles cross join pg_attribute a where a.attrelid='public.players'::regclass and a.attnum>0 and not a.attisdropped group by name
  union all
  select name,'players INSERT limited to own profile fields',bool_and(
    has_column_privilege(name,'public.players',a.attname,'INSERT')=
      (name='authenticated' and a.attname in ('user_id','display_name','avatar_url','birth_year','gender','country')))
    from roles cross join pg_attribute a where a.attrelid='public.players'::regclass and a.attnum>0 and not a.attisdropped group by name
  union all
  select name,'players no DELETE or TRUNCATE',not has_table_privilege(name,'public.players','DELETE') and not has_table_privilege(name,'public.players','TRUNCATE') from roles
  union all
  select 'all clients','RLS enabled for participant tables',bool_and(relrowsecurity)
    from pg_class where oid in ('public.entries'::regclass,'public.entry_members'::regclass,'public.players'::regclass)
)
select * from checks order by check_name,role_name;

-- 2. Read-only: inspect effective SELECT and profile-write policies.
-- Entries: managers see all statuses; others see approved entries only in an
-- accessible tournament. Members inherit their parent entry's RLS.
-- Players: authenticated UID owns a non-deleted, unmerged profile, on both
-- sides of UPDATE. No other permissive profile policies should be present.
select tablename,policyname,cmd,roles,qual,with_check from pg_policies
where schemaname='public' and (
  (tablename in ('entries','entry_members') and cmd='SELECT') or tablename='players')
order by tablename,policyname;
