// "4 участника / 5 участников / 21 участник": vue-i18n pluralizes one number per message,
// while the format plans combine several counts. Each count is rendered on its own
// with Intl.PluralRules and passed to the message as `<key>Text`.

const NOUNS = { n: 'participants', matches: 'matches', rounds: 'rounds', groups: 'groups', byes: 'byes', upper: 'matches', lower: 'matches' }

export function pluralCategory(locale, n) {
  try { return new Intl.PluralRules(locale).select(Number(n)) } catch { return Number(n) === 1 ? 'one' : 'other' }
}

/** "5 матчей" for noun `matches` in `locale` (`t` resolves `plural.<noun>.<category>`). */
export function countText(t, locale, noun, n) {
  const key = `plural.${noun}.${pluralCategory(locale, n)}`
  const text = t(key, { n })
  return text === key ? t(`plural.${noun}.other`, { n }) : text
}

/** Plan params plus `<key>Text` for every counted value it contains. */
export function pluralParams(plan, t, locale) {
  const params = { ...plan }
  for (const [key, noun] of Object.entries(NOUNS)) {
    if (typeof plan?.[key] === 'number') params[`${key}Text`] = countText(t, locale, noun, plan[key])
  }
  return params
}
