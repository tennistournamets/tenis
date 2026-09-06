-- Read-only after validate_match_set_results. Expect four passed=true rows.
with expected(signature, definition_md5) as (
  values
    ('public.update_match_sets(uuid,jsonb)', 'dcf4da803f89f5f16d42ba73e836948f'),
    ('public.update_football_result(uuid,integer,integer,integer,integer)', '33e084e899ccb84cfb844ae40b95a83a'),
    ('public.start_live_match(uuid)', '239f87820ac47d4e7e84473582c4bd28'),
    ('public.record_point(uuid,text,integer)', '0cb0476150da45dae5f5cd5cb477d4af')
)
select e.signature, pg_get_userbyid(p.proowner) as owner,
       md5(pg_get_functiondef(p.oid)) as definition_md5,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       coalesce(p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
         and md5(pg_get_functiondef(p.oid)) = e.definition_md5
         and has_function_privilege('authenticated', p.oid, 'EXECUTE'), false) as passed
from expected e
left join pg_proc p on p.oid = to_regprocedure(e.signature)
order by e.signature;

-- Diagnose existing set sequences without rewriting results. No rows expected.
-- Aggregate discrepancies caused by the old live writer belong to step 5.
with set_rows as (
  select m.id as match_id, m.tournament_id, t.sport, s.set_index,
         s.side_a_games as a, s.side_b_games as b,
         case when t.set_format = 'best_of_5' then 3 else 2 end as required,
         row_number() over (partition by m.id order by s.set_index) as position,
         count(*) over (partition by m.id) as set_count,
         ((greatest(s.side_a_games,s.side_b_games) = 6 and least(s.side_a_games,s.side_b_games) <= 4)
           or (greatest(s.side_a_games,s.side_b_games) = 7 and least(s.side_a_games,s.side_b_games) in (5,6))) as complete
  from public.matches m
  join public.tournaments t on t.id = m.tournament_id
  join public.match_sets s on s.match_id = m.id
), progress as (
  select *,
    coalesce(sum(case when complete and a>b then 1 else 0 end) over (
      partition by match_id order by set_index rows between unbounded preceding and 1 preceding),0) as previous_a_wins,
    coalesce(sum(case when complete and b>a then 1 else 0 end) over (
      partition by match_id order by set_index rows between unbounded preceding and 1 preceding),0) as previous_b_wins
  from set_rows
)
select tournament_id, match_id
from progress
where sport not in ('tennis','padel')
   or set_index <> position or set_count > 2*required-1
   or previous_a_wins >= required or previous_b_wins >= required
   or a not between 0 and 7 or b not between 0 and 7
   or (not complete and (set_index <> set_count
     or not (greatest(a,b) <= 5 or (greatest(a,b) = 6 and least(a,b) in (5,6)))))
group by tournament_id, match_id
order by tournament_id, match_id;
