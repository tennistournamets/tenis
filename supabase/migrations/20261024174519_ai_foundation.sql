-- =============================================
-- AI FEATURES: switches, call journal and daily limits
-- =============================================
-- AI runs in the Vercel function api/ai.js (DeepSeek, server-side key). The
-- function calls ai_begin_call() with the organizer's own token before asking
-- the model and ai_finish_call() after it, so every check below runs as that
-- user. Switches: the super-admin turns all AI on/off with `ai` and each
-- feature with `ai.<feature>`; a feature works only while both are on. All
-- switches start off. The journal keeps no request or answer text.
-- Safe to re-run.

insert into feature_flags (key, enabled, description) values
  ('ai', false, 'AI features: master switch'),
  ('ai.import', false, 'AI: participant list import'),
  ('ai.create', false, 'AI: tournament from text'),
  ('ai.score', false, 'AI: score entry by voice or text'),
  ('ai.posts', false, 'AI: social media posts')
on conflict (key) do nothing;

create or replace function is_ai_feature_enabled(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_feature in ('import', 'create', 'score', 'posts'), false)
    and is_feature_enabled('ai')
    and is_feature_enabled('ai.' || p_feature);
$$;

revoke execute on function is_ai_feature_enabled(text) from public;
grant execute on function is_ai_feature_enabled(text) to anon, authenticated;

create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  task text not null check (task in ('import', 'create', 'score', 'posts')),
  tournament_id uuid references tournaments (id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  tokens_in integer check (tokens_in is null or tokens_in >= 0),
  tokens_out integer check (tokens_out is null or tokens_out >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 64)
);

create index if not exists ai_usage_user_task_created_idx on ai_usage (user_id, task, created_at desc);
create index if not exists ai_usage_created_idx on ai_usage (created_at desc);

alter table ai_usage enable row level security;

revoke all on table ai_usage from public, anon, authenticated;
grant select on table ai_usage to authenticated;

drop policy if exists ai_usage_select on ai_usage;
create policy ai_usage_select on ai_usage
  for select to authenticated
  using (is_platform_admin());

-- Calls per user and feature in the last 24 hours. Platform admins have no limit.
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
  end;
$$;

-- Checks the switches, the caller's rights and the limit, then opens a journal row.
-- Errors are codes the client translates: ai.auth, ai.badTask, ai.disabled, ai.forbidden, ai.limit.
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

-- Closes the caller's own open journal row with the result and token counts.
create or replace function ai_finish_call(
  p_id uuid,
  p_ok boolean,
  p_tokens_in integer default null,
  p_tokens_out integer default null,
  p_error_code text default null
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update ai_usage
  set finished_at = now(),
      ok = coalesce(p_ok, false),
      tokens_in = greatest(p_tokens_in, 0),
      tokens_out = greatest(p_tokens_out, 0),
      error_code = left(nullif(btrim(coalesce(p_error_code, '')), ''), 64)
  where id = p_id and user_id = auth.uid() and finished_at is null;
$$;

-- Platform admin: calls, failures, users and tokens per feature over the last p_days days.
create or replace function ai_usage_summary(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 7), 1), 90);
begin
  if not is_platform_admin() then
    raise exception using errcode = '42501', message = 'Platform admin required';
  end if;
  return jsonb_build_object(
    'days', v_days,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'task', task,
        'calls', calls,
        'failed', failed,
        'users', users,
        'tokens_in', tokens_in,
        'tokens_out', tokens_out
      ) order by task)
      from (
        select task,
               count(*) calls,
               count(*) filter (where ok is distinct from true) failed,
               count(distinct user_id) users,
               coalesce(sum(tokens_in), 0) tokens_in,
               coalesce(sum(tokens_out), 0) tokens_out
        from ai_usage
        where created_at > now() - make_interval(days => v_days)
        group by task
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function ai_daily_limit(text) from public, anon;
revoke execute on function ai_begin_call(text, uuid) from public, anon;
revoke execute on function ai_finish_call(uuid, boolean, integer, integer, text) from public, anon;
revoke execute on function ai_usage_summary(integer) from public, anon;
grant execute on function ai_daily_limit(text) to authenticated;
grant execute on function ai_begin_call(text, uuid) to authenticated;
grant execute on function ai_finish_call(uuid, boolean, integer, integer, text) to authenticated;
grant execute on function ai_usage_summary(integer) to authenticated;

notify pgrst, 'reload schema';
