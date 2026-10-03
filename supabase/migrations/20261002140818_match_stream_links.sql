-- A YouTube broadcast per match. Organizers (every scoring role, like live
-- scoring) paste the link; the public page shows it on the match in every
-- format. The link is public with the match. Safe to re-run.

alter table public.matches add column if not exists stream_url text;

alter table public.matches drop constraint if exists matches_stream_url_ck;
alter table public.matches add constraint matches_stream_url_ck check (
  stream_url is null
  or (length(stream_url) <= 500 and stream_url ~ '^https://(((www|m)\.)?youtube\.com|youtu\.be)/[^\s]+$')
);

-- A stream link is not part of the result: changing only the link keeps the
-- revision, so an open score form does not turn stale. Any other update,
-- a no-op one included, still bumps it.
create or replace function bump_match_score_revision()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.stream_url is distinct from old.stream_url
     and (to_jsonb(new)-'stream_url'-'updated_at') = (to_jsonb(old)-'stream_url'-'updated_at') then
    return new;
  end if;
  new.score_revision:=old.score_revision+1;
  return new;
end;
$$;
revoke execute on function bump_match_score_revision() from public, anon, authenticated;

-- Sets or clears (empty text) the broadcast link of one match. Any match,
-- any tournament status: a link can be announced before the start and kept
-- as a recording after the final.
create or replace function public.set_match_stream(p_match_id uuid, p_url text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_tid uuid; v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select tournament_id into v_tid from matches where id=p_match_id;
  if v_tid is null or not can_live_score(v_tid) then raise exception 'Not allowed'; end if;
  if v_url is not null and (length(v_url) > 500 or v_url !~ '^https://(((www|m)\.)?youtube\.com|youtu\.be)/[^\s]+$') then
    raise exception 'stream.invalidUrl';
  end if;
  update matches set stream_url=v_url where id=p_match_id and stream_url is distinct from v_url;
  return jsonb_build_object('id', p_match_id, 'stream_url', v_url);
end;
$$;
revoke execute on function public.set_match_stream(uuid, text) from public, anon;
grant execute on function public.set_match_stream(uuid, text) to authenticated;
