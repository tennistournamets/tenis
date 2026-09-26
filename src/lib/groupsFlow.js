// Round robin and groups + playoff helpers shared by the admin and public
// views. Pure functions: the server owns seeding, guards and corrections.
import { scoringError } from './tennisRules.js'

/** Server codes of the round-robin / groups generators, then the scoring fallback. */
export function groupsError(message, t) {
  if (typeof message === 'string' && message.startsWith('groupsFlow.')) return t(message)
  return scoringError(message, t)
}

/**
 * Generated matches must cover exactly the approved field. After an approval,
 * rejection or reopening they no longer do: somebody has no match, or a
 * withdrawn participant still plays. Works for every format, because every
 * approved entry appears in the first stage (round robin, groups, round 1).
 */
export function rosterMismatch(approvedEntries = [], matches = []) {
  if (!matches.length) return { stale: false, missing: [], extra: [] }
  const approved = new Set(approvedEntries.map(entry => entry.id))
  const playing = new Set()
  for (const m of matches) for (const id of [m.side_a_entry_id, m.side_b_entry_id]) if (id) playing.add(id)
  const missing = [...approved].filter(id => !playing.has(id))
  const extra = [...playing].filter(id => !approved.has(id))
  return { stale: missing.length > 0 || extra.length > 0, missing, extra }
}

/** A status change that adds an entry to the field or takes it out. */
export const changesField = (from, to) => (from === 'approved') !== (to === 'approved')

// Group rounds are stored with an offset per group (group B starts at 1001).
export const roundInGroup = round => (Number(round) > 1000 ? Number(round) % 1000 : Number(round) || 0)
export const groupIndexOfRound = round => Math.floor((Number(round) || 0) / 1000)

export function groupNamesById(groups = []) {
  return Object.fromEntries(groups.map(g => [g.id, g.name]))
}

/** "Group A · Tour 2" for a group-stage match; the letter is omitted when unknown. */
export function groupRoundLabel(match, groupNames, t) {
  const round = t('bracket.tourN', { n: roundInGroup(match.round_number) })
  const name = groupNames?.[match.group_id]
  return name ? `${t('admin.group')} ${name} · ${round}` : `${t('admin.group')} · ${round}`
}

/** Group-stage order for lists: round inside the group, then the group, then the match. */
export function compareGroupMatches(a, b) {
  return roundInGroup(a.round_number) - roundInGroup(b.round_number)
    || groupIndexOfRound(a.round_number) - groupIndexOfRound(b.round_number)
    || (a.match_number || 0) - (b.match_number || 0)
}

/** How many entries may advance from each group: 1..min(max, smallest group). */
export function advanceOptions(n, groupCount, max = 4) {
  const count = Math.max(0, Number(n) || 0)
  const g = Math.max(1, Number(groupCount) || 1)
  const smallest = Math.floor(count / g)
  return Array.from({ length: Math.max(0, Math.min(max, smallest)) }, (_, i) => i + 1)
}

/**
 * "Advance per group" shown and sent before the first draw. The organizer's
 * pick, else the stored wizard value, else 2 — never overwritten while the
 * field is still too small for it: the largest option not above it is shown
 * until enough entries are approved.
 */
export function effectiveAdvance(options = [], stored = null, picked = null) {
  const preferred = Number(picked) || Number(stored) || 2
  if (!options.length || options.includes(preferred)) return preferred
  return options.filter(a => a <= preferred).at(-1) ?? options[0]
}

/** p_advance_per_group for generate_groups: null keeps the stored value on the server. */
export function advanceToSend(options = [], stored = null, picked = null) {
  const value = effectiveAdvance(options, stored, picked)
  return picked != null || value !== Number(stored) ? value : null
}

export function groupMatchProgress(matches = []) {
  const group = matches.filter(m => m.stage === 'group')
  return { total: group.length, done: group.filter(m => m.status === 'finished').length }
}

/** Confirmation items for "Start playoff" from get_group_playoff_preview. */
export function playoffPreviewItems(preview, t) {
  const tag = side => t('groupsFlow.seedTag', { seed: side.seed, group: side.group_name, rank: side.group_rank })
  const label = side => `${side.name} (${tag(side)})`
  return (preview?.pairs || []).map(pair => {
    const sides = [pair.a, pair.b].filter(Boolean)
    return {
      id: String(pair.match_number),
      title: t('groupsFlow.pairTitle', { n: pair.match_number }),
      teams: sides.map(label).join(' — '),
      effect: t(sides.length === 2 ? 'groupsFlow.pairPlay' : 'groupsFlow.pairBye'),
    }
  })
}

/**
 * Intro and warning of the correction dialog. A group result that rebuilds the
 * playoff says so, and names the scheduled / published playoff matches it
 * touches (their slots stay, the opponents change).
 */
export function correctionTexts(preview, t) {
  if (preview?.reseed_playoff) {
    const schedule = preview.schedule_matches
      ? ` ${t('groupsFlow.correctionSchedule', { n: preview.schedule_matches, published: preview.schedule_published || 0 })}`
      : ''
    return { intro: t('groupsFlow.correctionReseed'), warning: `${t('scoringFlow.correctionWarning')}${schedule}` }
  }
  return { intro: t('scoringFlow.correctionIntro'), warning: t('scoringFlow.correctionWarning') }
}
