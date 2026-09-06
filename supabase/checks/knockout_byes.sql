-- Read-only, after fix_knockout_byes. All three rows must have passed=true.
-- Digests correspond to the tested step-3 definitions in schema.sql.
with expected(signature, definition_md5, client_execute) as (
  values
    ('public.generate_bracket(uuid,public.draw_mode,uuid[])', 'e7c7454135cfdf0b56000d8b50400fc2', true),
    ('public.generate_single_elim(uuid,uuid[],public.match_stage)', 'c260dd561c5e07d812d3d8167a281294', false),
    ('public.generate_double_elim(uuid,uuid[])', '65cec2e3d4d9c30b4153d78f5f0b16d3', false)
)
select e.signature,
       pg_get_userbyid(p.proowner) as owner,
       md5(pg_get_functiondef(p.oid)) as definition_md5,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       coalesce(
         p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
         and md5(pg_get_functiondef(p.oid)) = e.definition_md5
         and has_function_privilege('anon', p.oid, 'EXECUTE') = e.client_execute
         and has_function_privilege('authenticated', p.oid, 'EXECUTE') = e.client_execute
         and exists (
           select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         ) = e.client_execute, false
       ) as passed
from expected e
left join pg_proc p on p.oid = to_regprocedure(e.signature)
order by e.signature;

-- Existing empty branches need separate review; this migration deliberately
-- does not rebuild existing brackets or discard their results.
select t.id as tournament_id, t.name, count(*) as empty_first_round_matches
from public.matches m
join public.tournaments t on t.id = m.tournament_id
where m.round_number = 1
  and m.side_a_entry_id is null and m.side_b_entry_id is null
  and ((t.format = 'single_elimination' and m.stage = 'main')
    or (t.format = 'groups_playoff' and m.stage = 'winners'))
group by t.id, t.name
order by t.id;
