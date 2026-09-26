export function isByeMatch(match) {
  const a = match.side_a_entry_id
  const b = match.side_b_entry_id
  return match.status === 'finished'
    && Boolean(a) !== Boolean(b)
    && match.winner_entry_id === (a || b)
}

/**
 * Stored sets that are complete. A finished match: all of them. An unfinished
 * one (live stopped mid-set) counts its sets won in the aggregate, so a partial
 * 1:0 is the current set, not a set won 1:0.
 */
export function completedSetCount(match) {
  if (match?.status === 'finished') return Infinity
  return (Number(match?.side_a_score) || 0) + (Number(match?.side_b_score) || 0)
}

/** A match another match feeds (a semifinal, a lower-bracket round) fills itself from results. */
export function isFedMatch(matches, matchId) {
  return matches.some(m => m.next_match_id === matchId || m.loser_next_match_id === matchId)
}

const SIDE_KEYS = { a: 'side_a_entry_id', b: 'side_b_entry_id' }
const nextSlotKey = match => (match.next_slot === 'B' ? 'side_b_entry_id' : 'side_a_entry_id')
const pairStatus = m => (m.side_a_entry_id && m.side_b_entry_id ? 'ready' : 'pending')

/**
 * Swaps two slots of a local bracket draft in place, with the rules the server
 * applies on save (apply_bracket_layout): first-round slots only (no match
 * feeds them) and no match left without a player. A match left with one player
 * is a BYE; its free pass shows in the next match like after a draw.
 * Returns 'ok', 'locked' (a fed match), 'empty' (a match would be emptied) or 'noop'.
 */
export function swapDraftSlots(matches, { fromMatchId, fromSide, toMatchId, toSide }) {
  const from = matches.find(m => m.id === fromMatchId)
  const to = matches.find(m => m.id === toMatchId)
  if (!from || !to || !SIDE_KEYS[fromSide] || !SIDE_KEYS[toSide]) return 'noop'
  if (from === to && fromSide === toSide) return 'noop'
  if (isFedMatch(matches, from.id) || isFedMatch(matches, to.id)) return 'locked'

  const planned = new Map([from, to].map(m => [m, { a: m.side_a_entry_id || null, b: m.side_b_entry_id || null }]))
  const moving = planned.get(from)[fromSide]
  planned.get(from)[fromSide] = planned.get(to)[toSide]
  planned.get(to)[toSide] = moving
  if ([...planned.values()].some(p => !p.a && !p.b)) return 'empty'

  // Withdraw the old free passes first, then place players and advance new BYEs.
  for (const m of planned.keys()) {
    const next = m.winner_entry_id && matches.find(x => x.id === m.next_match_id)
    if (next && next[nextSlotKey(m)] === m.winner_entry_id) {
      next[nextSlotKey(m)] = null
      next.status = pairStatus(next)
    }
  }
  for (const [m, p] of planned) {
    m.side_a_entry_id = p.a
    m.side_b_entry_id = p.b
    const bye = p.a && p.b ? null : p.a || p.b
    m.winner_entry_id = bye
    m.status = bye ? 'finished' : 'ready'
    const next = bye && matches.find(x => x.id === m.next_match_id)
    if (next) {
      next[nextSlotKey(m)] = bye
      next.status = pairStatus(next)
    }
  }
  return 'ok'
}
