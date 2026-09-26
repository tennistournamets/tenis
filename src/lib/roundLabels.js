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

/**
 * Column title of one bracket board. The board shows a single stage: the
 * lower bracket keeps "Round N" (its rounds do not halve the field), every
 * other knockout board counts from its final.
 */
export function bracketRoundName(stage, roundNumber, totalRounds, t) {
  if (stage === 'losers' || stage === 'group') return t('bracket.roundN', { n: roundNumber })
  return knockoutRoundName(roundNumber, totalRounds, t)
}

/**
 * A match named outside its board (correction preview, lists): the stage
 * prefix only where it tells rounds apart — groups, and the upper/lower
 * bracket of a double elimination; a single bracket or a group playoff reads
 * fine as just "Semifinal".
 */
export function matchStageRoundLabel(match, { totals = {}, hasLosers = false } = {}, t) {
  if (match.stage === 'grand_final' || match.stage === 'third_place') return t(`mobile.matchStage.${match.stage}`)
  const round = Number(match.round_number || 0)
  const base = t(`mobile.matchStage.${match.stage || 'main'}`)
  if (!round) return base
  const name = matchRoundName(match, totals, t)
  const prefixed = match.stage === 'group' || match.stage === 'losers' || (match.stage === 'winners' && hasLosers)
  return prefixed ? `${base} · ${name}` : name
}

/**
 * Title of a match in the correction preview: "Semifinal · №1",
 * "Upper bracket · Semifinal · №1", "Lower bracket · Round 2 · №1". Round
 * names count from the final, so they need the whole bracket (matches);
 * without it knockout rounds fall back to "Round N".
 */
export function correctionMatchTitle(match, matches, t) {
  const rounds = { totals: matches?.length ? knockoutTotals(matches) : {}, hasLosers: Boolean(matches?.some(m => m.stage === 'losers')) }
  const label = matchStageRoundLabel(match, rounds, t)
  return match.stage === 'grand_final' || match.stage === 'third_place' ? label : `${label} · №${match.match_number}`
}
