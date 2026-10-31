-- =============================================
-- RATING CHANGES REACH OPEN ADMIN PAGES
-- =============================================
-- entry_member_ratings is closed to API roles, so Realtime cannot deliver its
-- rows to anyone. A change of a rating (the player's at registration, or an
-- organizer's value set in another tab) now touches its entry's updated_at:
-- entries is in the supabase_realtime publication, so every open page gets the
-- usual "something changed" signal, and organizer pages re-read the ratings
-- through get_entry_ratings(). No rating value travels in the event. Touching
-- updated_at fires only trg_entries_updated_at (no capacity, contact or email
-- trigger watches that column). Safe to re-run.

create or replace function public.entry_member_ratings_touch_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update entries set updated_at = now()
  where id = (select em.entry_id from entry_members em where em.id = coalesce(new.member_id, old.member_id));
  return null;
end;
$$;
revoke execute on function public.entry_member_ratings_touch_entry() from public, anon, authenticated;

drop trigger if exists trg_entry_member_ratings_touch on public.entry_member_ratings;
create trigger trg_entry_member_ratings_touch
after insert or update or delete on public.entry_member_ratings
for each row execute function public.entry_member_ratings_touch_entry();
