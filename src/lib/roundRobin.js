import { entryMemberNames } from './entryDisplay'

function pairKey(idA, idB) {
  return [idA, idB].sort().join('|')
}

// Prefer display_name so labels match the standings table (get_standings output).
export function entryLabelFor(entriesMap, entryId) {
  if (!entryId) return ''
  const entry = entriesMap[entryId]
  if (!entry) return ''
  const displayName = (entry.display_name || '').trim()
  if (displayName) return displayName
  return entryMemberNames(entry).join(' / ')
}

/**
 * Shared round-robin view model for the crosstable and the per-player accordion.
 * Participants come from the matches themselves (handles byes/withdrawals),
 * ordered by standings rank when available so rows match the standings table.
 */
export function buildRoundRobinModel(matches, entriesMap, standings = []) {
  const ids = new Set()
  const byPair = {}
  const byEntry = {}

  for (const m of matches) {
    if (m.side_a_entry_id) ids.add(m.side_a_entry_id)
    if (m.side_b_entry_id) ids.add(m.side_b_entry_id)
    if (m.side_a_entry_id && m.side_b_entry_id) {
      const key = pairKey(m.side_a_entry_id, m.side_b_entry_id)
      ;(byPair[key] ??= []).push(m)
      ;(byEntry[m.side_a_entry_id] ??= []).push(m)
      ;(byEntry[m.side_b_entry_id] ??= []).push(m)
    }
  }

  for (const list of Object.values(byPair)) {
    list.sort((a, b) => a.round_number - b.round_number || a.match_number - b.match_number)
  }
  for (const list of Object.values(byEntry)) {
    list.sort((a, b) => a.round_number - b.round_number || a.match_number - b.match_number)
  }

  const rankById = {}
  standings.forEach((row, i) => {
    rankById[row.entry_id] = row.rank ?? i + 1
  })

  const participants = [...ids].sort((a, b) => {
    const ra = rankById[a]
    const rb = rankById[b]
    if (ra != null && rb != null) return ra - rb
    if (ra != null) return -1
    if (rb != null) return 1
    return entryLabelFor(entriesMap, a).localeCompare(entryLabelFor(entriesMap, b))
  })

  return { participants, byPair, byEntry }
}

export function pairMatches(model, idA, idB) {
  return model.byPair[pairKey(idA, idB)] || []
}

/** Score oriented so `rowEntryId` is always the first side. */
export function orientScore(match, rowEntryId) {
  const flip = match.side_b_entry_id === rowEntryId
  const finished = match.status === 'finished'
  return {
    finished,
    a: flip ? match.side_b_score : match.side_a_score,
    b: flip ? match.side_a_score : match.side_b_score,
    pa: flip ? match.side_b_pens : match.side_a_pens,
    pb: flip ? match.side_a_pens : match.side_b_pens,
    won: finished && match.winner_entry_id === rowEntryId,
  }
}

/** Match to open on click: first unfinished, else the last one. */
export function clickTarget(list) {
  if (!list.length) return null
  return list.find((m) => m.status !== 'finished') || list[list.length - 1]
}
