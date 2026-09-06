-- Repair derived totals only when validated sets and the saved LIVE agree.
-- Does not change sets, live state, status, winner or bracket participants.
-- Run as database owner. Repeatable: an already correct match is untouched.
do $$
declare m record; totals record; v_rules jsonb; v_required integer; expected uuid;
begin
  for m in select matches.* from matches join tournaments t on t.id=matches.tournament_id
    where t.sport in('tennis','padel') and exists(select 1 from live_scores where match_id=matches.id)
    order by matches.id for update of matches
  loop
    select tennis_scoring_rules(scoring_config),case when set_format='best_of_5' then 3 else 2 end
      into v_rules,v_required from tournaments where id=m.tournament_id;
    with results as (
      select set_index,tennis_set_result(to_jsonb(s),tennis_set_rule(v_rules,set_index,v_required)) result
      from match_sets s where match_id=m.id
    )
    select count(*)filter(where result=1)::int a,count(*)filter(where result=2)::int b,
      count(*)filter(where result=-1)::int invalid,count(*) n,max(set_index) last,
      count(*)filter(where result=0)::int partial,min(set_index)filter(where result=0) partial_index
      into totals from results;
    if totals.n=0 or totals.invalid<>0 or totals.last<>totals.n or totals.last>v_required*2-1
      or totals.partial>1 or (totals.partial=1 and totals.partial_index<>totals.last)
      or greatest(totals.a,totals.b)>v_required then continue; end if;
    expected:=case when totals.a=v_required then m.side_a_entry_id when totals.b=v_required then m.side_b_entry_id end;
    -- A winner must occur at the last set, with no partial set after it.
    if expected is not null and (totals.partial<>0 or not exists(
      select 1 from match_sets s where match_id=m.id and set_index=totals.last
      and tennis_set_result(to_jsonb(s),tennis_set_rule(v_rules,set_index,v_required))=case when totals.a=v_required then 1 else 2 end
    )) then continue; end if;
    if m.winner_entry_id is distinct from expected or (m.status='finished')<>(expected is not null) then continue; end if;
    if not exists(select 1 from live_scores l where l.match_id=m.id
      and l.state->'setsWon'=jsonb_build_object('a',totals.a,'b',totals.b)
      and nullif(l.state->>'winner','') is not distinct from case when expected=m.side_a_entry_id then 'a' when expected=m.side_b_entry_id then 'b' end
    ) then continue; end if;
    if m.side_a_score is distinct from totals.a or m.side_b_score is distinct from totals.b then
      update matches set side_a_score=totals.a,side_b_score=totals.b where id=m.id;
    end if;
  end loop;
end;
$$;
