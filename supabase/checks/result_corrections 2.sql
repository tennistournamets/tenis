-- Read-only check after the step-6 migration; supersedes step-5 definition hashes.
with expected(signature,hash,definer,client) as (values
('apply_match_correction(uuid,jsonb,integer,text)','ca5ee806a1dc12632633b1ce489662ea',true,true),
('assert_score_correction_safe(uuid)','9beada1861a6f08fde0a34d1f74968fd',false,false),
('bump_match_score_revision()','95d7bf524323344c7caa4d824c9acc00',false,false),
('clear_downstream(uuid,uuid)','c4f497568f846ebe1b5553a10b1f0e62',true,false),
('correction_descendants(uuid)','8181b5501f350b8f7cf7f5dd41af4356',false,false),
('get_match_correction_preview(uuid,jsonb,integer)','6743a923e931ce00a46cdd426db63887',true,true),
('get_tournament_score_state(uuid)','fb5981c03dfffdc73d1d268a1fa10c94',true,true),
('propagate_winner(uuid,uuid)','6792077db31ec31b5fc1d714bdaaf8d8',true,false),
('record_point(uuid,text,integer)','834980c42b80bc5f9b167bc5cf22b738',true,true),
('reset_correction_descendants(uuid)','146dc3aa35869dc79f9febe6165c0fc3',false,false),
('start_live_match(uuid,integer)','1f329d703ccbe74f21cc6101907b0f60',true,true),
('stop_live_match(uuid,integer)','b08758a5fe2178589238438bbf573439',true,true),
('update_football_result(uuid,integer,integer,integer,integer,integer)','3dfe01b29fe1fb1de463889bb670db40',true,true),
('update_match_sets(uuid,jsonb,integer)','c4311e7057f76357beae8470e601546c',true,true),
('write_football_result(uuid,integer,integer,integer,integer,integer,boolean)','0341f72675d97ae4e08a7a49d364abfd',true,false),
('write_match_sets_result(uuid,jsonb,integer,boolean)','b99af5ec67ccbc54d8d03751f5a16b63',true,false)
) select e.signature,p.oid is not null and md5(pg_get_functiondef(p.oid))=e.hash and p.prosecdef=e.definer
 and has_function_privilege('authenticated',p.oid,'execute')=e.client
 and not has_function_privilege('anon',p.oid,'execute')
 and not exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') passed
from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature);
