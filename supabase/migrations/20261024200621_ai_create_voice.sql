-- =============================================
-- AI VOICE INPUT: its own switch and journal entries
-- =============================================
-- Organizers can dictate instead of typing (tournament description, later
-- scores). Speech becomes text in api/transcribe.js (Groq Whisper); the text
-- then goes through the usual AI task. Voice has its own switch `ai.voice`
-- (off until the super-admin turns it on), its own daily limit, and journal
-- rows with task 'voice', where tokens_in holds the seconds of audio.
-- A recording made inside a tournament (score entry) needs the right to enter
-- results there; one made in the create wizard has no tournament yet.
-- Safe to re-run.

insert into feature_flags (key, enabled, description) values
  ('ai.voice', false, 'AI: voice input (speech to text)')
on conflict (key) do nothing;

create or replace function is_ai_feature_enabled(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_feature in ('import', 'create', 'score', 'posts', 'voice'), false)
    and is_feature_enabled('ai')
    and is_feature_enabled('ai.' || p_feature);
$$;

alter table ai_usage drop constraint if exists ai_usage_task_check;
alter table ai_usage add constraint ai_usage_task_check
  check (task in ('import', 'create', 'score', 'posts', 'voice'));

create or replace function ai_daily_limit(p_task text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_task
    when 'create' then 10
    when 'import' then 20
    when 'score' then 300
    when 'posts' then 30
    when 'voice' then 60
  end;
$$;

create or replace function ai_begin_call(p_task text, p_tournament_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer := ai_daily_limit(p_task);
  v_used integer;
  v_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'ai.auth';
  end if;
  if v_limit is null then
    raise exception using errcode = '22023', message = 'ai.badTask';
  end if;
  if not is_ai_feature_enabled(p_task) then
    raise exception using errcode = '42501', message = 'ai.disabled';
  end if;
  if p_task = 'create' then
    if p_tournament_id is not null then
      raise exception using errcode = '22023', message = 'ai.badTask';
    end if;
  elsif p_task = 'voice' then
    if p_tournament_id is not null and not can_live_score(p_tournament_id) then
      raise exception using errcode = '42501', message = 'ai.forbidden';
    end if;
  elsif p_tournament_id is null
    or (p_task = 'score' and not can_live_score(p_tournament_id))
    or (p_task <> 'score' and not is_tournament_admin(p_tournament_id)) then
    raise exception using errcode = '42501', message = 'ai.forbidden';
  end if;

  if not is_platform_admin() then
    -- Two parallel calls must not both take the last slot.
    perform pg_advisory_xact_lock(hashtextextended('ai_usage:' || v_uid::text || ':' || p_task, 0));
    select count(*) into v_used
    from ai_usage
    where user_id = v_uid and task = p_task and created_at > now() - interval '24 hours';
    if v_used >= v_limit then
      raise exception using errcode = '54000', message = 'ai.limit';
    end if;
  end if;

  insert into ai_usage (user_id, task, tournament_id)
  values (v_uid, p_task, p_tournament_id)
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'remaining', case when is_platform_admin() then null else v_limit - coalesce(v_used, 0) - 1 end
  );
end;
$$;

revoke execute on function is_ai_feature_enabled(text) from public;
grant execute on function is_ai_feature_enabled(text) to anon, authenticated;
revoke execute on function ai_daily_limit(text) from public, anon;
grant execute on function ai_daily_limit(text) to authenticated;
revoke execute on function ai_begin_call(text, uuid) from public, anon;
grant execute on function ai_begin_call(text, uuid) to authenticated;

notify pgrst, 'reload schema';
