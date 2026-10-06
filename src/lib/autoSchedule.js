// Automatic schedule: lays every match that is still to be played onto the
// courts as "not before" times, from a start time and one match duration.
// The result is a draft: the organizer reviews it and publishes as usual, and
// the server checks it again (apply_auto_schedule). "Not before" is a lower
// bound, so an overrunning match only makes the next ones start later.
//
// Pure: no Supabase, no Vue, so the same plan runs in the preview and in tests.
import { isPointsFormat } from './sportConfig.js'
import { sideEntryIds } from './entryDisplay.js'

export const MATCH_MINUTES_PRESETS = [30, 45, 60, 90, 120]
export const DEFAULT_MATCH_MINUTES = 90
export const MIN_MATCH_MINUTES = 5
export const MAX_MATCH_MINUTES = 600
/** Planned times are rounded up to this step. */
export const TIME_STEP_MINUTES = 5

const MINUTE = 60_000
const STEP = TIME_STEP_MINUTES * MINUTE
const roundUp = ms => Math.ceil(ms / STEP) * STEP

// Later stages come after earlier ones of the same round (double elimination).
const STAGE_RANK = { group: 0, main: 0, winners: 0, losers: 1, third_place: 2, grand_final: 3 }

export function isValidMatchMinutes(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= MIN_MATCH_MINUTES && n <= MAX_MATCH_MINUTES
}

const participants = match => [...sideEntryIds(match, 'a'), ...sideEntryIds(match, 'b')]

/**
 * Matches each match has to wait for: the feeders of its slots, all group
 * matches before a group playoff, the previous round in points formats.
 */
function dependencies(matches, format) {
  const deps = new Map(matches.map(m => [m.id, new Set()]))
  for (const m of matches) {
    for (const next of [m.next_match_id, m.loser_next_match_id]) {
      if (next && deps.has(next)) deps.get(next).add(m.id)
    }
  }
  if (format === 'groups_playoff') {
    const group = matches.filter(m => m.stage === 'group').map(m => m.id)
    for (const m of matches) if (m.stage !== 'group') for (const id of group) deps.get(m.id).add(id)
  }
  if (isPointsFormat(format)) {
    const byRound = new Map()
    for (const m of matches) {
      const round = Number(m.round_number) || 0
      if (!byRound.has(round)) byRound.set(round, [])
      byRound.get(round).push(m.id)
    }
    for (const m of matches) {
      for (const id of byRound.get((Number(m.round_number) || 0) - 1) || []) deps.get(m.id).add(id)
    }
  }
  return deps
}

/** First start >= from (on the step grid) where [start, start + duration) misses every busy interval. */
function firstFit(busy, from, duration) {
  let start = roundUp(from)
  for (const slot of busy) {
    if (slot.end <= start) continue
    if (slot.start >= start + duration) break
    start = roundUp(slot.end)
  }
  return start
}

function addBusy(busy, slot) {
  busy.push(slot)
  busy.sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * @param {object} input
 * @param {object} input.tournament   needs `format`
 * @param {object[]} input.matches    snapshot matches
 * @param {object[]} input.courts     ordered courts ({ id, sort_order })
 * @param {object} [input.draft]      draft rows by match id (indexSchedule(rows).draft)
 * @param {object[]} [input.live]     live_scores rows
 * @param {object[]} [input.groups]   groups, for a stable group order
 * @param {string[]|null} [input.courtIds] courts to use; all when omitted, none when empty
 * @param {string} input.startAt      ISO instant of the first match
 * @param {number} input.matchMinutes
 * @param {number} [input.restMinutes]
 * @param {Date|number|string} [input.now]
 * @returns {{ ok: true, rows: object[], planned: number, kept: number, skipped: string[], endsAt: string|null }
 *   | { ok: false, error: 'noCourts'|'invalidDuration'|'invalidStart' }}
 */
export function planSchedule({
  tournament, matches = [], courts = [], draft = {}, live = [], groups = [], courtIds = null,
  startAt, matchMinutes, restMinutes = 0, now = Date.now(),
}) {
  if (!isValidMatchMinutes(matchMinutes)) return { ok: false, error: 'invalidDuration' }
  const start = new Date(startAt).getTime()
  if (!startAt || Number.isNaN(start)) return { ok: false, error: 'invalidStart' }
  const chosen = Array.isArray(courtIds) ? new Set(courtIds) : null
  const useCourts = [...courts]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .filter(c => !chosen || chosen.has(c.id))
  if (!useCourts.length) return { ok: false, error: 'noCourts' }

  const nowMs = new Date(now).getTime()
  const duration = matchMinutes * MINUTE
  const rest = Math.max(0, Number(restMinutes) || 0) * MINUTE
  const anchor = roundUp(Math.max(start, nowMs))
  const byId = new Map(matches.map(m => [m.id, m]))
  const deps = dependencies(matches, tournament?.format)
  const liveStart = new Map(live.filter(l => l.status === 'active').map(l => [l.match_id, new Date(l.created_at).getTime() || nowMs]))
  const groupOrder = new Map([...groups].sort((a, b) => (a.group_index ?? 0) - (b.group_index ?? 0)).map((g, i) => [g.id, i]))
  const courtBusy = new Map(useCourts.map(c => [c.id, []]))

  // When each match is over (or expected to be) and when each participant may play again.
  const endsAt = new Map()
  const freeAt = new Map()
  const markEnd = (match, end) => {
    endsAt.set(match.id, end)
    for (const entry of participants(match)) freeAt.set(entry, Math.max(freeAt.get(entry) ?? -Infinity, end + rest))
  }

  // Fixed: a played match is done, a live one runs at least a full duration from
  // its start, a match the organizer pinned to an exact time stays where it is.
  const pinned = []
  for (const m of matches) {
    if (m.status === 'finished') { endsAt.set(m.id, -Infinity); continue }
    const row = draft[m.id]
    if (liveStart.has(m.id)) {
      const end = Math.max(nowMs, liveStart.get(m.id) + duration)
      markEnd(m, end)
      if (row?.court_id && courtBusy.has(row.court_id)) addBusy(courtBusy.get(row.court_id), { start: liveStart.get(m.id), end })
      continue
    }
    if (row?.time_kind === 'fixed' && row.scheduled_at) {
      const at = new Date(row.scheduled_at).getTime()
      markEnd(m, at + duration)
      if (row.court_id && courtBusy.has(row.court_id)) addBusy(courtBusy.get(row.court_id), { start: at, end: at + duration })
      pinned.push(m)
    }
  }

  // A side that stays empty with nothing left to feed it is never played (a bye).
  const pending = matches.filter(m => !endsAt.has(m.id))
  const waitsFor = m => [...deps.get(m.id)].filter(id => byId.has(id) && byId.get(id).status !== 'finished')
  const skipped = []
  const toPlan = []
  for (const m of pending) {
    const empty = !m.side_a_entry_id || !m.side_b_entry_id
    if (empty && !waitsFor(m).length) skipped.push(m.id)
    else toPlan.push(m)
  }
  const planSet = new Set(toPlan.map(m => m.id))
  const sortKey = m => [Number(m.round_number) || 0, STAGE_RANK[m.stage] ?? 0, groupOrder.get(m.group_id) ?? 0, Number(m.match_number) || 0]
  const before = (a, b) => {
    const ka = sortKey(a), kb = sortKey(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i]
    return a.id < b.id
  }

  const placed = new Map()
  const earliest = m => {
    let at = anchor
    for (const id of deps.get(m.id)) {
      const end = endsAt.get(id)
      if (end !== undefined) at = Math.max(at, end + rest)
    }
    for (const entry of participants(m)) at = Math.max(at, freeAt.get(entry) ?? -Infinity)
    return at
  }
  // List scheduling: of the matches whose predecessors are placed, take the
  // one that can start first (bracket order on ties), on the court free first.
  while (placed.size < toPlan.length) {
    let best = null
    for (const m of toPlan) {
      if (placed.has(m.id)) continue
      if ([...deps.get(m.id)].some(id => planSet.has(id) && !placed.has(id))) continue
      const at = earliest(m)
      if (!best || at < best.at || (at === best.at && before(m, best.match))) best = { match: m, at }
    }
    if (!best) {
      // A dependency cycle cannot come from a valid bracket; leave the rest unplanned.
      for (const m of toPlan) if (!placed.has(m.id)) skipped.push(m.id)
      break
    }
    let slot = null
    for (const court of useCourts) {
      const at = firstFit(courtBusy.get(court.id), best.at, duration)
      if (!slot || at < slot.at) slot = { court, at }
    }
    addBusy(courtBusy.get(slot.court.id), { start: slot.at, end: slot.at + duration })
    placed.set(best.match.id, { court_id: slot.court.id, at: slot.at })
    markEnd(best.match, slot.at + duration)
  }

  // Queue numbers follow the start times on each court, after the numbers that
  // played and live matches keep (the server rejects a taken place).
  const rows = []
  for (const court of useCourts) {
    let order = 0
    for (const m of matches) {
      const row = draft[m.id]
      if (row?.court_id === court.id && (m.status === 'finished' || liveStart.has(m.id))) order = Math.max(order, row.queue_order || 0)
    }
    const onCourt = [
      ...[...placed].filter(([, p]) => p.court_id === court.id).map(([id, p]) => ({ id, at: p.at, kind: 'not_before' })),
      ...pinned.filter(m => draft[m.id].court_id === court.id).map(m => ({ id: m.id, at: new Date(draft[m.id].scheduled_at).getTime(), kind: 'fixed' })),
    ].sort((a, b) => a.at - b.at || (before(byId.get(a.id), byId.get(b.id)) ? -1 : 1))
    for (const item of onCourt) {
      rows.push({ match_id: item.id, court_id: court.id, scheduled_at: new Date(item.at).toISOString(), time_kind: item.kind, queue_order: ++order })
    }
  }
  // Pinned matches without a court (or on a court left out) keep their row as is.
  for (const m of pinned) {
    if (rows.some(r => r.match_id === m.id)) continue
    const row = draft[m.id]
    rows.push({ match_id: m.id, court_id: row.court_id ?? null, scheduled_at: row.scheduled_at, time_kind: 'fixed', queue_order: row.queue_order ?? null })
  }

  const lastEnd = Math.max(-Infinity, ...[...placed.values()].map(p => p.at + duration))
  return {
    ok: true,
    rows,
    planned: placed.size,
    kept: pinned.length,
    skipped,
    endsAt: Number.isFinite(lastEnd) ? new Date(lastEnd).toISOString() : null,
  }
}

/** How a plan moves matches that already had a time in the draft: count and the largest delay. */
export function planShift(draft = {}, rows = []) {
  let moved = 0
  let maxDelayMinutes = 0
  for (const row of rows) {
    const old = draft[row.match_id]
    if (!old?.scheduled_at) continue
    const delta = (new Date(row.scheduled_at).getTime() - new Date(old.scheduled_at).getTime()) / MINUTE
    if (delta !== 0 || old.court_id !== row.court_id) moved += 1
    maxDelayMinutes = Math.max(maxDelayMinutes, delta)
  }
  return { moved, maxDelayMinutes }
}
