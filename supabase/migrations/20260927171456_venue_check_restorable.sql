-- The venue check again, written without BETWEEN. BETWEEN is stored as nested
-- ANDs, while the text pg_dump prints for it is parsed back as one flat AND:
-- a restored database got a different constraint definition than its source
-- (scripts/check-postgres.mjs, "restored catalog"). Explicit comparisons are
-- stored flat and survive dump/restore unchanged. Same rule, safe to re-run.

alter table public.tournaments drop constraint if exists tournaments_venue_point_ck;
alter table public.tournaments add constraint tournaments_venue_point_ck check (
  (venue_lat is null) = (venue_lng is null)
  and (venue_lat is null or (venue_lat >= -90 and venue_lat <= 90 and venue_lng >= -180 and venue_lng <= 180))
);
