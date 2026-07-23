# Multi-Sport Tournament Platform

## Overview

Web-application for organizing tournaments across multiple sports with live scoring and real-time updates. Each user owns the tournaments they create; a single super-admin exists at the platform level. No clubs/organizations/memberships.

- **Sports (v1):** `tennis`, `padel`, `football`.
  - Tennis & padel share the "sets" scoring family (games/sets/tiebreaks). Padel is always doubles.
  - Football uses the "goals" scoring family (single integer per side; draws allowed in round-robin/group stages; penalty shootout breaks knockout ties). A football entry is one team (category `singles`).
- **Tournament formats (v1):** `single_elimination`, `round_robin`, `groups_playoff`, `double_elimination`.
- **Create flow:** pick sport → pick format → configure (3-step wizard).

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
  views/
    HomeView.vue              # Landing / Google sign-in
    AdminLayout.vue           # Admin wrapper with nav
    AdminTournamentListView.vue
    AdminTournamentCreateView.vue  # 3-step create wizard
    AdminTournamentView.vue   # Main admin page (4 tabs: Entries, Bracket/Stage, Scores, Settings) - LARGEST FILE
    AdminSettingsView.vue     # User settings
    PublicTournamentView.vue  # Public tournament page (registration + bracket/standings/groups)
  App.vue                     # Root component
  main.js                     # App entry point
  styles.css                  # Global styles
supabase/
  schema.sql                  # CANONICAL DB schema (RLS, functions, triggers). Apply this whole file.
  migrations/, rollbacks/     # HISTORICAL (org-era). Superseded by schema.sql — do not use.
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

## Database (Supabase PostgreSQL)

### Key Tables

- **players** - global person records linked to auth.users (display_name, avatar_url, contact_hash)
- **platform_admins** - super-admin user_ids; `is_platform_admin()` checks membership
- **tournaments** - name, slug, **sport**, **format**, category (singles/doubles), status, `set_format` (nullable; sets sports only), is_public, doubles_pairing_mode, **format_config** jsonb (e.g. `group_count`, `advance_per_group`), **scoring_config** jsonb, `created_by` (owner)
- **tournament_admins** - roles: owner, editor, counter (`counter` can only run live scoring)
- **entries** - registrations with approval status (pending/approved/rejected), seed_order
- **entry_members** - individual member names (doubles = 2), optional `player_id`
- **groups**, **group_entries** - group-stage buckets (round_robin uses none; groups_playoff uses both)
- **matches** - canonical aggregate `side_a_score`/`side_b_score` (+ `side_a_pens`/`side_b_pens` for football knockout); `stage` (main/group/winners/losers/grand_final/third_place); `group_id`; winner tree via `next_match_id`/`next_slot`; loser routing via `loser_next_match_id`/`loser_next_slot` (double-elim); unique on `(tournament_id, stage, round_number, match_number)`
- **match_sets** - per-set game scores (tennis/padel only)
- **bracket_versions** - bracket snapshots for undo
- **live_scores** - real-time point-by-point scoring state (JSON state/history/revision)

### Key PL/pgSQL Functions

- `create_tournament()` - inserts tournament (forces padel→doubles, football→singles, nulls set_format for goals) + owner row; `register_entry()`
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
- `start_live_match()`, `record_point()`, `stop_live_match()` - live scoring lifecycle
- `add_tournament_admin_by_email()`, `remove_tournament_admin()` - co-organizer management
- `is_tournament_admin()`, `can_live_score()`, `is_platform_admin()` - access checks

### Security

- RLS enabled on all tables. `is_tournament_admin()` / `can_live_score()` for access.
- Public read for published tournaments; admin write for organizers.

### Realtime

Tables `tournaments`, `entries`, `matches`, `match_sets`, `tournament_admins`, `live_scores` are in `supabase_realtime` publication.

## Key Architecture Patterns

- **Canonical aggregate:** every sport in every format writes `matches.side_a_score`/`side_b_score` + `winner_entry_id`. Standings/propagation/badges read only this. Sport specifics (tennis sets, football penalties) live in satellites the aggregate consumers ignore.
- **Sport/format registries drive the UI:** `lib/sportConfig.js` (`getSportConfig`, `scoringFamily`) gates form fields and chooses which board/editor renders; `lib/scoringEngines.js` maps family → state/format helpers.
- **Bracket vs standings:** single/double-elim & group playoff render bracket boards (tree via `next_match_id`); round_robin & group stage render `StandingsTable` + fixtures.
- **Tournaments accessed by slug** (public sharing).

### v1 limitations (documented)
- Double-elim requires a power-of-two participant count; single grand final (no bracket reset).
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
- **Seeding UI** — manual seed order for RR/groups/brackets (seed_order exists, no UI).
- **Withdrawals / byes / re-open** after generation without full regen.
- **Scheduling** — dates/times/venue-court per match.
- **Undo/rebuild** across all formats — `bracket_versions` is single-elim oriented; extend snapshots to RR/groups/double-elim.

### Public & UX
- Penalty display in public RR/group fixtures (currently only knockout cards) — moot today (RR/group can't tie to penalties) but needed if rules change.
- Match detail pages, printable/exportable brackets, share images.
- Notifications (registration approved, match ready), player profiles/stats (player accounts were removed in the rebuild).
- i18n completeness pass for `lt` (some strings still English).

### Platform
- Super-admin dashboard (list all tournaments/users; `platform_admins` infra exists, no UI).
- Data migration tooling (schema is currently apply-from-scratch; no incremental migrations).

## Dev Setup

```bash
# Required: .env with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (+ VITE_SUPABASE_DB_PASSWORD for psql apply)
npm install
npm run dev      # http://localhost:5173
npm run build    # Production build to dist/
```

DB is applied by running `supabase/schema.sql` whole (Supabase SQL Editor, or psql via session pooler). The free-tier project auto-pauses — resume it in the dashboard if connections fail.

## General Rules

- Always answer, provide progress updates, and write implementation plans in Russian unless the user explicitly asks for another language.
- Project is plain JavaScript (`.js`/`.vue` with `<script setup>`). Match existing style. Run `npm run build` after changes.

## UI/Frontend Development

- When modifying UI components, never remove existing elements (selects, dropdowns, inputs) unless explicitly asked. Verify the rendered output preserves all original interactive elements after refactoring.
- Before multi-file UI changes, list interactive elements in affected components; confirm none removed unintentionally after.

## Database

- Before referencing DB columns/tables, read `supabase/schema.sql` to confirm they exist (it is canonical; ignore `migrations/`). Never assume column names.
- Verify RPC function signatures against the schema before calling.

## Conventions

- All components use Vue 3 `<script setup>` syntax
- State via Pinia (single `auth` store)
- DB logic in PL/pgSQL functions, called from frontend via `supabase.rpc()`
- i18n keys structured as `section.subsection.key` (e.g., `sport.football`, `tournamentFormat.round_robin`, `standings.points`)
- No CSS framework - styles in `styles.css` (global) + scoped `<style>` in newer components
