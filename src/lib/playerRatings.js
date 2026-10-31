// Player ratings given at registration, in the kinds used in Lithuania.
// Mirrors player_rating_valid() on the server: the same kinds per sport and
// the same scales, so the form never sends a value the RPC would reject.
//   tnl         TenisoNamai level (tennis and padel), 1.00–8.00, higher is better
//   lts         place in the LTS national ranking (tennis), 1 is best
//   padel_level padel letter level D…A+, stored as 1.0–6.0
//   padelution  Padelution rating (padel), an Elo-like whole number

export const PLAYER_RATING_MODES = ['off', 'optional', 'required']

export const PADEL_LEVELS = [
  ['D', 1], ['D+', 1.5], ['C-', 2], ['C', 2.5], ['C+', 3], ['B-', 3.5],
  ['B', 4], ['B+', 4.5], ['A-', 5], ['A', 5.5], ['A+', 6],
]

const SPECS = {
  tnl: { min: 1, max: 8, decimals: 2 },
  lts: { min: 1, max: 9999, decimals: 0 },
  padel_level: { levels: PADEL_LEVELS },
  padelution: { min: 0, max: 9999, decimals: 0 },
}

// The first kind is the one a new row starts with.
const KINDS = {
  tennis: ['tnl', 'lts'],
  padel: ['padel_level', 'tnl', 'padelution'],
}

export function ratingTypesFor(sport) {
  return KINDS[sport] || []
}

export function ratingSpec(type) {
  return SPECS[type] || null
}

/** Whether the public form asks this tournament's players for a rating. */
export function asksPlayerRating(tournament) {
  return PLAYER_RATING_MODES.includes(tournament?.player_rating) && tournament.player_rating !== 'off'
    && ratingTypesFor(tournament.sport).length > 0
}

export function newRatingRow(sport, used = []) {
  return { type: ratingTypesFor(sport).find(type => !used.includes(type)) || '', value: '' }
}

/** The number a typed value stands for, or null when it is not on the kind's scale. */
export function parseRatingValue(type, raw) {
  const spec = SPECS[type]
  const text = String(raw ?? '').trim().replace(',', '.')
  if (!spec || !/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number(text)
  if (spec.levels) return spec.levels.some(([, level]) => level === value) ? value : null
  const [, fraction = ''] = text.split('.')
  if (fraction.replace(/0+$/, '').length > spec.decimals) return null
  return value >= spec.min && value <= spec.max ? value : null
}

/**
 * i18n key of the first problem with one player's rows, or null. Rows left
 * empty are skipped; "required" needs at least one filled row.
 */
export function ratingRowsError(sport, rows = [], required = false) {
  const kinds = ratingTypesFor(sport)
  const filled = rows.filter(row => String(row?.value ?? '').trim() !== '')
  if (required && !filled.length) return 'playerRating.errors.required'
  const seen = new Set()
  for (const row of filled) {
    if (!kinds.includes(row.type) || parseRatingValue(row.type, row.value) == null) return 'playerRating.errors.invalid'
    if (seen.has(row.type)) return 'playerRating.errors.duplicate'
    seen.add(row.type)
  }
  return null
}

/** Rows as register_entry takes them: [{ type, value }] with the empty rows dropped. */
export function ratingPayload(rows = []) {
  return rows
    .filter(row => String(row?.value ?? '').trim() !== '')
    .map(row => ({ type: row.type, value: parseRatingValue(row.type, row.value) }))
}

/** A stored value as people write it: "B+" for a padel level, "4.25" for TNL. */
export function formatRatingValue(type, value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  const spec = SPECS[type]
  if (spec?.levels) return spec.levels.find(([, level]) => level === number)?.[0] ?? String(number)
  if (type === 'lts') return `#${number}`
  return spec?.decimals ? number.toFixed(spec.decimals) : String(Math.round(number))
}

const toNumber = value => (value == null || value === '' ? null : Number(value))

/**
 * { [entryId]: { [memberOrder]: [{ type, value, player, organizer, memberId }] } } from
 * get_entry_ratings rows. `value` is the one that counts: the organizer's when set.
 */
export function indexEntryRatings(rows = []) {
  const index = {}
  for (const row of rows || []) {
    if (!row?.entry_id || !row.rating_type) continue
    const player = toNumber(row.rating_value)
    const organizer = toNumber(row.organizer_value)
    const members = (index[row.entry_id] ||= {})
    ;(members[row.member_order] ||= []).push({
      type: row.rating_type, value: organizer ?? player, player, organizer, memberId: row.member_id || null,
    })
  }
  return index
}

// A place in a ranking: the smaller number is the stronger player.
export const LOWER_IS_BETTER = new Set(['lts'])

/** How many entries have at least one player rated in each kind of the sport. */
export function ratingKindCounts(sport, entries = [], index = {}) {
  return Object.fromEntries(ratingTypesFor(sport).map(type => [type,
    entries.filter(entry => Object.values(index[entry.id] || {}).some(list => list.some(r => r.type === type && r.value != null))).length]))
}

/** The kind most entries are rated in (the sport's first kind on a tie), or '' when nobody is. */
export function defaultSeedKind(sport, entries = [], index = {}) {
  const counts = ratingKindCounts(sport, entries, index)
  return ratingTypesFor(sport).reduce((best, type) => (counts[type] > (counts[best] ?? 0) ? type : best), '')
}

/**
 * Seed order by one rating kind, strongest first. A pair counts as the average
 * of its players; pairs where both are rated come before pairs with one rated
 * (LTS rule), entries without the kind go last in their current order. Equal
 * strength is decided by lot. `entries` are in their current seed order.
 */
export function ratingSeedOrder(entries = [], index = {}, kind, random = Math.random) {
  const lower = LOWER_IS_BETTER.has(kind)
  const scored = entries.map((entry, position) => {
    const members = (entry.entry_members || []).length || 1
    const values = Object.values(index[entry.id] || {})
      .map(list => list.find(r => r.type === kind)?.value)
      .filter(value => value != null && Number.isFinite(value))
    const strength = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null
    // 0: every player rated, 1: some of them, 2: none.
    const tier = !values.length ? 2 : values.length >= members ? 0 : 1
    return { id: entry.id, tier, strength, position, lot: random() }
  })
  scored.sort((a, b) => a.tier - b.tier
    || (a.tier === 2 ? a.position - b.position
      : (lower ? a.strength - b.strength : b.strength - a.strength) || a.lot - b.lot))
  return {
    order: scored.map(item => item.id),
    rated: scored.filter(item => item.tier < 2).length,
    unrated: scored.filter(item => item.tier === 2).length,
  }
}

export async function loadEntryRatings(client, tournamentId) {
  const { data, error } = await client.rpc('get_entry_ratings', { p_tournament_id: tournamentId })
  if (error) throw error
  return indexEntryRatings(data)
}
