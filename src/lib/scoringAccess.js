import { sportConfig } from './sportConfig.js'

// Mirrors the RPC permissions: every scoring role (owner, editor, results-only
// `counter`) runs live scoring and saves or corrects final results; only
// managers (owner, editor) touch settings, entries, brackets and access.
export function scoringAccess(tournament, role) {
  const manager = role === 'owner' || role === 'editor'
  const scorer = manager || role === 'counter'
  const active = tournament?.status === 'in_progress'
  const live = Boolean(active && scorer && sportConfig[tournament?.sport]?.supportsLiveScoring)
  const final = Boolean(active && scorer && sportConfig[tournament?.sport])
  // Stopping a live match belongs to live scoring itself, counter included
  // (stop_live_match checks can_live_score).
  return { manager, live, final, scores: live || final, stopLive: live }
}

export function matchScoringAction(tournament, role, match) {
  if (!match?.side_a_entry_id || !match?.side_b_entry_id) return null
  const access = scoringAccess(tournament, role)
  if (access.live && match.status !== 'finished') return 'live'
  return access.final ? 'result' : null
}
