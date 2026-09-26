// Knockout rounds are named from the end: final, semifinal, quarterfinal,
// then 1/8, 1/16, 1/32… Losers-bracket rounds do not halve the field, so they
// keep their ordinal "Round N"; all-play-all rounds (round robin, groups) are
// tours: "Tour N".
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
 * tours of an all-play-all, so a round_robin tournament has no knockout totals,
 * only the roundRobin mark, and matchRoundName names its rounds "Tour N".
 */
export function knockoutTotals(matches = [], format = '') {
  const totals = {}
  if (format === 'round_robin') return { roundRobin: true }
  for (const m of matches) {
    if (!KNOCKOUT_STAGES.has(m.stage)) continue
    totals[m.stage] = Math.max(totals[m.stage] || 0, Number(m.round_number || 0))
  }
  return totals
}

/** "Tour N" of an all-play-all; group rounds carry a per-group offset (1001, 2001…). */
export function tourName(roundNumber, t) {
  const round = Number(roundNumber || 0)
  return t('bracket.tourN', { n: round > 1000 ? round % 1000 : round })
}

/** Round name for any match: knockout stages by distance to the final, tours and lower-bracket rounds by number. */
export function matchRoundName(match, totals = {}, t) {
  const round = Number(match.round_number || 0)
  if (match.stage === 'group' || totals.roundRobin) return tourName(round, t)
  if (KNOCKOUT_STAGES.has(match.stage)) return knockoutRoundName(round, totals[match.stage] || 0, t)
  return t('bracket.roundN', { n: round > 1000 ? round % 1000 : round })
}

/**
 * Column title of one bracket board. The board shows a single stage: the
 * lower bracket keeps "Round N" (its rounds do not halve the field), every
 * other knockout board counts from its final.
 */
export function bracketRoundName(stage, roundNumber, totalRounds, t) {
  if (stage === 'group') return tourName(roundNumber, t)
  if (stage === 'losers') return t('bracket.roundN', { n: roundNumber })
  return knockoutRoundName(roundNumber, totalRounds, t)
}

/**
 * A match named outside its board (correction preview, lists, the finish
 * dialog): the stage prefix only where it tells rounds apart — groups ("Group A
 * · Tour 2" when the letter is known), and the upper/lower bracket of a double
 * elimination; a single bracket, a round robin or a group playoff reads fine as
 * just "Semifinal" / "Tour 3".
 */
export function matchStageRoundLabel(match, { totals = {}, hasLosers = false, groupNames = null } = {}, t) {
  if (match.stage === 'grand_final' || match.stage === 'third_place') return t(`mobile.matchStage.${match.stage}`)
  const round = Number(match.round_number || 0)
  const letter = match.stage === 'group' ? groupNames?.[match.group_id] : null
  const base = letter ? `${t('mobile.matchStage.group')} ${letter}` : t(`mobile.matchStage.${match.stage || 'main'}`)
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
export function correctionMatchTitle(match, matches, t, { format = '', groupNames = null } = {}) {
  const rounds = { totals: matches?.length ? knockoutTotals(matches, format) : {}, hasLosers: Boolean(matches?.some(m => m.stage === 'losers')), groupNames }
  const label = matchStageRoundLabel(match, rounds, t)
  return match.stage === 'grand_final' || match.stage === 'third_place' ? label : `${label} · №${match.match_number}`
}
