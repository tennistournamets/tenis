// Knockout rounds are named from the end: final, semifinal, quarterfinal,
// then 1/8, 1/16, 1/32… Losers-bracket and group rounds do not halve the
// field, so they keep their ordinal "Round N".
export const KNOCKOUT_STAGES = new Set(['main', 'winners'])

export function knockoutRoundName(roundNumber, totalRounds, t) {
  const fromEnd = totalRounds - roundNumber
  if (!totalRounds || roundNumber < 1 || fromEnd < 0) return t('bracket.roundN', { n: roundNumber })
  if (fromEnd === 0) return t('bracket.final')
  if (fromEnd === 1) return t('bracket.semifinals')
  if (fromEnd === 2) return t('bracket.quarterfinals')
  const k = 2 ** fromEnd
  return t('bracket.fractionFinal', { k, n: k * 2 })
}

/**
 * Highest round per knockout stage, the reference point for knockoutRoundName.
 * Round-robin matches are stored with stage 'main' too, but their rounds are
 * tours of an all-play-all, so a round_robin tournament has no knockout totals
 * and matchRoundName falls back to "Round N".
 */
export function knockoutTotals(matches = [], format = '') {
  const totals = {}
  if (format === 'round_robin') return totals
  for (const m of matches) {
    if (!KNOCKOUT_STAGES.has(m.stage)) continue
    totals[m.stage] = Math.max(totals[m.stage] || 0, Number(m.round_number || 0))
  }
  return totals
}

/** Round name for any match: knockout stages by distance to the final, others by number. */
export function matchRoundName(match, totals, t) {
  const round = Number(match.round_number || 0)
  if (KNOCKOUT_STAGES.has(match.stage)) return knockoutRoundName(round, totals[match.stage] || 0, t)
  return t('bracket.roundN', { n: round > 1000 ? round % 1000 : round })
}
