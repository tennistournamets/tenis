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
export function buildSetPayload(rows, config, setFormat) {
  const result = []
  for (const row of rows) {
    const rule = ruleForSet(config, row.set_index, setFormat)
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
  if (message.startsWith('drafts.') || message.startsWith('tennisRules.') || message.startsWith('scoringFlow.')) return t(message)
  if (/Invalid set or tiebreak/.test(message)) return t('tennisRules.invalidScore')
  if (/Scoring rules are locked/.test(message)) return t('tennisRules.locked')
  if (/Only the final entered set/.test(message)) return t('tennisRules.partialLast')
  if (/No further sets/.test(message)) return t('tennisRules.matchOver')
  if (/Set indices/.test(message)) return t('tennisRules.setOrder')
  return message
}
