-- Read-only verification of step 7. Also run result_corrections.sql for score RPCs.
with expected(signature,hash,definer,client) as (values
('bump_tournament_settings_revision()','3315b62f1c5c90d4d4c25d5a380e5d53',false,false),
('get_tournament_entry_state(uuid)','2d7b8215bbdaddbc2aca9177905b83d8',true,true),
('save_bracket_layout(uuid,jsonb,jsonb)','449f5f0b6ca134550584e10ca870054e',true,true),
('save_tournament_pairs(uuid,jsonb,boolean,jsonb,jsonb,integer)','2f9de638b03cea962c65c94add9265d3',true,true),
('tournament_entry_snapshot(uuid)','ca582578a71cef0cafed76ac27f97780',false,false),
('tournament_match_versions(uuid)','b2ba399e76e15516f0ac3f3485b6ef3e',false,false),
('update_tournament_settings(uuid,jsonb,integer,jsonb)','fa42edf2fe665a5b52233e7aa8a4ce61',true,true)
) select e.signature,p.oid is not null and md5(pg_get_functiondef(p.oid))=e.hash and p.prosecdef=e.definer
 and has_function_privilege('authenticated',p.oid,'execute')=e.client
 and not has_function_privilege('anon',p.oid,'execute')
 and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') passed
from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
union all select 'settings_revision trigger',exists(select 1 from pg_trigger where tgrelid='public.tournaments'::regclass and tgname='trg_tournament_settings_revision' and tgenabled='O' and tgfoid='public.bump_tournament_settings_revision()'::regprocedure);
