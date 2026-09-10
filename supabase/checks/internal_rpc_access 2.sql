-- Read-only: run before and after the internal-RPC migration.
-- All six helpers must exist, and all three execute flags must be false after it.
with expected(signature) as (
  values
    ('public.propagate_winner(uuid,uuid)'),
    ('public.clear_downstream(uuid,uuid)'),
    ('public.generate_single_elim(uuid,uuid[],public.match_stage)'),
    ('public.generate_double_elim(uuid,uuid[])'),
    ('public.generate_round_robin_matches(uuid,uuid[],public.match_stage,uuid,integer)'),
    ('public.sync_live_match_sets(uuid,jsonb)')
)
select e.signature,
       p.oid is not null as function_exists,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       case when p.oid is not null then exists (
         select 1
         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       ) end as public_execute
from expected e
left join pg_proc p on p.oid = to_regprocedure(e.signature)
order by e.signature;

-- Callers should share the helper owner and retain authenticated EXECUTE.
select p.oid::regprocedure::text as signature,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef as security_definer,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'generate_bracket', 'rebuild_bracket', 'generate_group_playoff',
    'generate_round_robin', 'generate_groups',
    'update_match_sets', 'update_football_result', 'record_point'
  )
order by p.proname;
