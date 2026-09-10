-- Read-only release check: canonical definitions, ACLs and closed legacy routes.
with expected(signature,hash,definer,client) as(values
('assert_score_correction_safe(uuid)','9beada1861a6f08fde0a34d1f74968fd',false,false),
('bump_match_score_revision()','95d7bf524323344c7caa4d824c9acc00',false,false),
('get_tournament_score_state(uuid)','fb5981c03dfffdc73d1d268a1fa10c94',true,true),
('record_point(uuid,text,integer)','834980c42b80bc5f9b167bc5cf22b738',true,true),
('start_live_match(uuid,integer)','1f329d703ccbe74f21cc6101907b0f60',true,true),
('stop_live_match(uuid,integer)','b08758a5fe2178589238438bbf573439',true,true),
('update_football_result(uuid,integer,integer,integer,integer,integer)','bccc8b966b41e7226eae14cb3a54774d',true,true),
('update_match_sets(uuid,jsonb,integer)','5a1ab5268dec10908313335b8010836f',true,true)
) select e.signature,p.oid is not null and md5(pg_get_functiondef(p.oid))=e.hash and p.prosecdef=e.definer
 and has_function_privilege('authenticated',p.oid,'execute')=e.client
 and not has_function_privilege('anon',p.oid,'execute')
 and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') passed
from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature);

select to_regprocedure('update_match_sets(uuid,jsonb)') is null and to_regprocedure('start_live_match(uuid)') is null
 and to_regprocedure('stop_live_match(uuid)') is null and to_regprocedure('update_football_result(uuid,integer,integer,integer,integer)') is null legacy_closed,
 not has_column_privilege('authenticated','matches','status','UPDATE') and not has_column_privilege('authenticated','matches','winner_entry_id','UPDATE')
 and not has_table_privilege('authenticated','match_sets','DELETE') direct_reset_closed;
