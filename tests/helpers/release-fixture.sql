-- Synthetic old-schema data for upgrade/restore, deliberately contains private contact data.
insert into auth.users(id,email) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','owner@example.test');
insert into tournaments(id,name,slug,sport,format,category,set_format,status,is_public,created_by)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Restore fixture','restore-fixture','tennis','round_robin','singles','best_of_3','in_progress',true,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
insert into tournament_admins(tournament_id,user_id,role) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','owner');
insert into entries(id,tournament_id,entry_type,display_name,phone_or_email,status) values
('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','singles','Player A','private-a@example.test','approved'),
('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','singles','Player B','private-b@example.test','approved'),
('33333333-3333-4333-8333-333333333333','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','singles','Pending','private-pending@example.test','pending');
insert into entry_members(entry_id,member_name,member_order) select id,display_name,1 from entries;
insert into matches(id,tournament_id,round_number,match_number,side_a_entry_id,side_b_entry_id,winner_entry_id,side_a_score,side_b_score,status)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',2,0,'finished');
insert into match_sets(match_id,set_index,side_a_games,side_b_games) values
('cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,6,0),('cccccccc-cccc-4ccc-8ccc-cccccccccccc',2,6,0);
insert into matches(id,tournament_id,round_number,match_number,side_a_entry_id,side_b_entry_id,status)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',2,1,'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','ready');
insert into live_scores(match_id,tournament_id,counter_user_id,status,state,history,revision,sides_swapped,sides_auto)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','stopped',
'{"points":{"a":1,"b":0},"games":{"a":0,"b":0},"sets":[],"setsWon":{"a":0,"b":0},"currentSet":1,"requiredSets":2,"winner":null}', '[]',1,true,false);
