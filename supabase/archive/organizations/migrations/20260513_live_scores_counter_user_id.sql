-- Keep live scoring compatible with existing remote live_scores tables that require counter_user_id.

alter table live_scores
  add column if not exists counter_user_id uuid references auth.users (id) on delete set null;

create or replace function start_live_match(p_match_id uuid)
returns live_scores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match matches%rowtype;
  v_set_format set_format;
  v_tournament_status tournament_status;
  v_required_sets integer;
  v_live live_scores%rowtype;
begin
  select *
    into v_match
  from matches
  where id = p_match_id;

  if v_match.id is null then
    raise exception 'Match not found';
  end if;

  select t.set_format, t.status
    into v_set_format, v_tournament_status
  from tournaments t
  where t.id = v_match.tournament_id;

  if not can_live_score(v_match.tournament_id) then
    raise exception 'Not allowed';
  end if;

  if v_tournament_status <> 'in_progress'::tournament_status then
    raise exception 'Live scoring can start only after the tournament starts';
  end if;

  if v_match.side_a_entry_id is null or v_match.side_b_entry_id is null then
    raise exception 'Both sides must be assigned before scoring';
  end if;

  if v_match.status = 'finished'::match_status then
    raise exception 'Match already finished';
  end if;

  v_required_sets := case when v_set_format = 'best_of_5' then 3 else 2 end;

  select * into v_live
  from live_scores
  where match_id = p_match_id;

  if v_live.id is null then
    insert into live_scores (match_id, tournament_id, counter_user_id, status, state)
    values (p_match_id, v_match.tournament_id, auth.uid(), 'active', live_score_initial_state(v_required_sets))
    returning * into v_live;
  elsif v_live.status <> 'finished' then
    update live_scores
    set status = 'active',
        counter_user_id = coalesce(counter_user_id, auth.uid())
    where id = v_live.id
    returning * into v_live;
  end if;

  return v_live;
end;
$$;

grant execute on function start_live_match(uuid) to authenticated;
