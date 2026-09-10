-- Read-only: definitions must match the tested ITF 2026 implementation.
with expected(signature,definition_md5) as (values
    ('guard_tennis_scoring_settings()', '9ab8c2815b2f1f1b9b47fb50a73df649'),
    ('record_point(uuid,text,integer)', '12d4e917ab893bc2389502b26e86883f'),
    ('start_live_match(uuid)', '44381937886ff42ca7241ae6e907f50e'),
    ('stop_live_match(uuid)', 'b2b9d060335c99b5be109836b4834214'),
    ('sync_live_match_sets(uuid,jsonb)', 'b06f823c9adf593670430d3da0403b99'),
    ('tennis_apply_point(jsonb,text)', '78fd941b6faea704cb5c16b498682df5'),
    ('tennis_live_state(uuid,jsonb,integer)', 'f233bfc0ba57daf95adcbf067df1f906'),
    ('tennis_race_result(integer,integer,integer,integer)', 'a3f0323538b134b158a5a7dd2d5226a0'),
    ('tennis_scoring_rules(jsonb)', 'ff3ac8b6b43e37ee4f7d881d54690beb'),
    ('tennis_set_result(jsonb,jsonb)', '0aab3eea021a370780768428c3c8c84a'),
    ('tennis_set_rule(jsonb,integer,integer)', 'd442514db3c7cb8f12202ae55b5d0c88'),
    ('update_match_sets(uuid,jsonb)', '1d4e60e4e02c5658fbcf5c6a8a2b16c4')
)
select e.signature,md5(pg_get_functiondef(p.oid)) definition_md5,
  md5(pg_get_functiondef(p.oid))=e.definition_md5 as passed
from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature) order by e.signature;

-- Every helper must be closed; external RPCs keep their existing grants.
select oid::regprocedure::text signature,pg_get_userbyid(proowner) owner,prosecdef,
  has_function_privilege('anon',oid,'execute') anon_execute,
  has_function_privilege('authenticated',oid,'execute') authenticated_execute,
  exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) where grantee=0 and privilege_type='EXECUTE') public_execute
from pg_proc where proname in ('tennis_scoring_rules','tennis_set_rule','tennis_race_result','tennis_set_result','tennis_live_state','guard_tennis_scoring_settings','tennis_apply_point','sync_live_match_sets') order by proname;

-- No invalid set sequences expected. Existing aggregates are audited separately.
with classified as (
  select m.id,m.tournament_id,s.set_index,case when t.set_format='best_of_5' then 3 else 2 end required,
    row_number() over(partition by m.id order by s.set_index) position,
    count(*) over(partition by m.id) set_count,
    tennis_set_result(to_jsonb(s),tennis_set_rule(tennis_scoring_rules(t.scoring_config),s.set_index,case when t.set_format='best_of_5' then 3 else 2 end)) result
  from matches m join tournaments t on t.id=m.tournament_id join match_sets s on s.match_id=m.id
  where t.sport in ('tennis','padel')
), progress as (
  select *,coalesce(sum(case when result=1 then 1 else 0 end) over(partition by id order by set_index rows between unbounded preceding and 1 preceding),0) a_wins,
  coalesce(sum(case when result=2 then 1 else 0 end) over(partition by id order by set_index rows between unbounded preceding and 1 preceding),0) b_wins
  from classified
) select distinct tournament_id,id from progress where result=-1 or (result=0 and position<>set_count)
  or set_index<>position or set_count>2*required-1 or a_wins>=required or b_wins>=required;
