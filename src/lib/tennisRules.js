// ITF Rules of Tennis 2026, rules 5–7/10 and Appendix VI.
export const DEFAULT_TENNIS_RULES = Object.freeze({
  game_rule: 'advantage', set_rule: 'standard', short_tiebreak_at: 4,
  short_tiebreak_to: 7, final_set_rule: 'same', changeover: 'every_six',
})

export function tennisRules(config = {}) {
  return {
    ...DEFAULT_TENNIS_RULES, ...config?.tennis,
    tiebreak_to: config?.tennis ? 7 : Number(config?.tiebreak_to || 7),
  }
}

export function ruleForSet(config, index, setFormat = 'best_of_3') {
  const r = tennisRules(config)
  const max = setFormat === 'best_of_5' ? 5 : 3
  let kind = r.set_rule, target = r.tiebreak_to
  if (index === max && r.final_set_rule !== 'same') {
    if (r.final_set_rule.startsWith('match_tiebreak_')) {
      return { kind: 'match_tiebreak', games_to: 0, at: 0, target: Number(r.final_set_rule.split('_').at(-1)), margin: 2 }
    }
    kind = r.final_set_rule === 'tiebreak_10' ? 'standard' : r.final_set_rule
    target = r.final_set_rule === 'tiebreak_10' ? 10 : 7
  }
  return {
    kind: 'set', games_to: kind === 'short' ? 4 : 6,
    at: kind === 'advantage' ? null : kind === 'short' ? r.short_tiebreak_at : 6,
    target: kind === 'short' ? r.short_tiebreak_to : target,
    margin: kind === 'short' && r.short_tiebreak_to === 5 ? 1 : 2,
  }
}

export function tennisRulesSummary(config, t) {
  const r = tennisRules(config)
  const parts = [t(`tennisRules.game_${r.game_rule}`), t(`tennisRules.set_${r.set_rule}`)]
  if (r.set_rule === 'short') parts.push(t('tennisRules.shortSummary', { at: r.short_tiebreak_at, to: r.short_tiebreak_to }))
  parts.push(t('tennisRules.finalSummary', { rule: t(`tennisRules.final_${r.final_set_rule}`) }))
  if (usesLongTiebreak(config)) parts.push(`${t('tennisRules.changeover')}: ${t(r.changeover === 'one_then_four' ? 'tennisRules.oneThenFour' : 'tennisRules.everySix')}`)
  if (r.set_rule === 'short' && r.short_tiebreak_to === 5) parts.push(t('tennisRules.shortEnds'))
  if (!config?.tennis && r.tiebreak_to === 10) parts.push(t('tennisRules.legacy10'))
  return parts.join(' · ')
}

export function tennisRulesRows(config, t) {
  const r = tennisRules(config)
  const rows = [
    { label: t('tennisRules.game'), value: t(`tennisRules.game_${r.game_rule}`) },
    { label: t('tennisRules.set'), value: t(`tennisRules.set_${r.set_rule}`) },
  ]
  if (r.set_rule === 'short') {
    rows.push({ label: t('tennisRules.shortAt'), value: `${r.short_tiebreak_at}:${r.short_tiebreak_at}` })
    rows.push({ label: t('tennisRules.shortTo'), value: t(r.short_tiebreak_to === 5 ? 'tennisRules.to5' : 'tennisRules.to7') })
  }
  rows.push({ label: t('tennisRules.final'), value: t(`tennisRules.final_${r.final_set_rule}`) })
  if (usesLongTiebreak(config)) {
    rows.push({
      label: t('tennisRules.changeover'),
      value: t(r.changeover === 'one_then_four' ? 'tennisRules.oneThenFour' : 'tennisRules.everySix'),
    })
  }
  if (r.set_rule === 'short' && r.short_tiebreak_to === 5) rows.push({ label: '', value: t('tennisRules.shortEnds') })
  if (!config?.tennis && r.tiebreak_to === 10) rows.push({ label: '', value: t('tennisRules.legacy10') })
  return rows
}

export function usesLongTiebreak(config) {
  return [1, 3].some(index => {
    const rule = ruleForSet(config, index)
    return rule.at !== null && rule.margin === 2
  })
}

export function scoreRows(sets = [], setFormat = 'best_of_3') {
  return Array.from({ length: setFormat === 'best_of_5' ? 5 : 3 }, (_, i) => {
    const s = sets.find(s => s.set_index === i + 1)
    return {
      set_index: i + 1, side_a_games: s?.side_a_games ?? '', side_b_games: s?.side_b_games ?? '',
      side_a_tiebreak: s?.side_a_tiebreak ?? '', side_b_tiebreak: s?.side_b_tiebreak ?? '',
    }
  })
}

const blank = value => value === '' || value == null

// Mirrors tennis_race_result in SQL: 1 — side A won, 2 — side B, 0 — still open, -1 — impossible.
export function raceResult(a, b, target, margin) {
  if (a == null || b == null || a < 0 || b < 0) return -1
  const hi = Math.max(a, b), lo = Math.min(a, b)
  if (hi < target || Math.abs(a - b) < margin) return margin === 1 && hi >= target ? -1 : 0
  if ((hi === target && lo <= target - margin) || (margin === 2 && hi > target && Math.abs(a - b) === 2)) return a > b ? 1 : 2
  return -1
}

// Organizers often type a tie-break set as 6:6 plus the tie-break score. The
// server stores it as 7:6 (the tie-break winner takes the last game), so a
// finished tie-break at the tie-break game count settles the games.
export function settleTiebreakGames(row, rule) {
  if (rule.kind === 'match_tiebreak' || rule.at == null) return row
  const [a, b, ta, tb] = [row.side_a_games, row.side_b_games, row.side_a_tiebreak, row.side_b_tiebreak].map(v => (blank(v) ? null : Number(v)))
  if (a !== rule.at || b !== rule.at || ta == null || tb == null) return row
  const won = raceResult(ta, tb, rule.target, rule.margin)
  if (won !== 1 && won !== 2) return row
  return { ...row, side_a_games: won === 1 ? rule.at + 1 : rule.at, side_b_games: won === 2 ? rule.at + 1 : rule.at }
}
export function buildSetPayload(rows, config, setFormat) {
  const result = []
  for (const typed of rows) {
    const rule = ruleForSet(config, typed.set_index, setFormat)
    const row = settleTiebreakGames(typed, rule)
    const fields = rule.kind === 'match_tiebreak'
      ? ['side_a_tiebreak', 'side_b_tiebreak']
      : ['side_a_games', 'side_b_games', 'side_a_tiebreak', 'side_b_tiebreak']
    if (fields.every(k => blank(row[k]))) continue
    const keys = rule.kind === 'match_tiebreak' ? fields : fields.slice(0, 2)
    if (keys.some(k => blank(row[k])) || blank(row.side_a_tiebreak) !== blank(row.side_b_tiebreak)) {
      throw new Error('tennisRules.incompleteScore')
    }
    for (const key of fields) {
      if (!blank(row[key]) && (!Number.isInteger(Number(row[key])) || Number(row[key]) < 0 || Number(row[key]) > 2147483647)) {
        throw new Error('tennisRules.integerScore')
      }
    }
    const item = {
      set_index: row.set_index, score_kind: rule.kind,
      side_a_games: rule.kind === 'match_tiebreak' ? 0 : Number(row.side_a_games),
      side_b_games: rule.kind === 'match_tiebreak' ? 0 : Number(row.side_b_games),
    }
    if (!blank(row.side_a_tiebreak)) {
      item.side_a_tiebreak = Number(row.side_a_tiebreak)
      item.side_b_tiebreak = Number(row.side_b_tiebreak)
    }
    result.push(item)
  }
  return result
}

export function formatSetScore(set) {
  if (set.score_kind === 'match_tiebreak') return `[${set.side_a_tiebreak}:${set.side_b_tiebreak}]`
  const games = `${set.side_a_games}:${set.side_b_games}`
  return set.side_a_tiebreak != null && set.side_b_tiebreak != null
    ? `${games} (${set.side_a_tiebreak}:${set.side_b_tiebreak})` : games
}

export function liveRuleHint(state, t) {
  if (!state || state.winner) return ''
  if (state.isTiebreak) return t(state.isMatchTiebreak ? 'tennisRules.liveMatchTiebreak' : 'tennisRules.liveTiebreak', {
    to: state.tiebreakTo || 7,
    finish: t(state.tiebreakMargin === 1 ? 'tennisRules.suddenDeath' : 'tennisRules.twoClear'),
  })
  if (state.rules?.game_rule === 'no_ad' && state.points?.a === 3 && state.points?.b === 3) return t('tennisRules.decidingPoint')
  return ''
}

export function scoringError(message, t) {
  if (typeof message !== 'string' || !message) return t('scoringFlow.unavailable')
  if (message.startsWith('drafts.') || message.startsWith('tennisRules.') || message.startsWith('scoringFlow.')) return t(message)
  if (/Invalid set or tiebreak/.test(message)) return t('tennisRules.invalidScore')
  if (/Scoring rules are locked/.test(message)) return t('tennisRules.locked')
  if (/Only the final entered set/.test(message)) return t('tennisRules.partialLast')
  if (/No further sets/.test(message)) return t('tennisRules.matchOver')
  if (/Set indices/.test(message)) return t('tennisRules.setOrder')
  return message
}

// Sets each side has clearly won in the typed rows, and how many a win needs.
// Deliberately lenient (more games and at least the set target, or the match
// tie-break target): it only answers "is there obviously no winner yet?" so the
// form can explain itself; the server still validates the exact score.
export function decidedSets(rows = [], config = {}, setFormat = 'best_of_3') {
  const wins = { a: 0, b: 0 }
  for (const typed of rows) {
    const rule = ruleForSet(config, typed.set_index, setFormat)
    const row = settleTiebreakGames(typed, rule)
    const [a, b] = rule.kind === 'match_tiebreak'
      ? [row.side_a_tiebreak, row.side_b_tiebreak]
      : [row.side_a_games, row.side_b_games]
    if (blank(a) || blank(b)) continue
    const target = rule.kind === 'match_tiebreak' ? rule.target : rule.games_to
    const [na, nb] = [Number(a), Number(b)]
    if (Math.max(na, nb) < target || na === nb) continue
    wins[na > nb ? 'a' : 'b'] += 1
  }
  return { ...wins, required: setFormat === 'best_of_5' ? 3 : 2 }
}

export function hasMatchWinner(rows, config, setFormat) {
  const { a, b, required } = decidedSets(rows, config, setFormat)
  return a >= required || b >= required
}
