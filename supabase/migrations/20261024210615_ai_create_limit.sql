-- "Quick with AI" asks the model again after the organizer answers its questions: one
-- tournament takes 1–3 `create` calls, so the daily limit for that task goes from 10 to 30.
-- Safe to re-run.

create or replace function ai_daily_limit(p_task text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_task
    when 'create' then 30
    when 'import' then 20
    when 'score' then 300
    when 'posts' then 30
    when 'voice' then 60
  end;
$$;

revoke execute on function ai_daily_limit(text) from public, anon;
grant execute on function ai_daily_limit(text) to authenticated;

notify pgrst, 'reload schema';
