# Multi-Sport Tournament Platform

## Overview

Web-application for organizing tournaments across multiple sports with live scoring and real-time updates. Each user owns the tournaments they create; a single super-admin exists at the platform level. No clubs/organizations/memberships.

- **Sports (v1):** `tennis`, `padel`, `football`.
  - Tennis & padel share the "sets" scoring family (games/sets/tiebreaks). Padel is always doubles.
  - Football uses the "goals" scoring family (single integer per side; draws allowed in round-robin/group stages; penalty shootout breaks knockout ties). A football entry is one team (category `singles`).
- **Tournament formats (v1):** `single_elimination`, `round_robin`, `groups_playoff`, `double_elimination`.
- **Create flow:** 6-step wizard — sport → format → details (name, slug, venue) → game rules → registration conditions → publication (visibility, QR).

## Tech Stack

- **Frontend:** Vue 3 (Composition API, `<script setup>`) + Vue Router 4 + Pinia 3 — plain **JavaScript** (no TypeScript)
- **Backend:** Supabase (PostgreSQL, Auth, Realtime)
- **Auth:** Google OAuth via Supabase (tournament owners); super-admin via `platform_admins`
- **i18n:** Vue I18n (ru/en/lt), default locale `ru`, stored in `localStorage` key `champ_locale`
- **Build:** Vite 7
- **Styling:** Custom vanilla CSS with design tokens (no Tailwind/SCSS), dark theme support

## Project Structure

```
src/
  components/
    BracketBoard.vue          # Single-elim bracket visualization (tree via next_match_id)
    BracketMatchCard.vue      # Individual match card (shows sets OR goals+penalties)
    InfiniteCanvas.vue        # Zoom/pan canvas for bracket rendering
    SportPicker.vue           # Create wizard step 1 (sport cards)
    FormatPicker.vue          # Create wizard step 2 (format cards)
    StandingsTable.vue        # Round-robin / group standings table
    GroupStageBoard.vue       # Per-group standings + fixtures (groups_playoff)
    DoubleElimBoard.vue       # Winners + losers + grand-final sections
    FootballScoreEditor.vue   # Goals + penalty result entry (goals sports)
    ScoreEditor.vue           # Final set score editing (sets sports)
    LiveScoreViewerModal.vue  # Read-only live score display (spectator)
    LiveScoringModal.vue      # Point-by-point tennis scoring input (admin)
    RegistrationForm.vue      # Public registration form (sport-aware labels)
    LanguageSwitcher.vue      # RU/EN/LT locale selector
  i18n/
    index.js                  # Vue I18n config
    messages.js               # All translation strings (ru/en/lt)
  lib/
    supabase.js               # Supabase client init
    sportConfig.js            # Registry: sport -> capabilities (scoringFamily, forcedCategory, supports*)
    scoringEngines.js         # Registry: family (sets|goals) -> state/format helpers
    useTennisScoring.js       # Tennis scoring composable (sets family; reused by padel)
    entryDisplay.js           # Entry/member name display helper
    shareLink.js              # Tournament link generation
    headerTitle.js            # Public header title ref
  router/
    index.js                  # Route definitions + auth guard
  stores/
    auth.js                   # Pinia auth store (user, session, currentPlayer, platformRole, tournamentRoles)
    featureFlags.js           # Pinia feature-flags store (flags map, enabledSports, setFlag via RPC, realtime)
  views/
    HomeView.vue              # Landing / Google sign-in
    AdminLayout.vue           # Admin wrapper with nav
    AdminTournamentListView.vue
    AdminTournamentCreateView.vue  # 6-step create wizard (draft kept in sessionStorage)
    AdminTournamentView.vue   # Main admin page (6 tabs: Entries, Bracket/Stage, Courts, Schedule, Scores, Settings) - LARGEST FILE
    AdminSettingsView.vue     # User settings
    AdminPlatformView.vue     # Super-admin only: feature flags (sport toggles)
    PublicTournamentView.vue  # Public tournament page (registration + bracket/standings/groups)
  App.vue                     # Root component
  main.js                     # App entry point
  styles.css                  # Global styles
supabase/
  schema.sql                  # CANONICAL DB state (tables, RLS, functions, triggers). Reference + test oracle; NOT an install/upgrade procedure.
  migrations/                 # ACTIVE: baseline for a new DB + forward migrations (order and SHA-256 in database-release.json)
  database-release.json       # Release manifest: baseline, historical upgrade chain, forwardMigrations
  upgrades/                   # Historical upgrade chain (steps 1–8), applied only in manifest order
  archive/organizations/      # Org-era migrations — incompatible, never apply
  checks/                     # Read-only verification SQL for a live DB
```

## Routes

| Path | View | Auth |
|------|------|------|
| `/` | HomeView | No (redirects to `/admin/tournaments` if logged in) |
| `/tournaments/:slug` | PublicTournamentView | No |
| `/admin/tournaments` | AdminTournamentListView | Yes |
| `/admin/tournaments/new` | AdminTournamentCreateView | Yes |
| `/admin/tournaments/:id` | AdminTournamentView | Yes |
| `/admin/settings` | AdminSettingsView | Yes |
| `/admin/platform` | AdminPlatformView | Yes + `platform_admins` row (else redirect to list) |

## Database (Supabase PostgreSQL)

### Key Tables

- **players** - global person records linked to auth.users (display_name, avatar_url, contact_hash)
- **platform_admins** - super-admin user_ids; `is_platform_admin()` checks membership
- **feature_flags** - platform-wide toggles (`key` PK, `enabled`, `description`, `updated_at/by`). Sports are gated by `sport.<enum>` keys; missing key = disabled. Seeded: tennis/padel on, football off (`on conflict do nothing`). Public read; write only super-admin.
- **tournaments** - name, slug, **sport**, **format**, category (singles/doubles), status, `set_format` (nullable; sets sports only), `visibility` (public/link/private/password; `is_public` is derived from it by trigger and stays the RLS gate), doubles_pairing_mode, **format_config** jsonb, **scoring_config** jsonb, `created_by` (owner), `settings_revision` (CAS for settings writes), contacts + `publish_contact`, registration rules (`registration_capacity`, `capacity_public`, `registration_deadline`, `entry_fee_mode/minor/currency/unit`, `waitlist_enabled`), `schedule_config` jsonb + `schedule_published_at`, `access_password_hash`/`access_password_version` (never granted to API roles)
- **tournament_admins** - roles: owner, editor, counter (`counter` = "results only": live scoring plus final results/corrections/stop; no management). Writes only via RPC; ownership is granted/removed by owners only; the last owner is protected.
- **tournament_admin_events** - journal of ownership transfers (admins read, nobody writes directly)
- **entries** - registrations with approval status (pending/approved/rejected/waitlisted), seed_order. Capacity is enforced by triggers when an entry becomes approved (approved entries occupy seats; pick_random doubles count people).
- **courts**, **match_schedule** - manual schedule: per-match court and/or time (`fixed` or `not_before`) or court queue; rows exist in `draft` or `published` state, the public sees published only
- **tournament_access_grants**, **tournament_unlock_attempts** - hashed 12-hour tokens for password pages and lockout counters; no API access
- **entry_members** - individual member names (doubles = 2), optional `player_id`
- **groups**, **group_entries** - group-stage buckets (round_robin uses none; groups_playoff uses both)
- **matches** - canonical aggregate `side_a_score`/`side_b_score` (+ `side_a_pens`/`side_b_pens` for football knockout); `stage` (main/group/winners/losers/grand_final/third_place); `group_id`; winner tree via `next_match_id`/`next_slot`; loser routing via `loser_next_match_id`/`loser_next_slot` (double-elim); unique on `(tournament_id, stage, round_number, match_number)`
- **match_sets** - per-set game scores (tennis/padel only)
- **bracket_versions** - bracket snapshots for undo
- **live_scores** - real-time point-by-point scoring state (JSON state/history/revision)

### Key PL/pgSQL Functions

- `create_tournament()` - inserts tournament (forces padel→doubles, football→singles, nulls set_format for goals) + owner row; `register_entry(..., p_access_token)` returns `{id, status}` (pending or waitlisted) and enforces deadline, capacity and waitlist
- `tournament_registration_state()`, `approve_pending_entries()` - registration rules; `update_tournament_settings(p_patch, p_expected_revision)` - whitelisted settings write with CAS
- Schedule: `save_courts()`, `check_match_schedule()`, `set_match_schedule()`, `clear_match_schedule()`, `schedule_draft_conflicts()`, `publish_schedule()`, `revert_schedule_draft()`
- Access: `add_tournament_admin_by_email()`/`remove_tournament_admin()` (owner rules), `transfer_tournament_ownership()`, `set_tournament_password()`, `tournament_access_mode()`, `unlock_tournament()` (returns `{ok, ...}`), `get_tournament_sync_state_with_token()`
- `get_tournament_sync_state()` - one RLS-respecting snapshot for public and admin pages (tournament, registration state, entries, matches, sets, live, groups, courts, schedule, standings)
- `generate_bracket()` / `rebuild_bracket()` - single-elimination; **dispatches to `generate_double_elim()`** when format is double_elimination
- `generate_single_elim(seeds, stage)` - seed-array tree builder (reused by group playoff)
- `generate_round_robin()` / `generate_round_robin_matches()` - circle-method all-play-all
- `generate_groups(count)` - snake-distribute into groups + per-group round-robin
- `generate_group_playoff()` - cross-group seeding → knockout (stage `winners`)
- `generate_double_elim(seeds)` - winners+losers brackets + grand final (v1: power-of-two, single grand final)
- `get_standings(tournament_id, group_id)` - computed standings (points→head-to-head→diff→score_for→name)
- `update_match_sets()` - tennis/padel scoring; writes aggregate + propagates winner
- `update_football_result(a_goals, b_goals, a_pens, b_pens)` - football scoring (draws/penalties) + propagate
- `propagate_winner()` - advances winner via `next_match_id`; routes loser via `loser_next_match_id` (double-elim)
- `swap_bracket_slots()`, `apply_bracket_layout()` - manual single-elim arrangement
- `form_random_pairs()`, `form_manual_pairs()`, `split_pairs()` - doubles pairing
- `set_entry_seed_order(tournament_id, entry_ids[])` - manual seeding of the approved field before the draw (feeds manual draw and group snake); snapshot entries carry `seed_order`
- `start_live_match()`, `record_point()`, `stop_live_match()` - live scoring lifecycle
- `add_tournament_admin_by_email()`, `remove_tournament_admin()` - co-organizer management
- `is_tournament_admin()`, `can_live_score()`, `is_platform_admin()` - access checks
- `is_feature_enabled(key)` / `set_feature_flag(key, enabled, description)` - feature flags; `create_tournament()` rejects a sport whose `sport.<x>` flag is off

### Security

- RLS enabled on all tables. `is_tournament_admin()` / `can_live_score()` for access.
- Public read for published tournaments; admin write for organizers.

### Realtime

Tables `tournaments`, `entries`, `matches`, `match_sets`, `tournament_admins`, `live_scores`, `groups`, `group_entries`, `courts`, `match_schedule`, `feature_flags` are in the `supabase_realtime` publication. Payloads are only invalidation signals: the client re-reads the full snapshot (`src/lib/tournamentSync.js`). Password pages have no Realtime (RLS hides their rows); they poll every 30 s.

## Key Architecture Patterns

- **Canonical aggregate:** every sport in every format writes `matches.side_a_score`/`side_b_score` + `winner_entry_id`. Standings/propagation/badges read only this. Sport specifics (tennis sets, football penalties) live in satellites the aggregate consumers ignore.
- **Sport/format registries drive the UI:** `lib/sportConfig.js` (`getSportConfig`, `scoringFamily`) gates form fields and chooses which board/editor renders; `lib/scoringEngines.js` maps family → state/format helpers.
- **Feature flags gate sports:** `SPORTS` in `sportConfig.js` is the full registry; `SportPicker` renders only `featureFlags.enabledSports`. Adding a sport = enum + `sportConfig` + i18n + flip its `sport.<x>` flag in `/admin/platform` (or seed row in schema.sql).
- **Bracket vs standings:** single/double-elim & group playoff render bracket boards (tree via `next_match_id`); round_robin & group stage render `StandingsTable` + fixtures.
- **Tournaments accessed by slug** (public sharing).

### v1 limitations (documented)
- Double-elim requires a power-of-two participant count; single grand final (no bracket reset).
- Schedule conflicts: without match durations a court/participant clash is detected only for identical fixed start times; minimum rest is a warning between start times. No automatic scheduling.
- Group playoff seeding tuned for `advance_per_group = 2`.
- Standings head-to-head handles pairwise/group ties; circular ties fall through to goal difference.
- Football live scoring not implemented (final result entry only).
- Manual slot editing only for single-elim.

## Roadmap / Missing Features

Planned/known gaps, roughly by priority. Not implemented yet.

### Formats & brackets
- **Double-elim: non-power-of-two** participant counts (bye handling in WB→LB routing).
- **Double-elim: bracket reset** — true grand final where LB champion must beat WB champion twice (`format_config.double_gf_reset` flag exists, unused).
- **Losers-bracket anti-rematch seeding** — current drop mapping is structural; doesn't optimize to delay rematches.
- **Third-place match** — for single-elim and group playoff (`format_config.third_place_match`, `stage='third_place'` reserved, not wired).
- **Group playoff**: seeding for `advance_per_group > 2`, best-third-place qualification, configurable knockout size.
- **Manual slot editing** for double-elim / round-robin (currently single-elim only).

### Scoring
- **Football live scoring** — real-time ± goal counter (currently final-result entry only). Generalize `record_point` to `goals` family (`football_apply_goal` planned).
- **Standings tiebreaks** — full head-to-head mini-table for 3+ way circular ties; configurable tiebreak order via `scoring_config`; cards/fair-play, walkover/forfeit results.
- **New sports** — basketball, volleyball, table tennis, badminton: add to `sport` enum + `sportConfig`/`scoringEngines` (+ a scoring engine per family). Consider a "sets to N points" generic engine.

### Tournament management
- **Seeding UI** — drag-and-drop reordering (today: move up/down in the entry row menu via `set_entry_seed_order`).
- **Withdrawals / byes / re-open** after generation without full regen.
- **Scheduling** — dates/times/venue-court per match.
- **Undo/rebuild** across all formats — `bracket_versions` is single-elim oriented; extend snapshots to RR/groups/double-elim.

### Public & UX
- Penalty display in public RR/group fixtures (currently only knockout cards) — moot today (RR/group can't tie to penalties) but needed if rules change.
- Match detail pages, printable/exportable brackets, share images.
- Notifications (registration approved, match ready), player profiles/stats (player accounts were removed in the rebuild).
- i18n completeness pass for `lt` (some strings still English).

### Platform
- Super-admin dashboard (list all tournaments/users). Feature-flag toggles exist at `/admin/platform`; tournament/user listing does not.
- Adoption of the migration baseline by the existing TENIS project (see `docs/RELEASE.md`); until then new forward migrations are applied to TENIS one by one.

## Dev Setup

```bash
# Required: .env with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (+ SUPABASE_DB_PASSWORD for psql apply)
npm install
npm run dev      # http://localhost:5173
npm run build    # Production build to dist/
```

DB changes follow `docs/RELEASE.md`: create a migration with `npx supabase migration new <name>` (redirect stdin from `/dev/null` in scripts, the CLI reads it), append the same SQL to `supabase/schema.sql` (canonical state), register the file with its SHA-256 in `supabase/database-release.json` (`forwardMigrations`), and keep `npm run test:sql` green in the `schema`, `fresh` and `upgrade` modes (`TENIS_TEST_INSTALL_MODE`). Every forward migration must be replayable (tests re-apply the whole chain). Never re-apply `schema.sql` to a working database. The free-tier project auto-pauses — resume it in the dashboard if connections fail.

## General Rules

- Always answer, provide progress updates, and write implementation plans in Russian unless the user explicitly asks for another language.
- Project is plain JavaScript (`.js`/`.vue` with `<script setup>`). Match existing style. Run `npm run build` after changes.

## UI/Frontend Development

- When modifying UI components, never remove existing elements (selects, dropdowns, inputs) unless explicitly asked. Verify the rendered output preserves all original interactive elements after refactoring.
- Before multi-file UI changes, list interactive elements in affected components; confirm none removed unintentionally after.

## Database

- Before referencing DB columns/tables, read `supabase/schema.sql` to confirm they exist (it is the canonical state). Never assume column names. New DB changes go into a new file in `supabase/migrations/` plus `schema.sql` plus the manifest — never edit the released baseline or `upgrades/`.
- Verify RPC function signatures against the schema before calling.

## Conventions

- All components use Vue 3 `<script setup>` syntax
- State via Pinia (`auth` + `featureFlags` stores)
- DB logic in PL/pgSQL functions, called from frontend via `supabase.rpc()`
- i18n keys structured as `section.subsection.key` (e.g., `sport.football`, `tournamentFormat.round_robin`, `standings.points`)
- No CSS framework - styles in `styles.css` (global) + scoped `<style>` in newer components
