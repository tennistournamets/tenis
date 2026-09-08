import { sportConfig } from './sportConfig.js'

// Mirrors the existing RPC permissions: counters operate live scoring;
// only tournament managers can submit/correct a final result.
export function scoringAccess(tournament, role) {
  const manager = role === 'owner' || role === 'editor'
  const active = tournament?.status === 'in_progress'
  const live = Boolean(active && (manager || role === 'counter') && sportConfig[tournament?.sport]?.supportsLiveScoring)
  const final = Boolean(active && manager && sportConfig[tournament?.sport])
  return { manager, live, final, scores: live || final }
}

export function matchScoringAction(tournament, role, match) {
  if (!match?.side_a_entry_id || !match?.side_b_entry_id) return null
  const access = scoringAccess(tournament, role)
  if (access.live && match.status !== 'finished') return 'live'
  return access.final ? 'result' : null
}
