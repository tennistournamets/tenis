set role anon;
do $$ declare s jsonb; begin
  s := get_tournament_sync_state('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if jsonb_array_length(s->'entries') <> 2 or s::text like '%private-%' then raise exception 'Public privacy regression'; end if;
  if s->'live'->0->>'sides_auto' <> 'false' then raise exception 'Lost orientation'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false);
set role authenticated;
do $$ declare m matches; l live_scores; begin
  select * into m from matches where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  l := start_live_match(m.id,m.score_revision);
  l := record_point(m.id,'a',l.revision);
  if (l.state->'points'->>'a')::int <> 2 or not l.sides_swapped or l.sides_auto then raise exception 'Restored LIVE regression'; end if;
end $$;
reset role;
