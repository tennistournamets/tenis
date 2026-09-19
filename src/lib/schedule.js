// Manual schedule helpers: the server owns conflicts and publication; the
// client indexes rows, formats times in the tournament zone and maps codes.
import { registrationError } from './registrationRules.js'

export const TIME_KINDS = ['fixed', 'not_before']
export const COMMON_TIMEZONES = ['Europe/Vilnius', 'Europe/Riga', 'Europe/Tallinn', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/London', 'Europe/Kyiv', 'Europe/Moscow', 'UTC']

export function scheduleError(message, t, fallbackKey = 'errors.generic') {
  if (typeof message === 'string' && message.startsWith('schedule.')) return t(`schedule.errors.${message.slice('schedule.'.length)}`)
  return registrationError(message, t, fallbackKey)
}

/** { draft: { [matchId]: row }, published: { [matchId]: row } } */
export function indexSchedule(rows = []) {
  const index = { draft: {}, published: {} }
  for (const row of rows) if (index[row.state]) index[row.state][row.match_id] = row
  return index
}

/** Rows the current viewer should see: organizers work on the draft, everyone else reads the publication. */
export function effectiveSchedule(rows = [], preferDraft = false) {
  const index = indexSchedule(rows)
  if (!preferDraft) return index.published
  return { ...index.published, ...index.draft }
}

const sameAssignment = (a, b) => Boolean(a) && Boolean(b)
  && (a.court_id ?? null) === (b.court_id ?? null)
  && (a.time_kind ?? null) === (b.time_kind ?? null)
  && (a.queue_order ?? null) === (b.queue_order ?? null)
  && (a.scheduled_at ? new Date(a.scheduled_at).getTime() : null) === (b.scheduled_at ? new Date(b.scheduled_at).getTime() : null)

/** Matches whose draft differs from the publication (added, changed or removed). */
export function draftDiff(rows = []) {
  const { draft, published } = indexSchedule(rows)
  const ids = new Set([...Object.keys(draft), ...Object.keys(published)])
  const changed = [...ids].filter(id => !sameAssignment(draft[id], published[id]))
  return { changed, count: changed.length }
}

export function timezoneOf(tournament) {
  return tournament?.schedule_config?.timezone || ''
}

export function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

function partsIn(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || undefined, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const out = {}
  for (const part of formatter.formatToParts(date)) if (part.type !== 'literal') out[part.type] = Number(part.value)
  return out
}

/** Offset (ms) of `timeZone` at `date`; 0 when the zone is unknown. */
export function zoneOffsetMs(date, timeZone) {
  try {
    const p = partsIn(date, timeZone)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
    return asUtc - Math.floor(date.getTime() / 1000) * 1000
  } catch {
    return 0
  }
}

const pad = n => String(n).padStart(2, '0')

/** ISO instant → "YYYY-MM-DDTHH:MM" as seen in the tournament zone (browser zone when empty). */
export function isoToZonedLocal(iso, timeZone) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    const p = partsIn(date, timeZone)
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour % 24)}:${pad(p.minute)}`
  } catch {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

/** "YYYY-MM-DDTHH:MM" typed in the tournament zone → ISO instant; null when invalid. */
export function zonedLocalToIso(value, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '')
  if (!match) return null
  const [y, mo, d, h, mi] = match.slice(1).map(Number)
  if (!timeZone) {
    const local = new Date(y, mo - 1, d, h, mi)
    return Number.isNaN(local.getTime()) ? null : local.toISOString()
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  let guess = new Date(wall - zoneOffsetMs(new Date(wall), timeZone))
  // A second pass settles instants near a DST transition.
  guess = new Date(wall - zoneOffsetMs(guess, timeZone))
  return Number.isNaN(guess.getTime()) ? null : guess.toISOString()
}

export function formatScheduleTime(iso, locale = 'en', timeZone = '') {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const options = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timeZone || undefined }).format(date)
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(date)
  }
}

/** One line for a match card: "Court 1 · 1 Oct, 10:00" / "not before 10:00" / "#2 in queue". */
export function scheduleSummary(row, { courtsById = {}, t, locale = 'en', timeZone = '' }) {
  if (!row) return ''
  const parts = []
  if (row.court_id && courtsById[row.court_id]) parts.push(courtsById[row.court_id].name)
  if (row.scheduled_at) {
    const time = formatScheduleTime(row.scheduled_at, locale, timeZone)
    parts.push(row.time_kind === 'not_before' ? t('schedule.notBefore', { time }) : time)
  }
  if (row.queue_order) parts.push(t('schedule.queueLabel', { n: row.queue_order }))
  return parts.join(' · ')
}

export function conflictText(conflict, t, matchLabel = () => '') {
  return t(`schedule.kinds.${conflict.kind}`, { match: conflict.match_id ? matchLabel(conflict.match_id) : '', minutes: conflict.minutes ?? '' })
}

export const hasHardConflict = conflicts => (conflicts || []).some(c => c.severity === 'hard')

// publish_schedule deliberately publishes a draft despite these two: they mark
// matches that can no longer move, not a clash the organizer could resolve.
// Without the same exemption here, the first finished match would block every
// later publication.
const PUBLISHABLE_DESPITE = new Set(['match_finished', 'match_live'])

export const blocksPublish = conflict => conflict.severity === 'hard' && !PUBLISHABLE_DESPITE.has(conflict.kind)

/** Matches the server refuses to reschedule: both are hard conflicts. */
export const scheduleLocked = (match, liveRow) => match?.status === 'finished' || liveRow?.status === 'active'

/**
 * A court column split at the queue boundary. The head holds matches with a
 * time (or a bare court), which sort ahead of the queue because their
 * queue_order is null; the queue holds the numbered ones in their order.
 */
export function splitCourtColumn(columnIds = [], draftByMatch = {}) {
  const head = []
  const queue = []
  for (const id of columnIds) (draftByMatch[id]?.queue_order ? queue : head).push(id)
  queue.sort((a, b) => draftByMatch[a].queue_order - draftByMatch[b].queue_order)
  return { head, queue }
}

/** The queue after moving `matchId` in front of `beforeMatchId` (null appends). */
export function reorderQueue(queue = [], matchId, beforeMatchId = null) {
  const rest = queue.filter(id => id !== matchId)
  const at = beforeMatchId === null ? -1 : rest.indexOf(beforeMatchId)
  if (at < 0) return [...rest, matchId]
  return [...rest.slice(0, at), matchId, ...rest.slice(at)]
}

const sameOrder = (a, b) => a.length === b.length && a.every((id, i) => id === b[i])

/**
 * The single write one drop produces, or null when the drop changes nothing.
 * A timed match keeps its time and never takes a queue number: the board sorts
 * on `queue_order || 0` first, so a number would drag it behind the queue.
 *
 * @returns {null
 *  | { kind: 'clear', matchId }
 *  | { kind: 'assign', matchId, courtId, scheduledAt, timeKind }
 *  | { kind: 'queue', matchId, courtId, order }}
 */
export function scheduleDropAction({
  matchId, draftRow = null, locked = false,
  targetKey, beforeMatchId = null, columnIds = [], draftByMatch = {},
} = {}) {
  if (!matchId || locked || !targetKey) return null

  if (targetKey === 'unassigned') return draftRow ? { kind: 'clear', matchId } : null

  // "Без корта" only means "keep the time, drop the court"; a row with neither
  // court nor time is rejected by the table check and by set_match_schedule.
  if (targetKey === 'none') {
    if (!draftRow?.scheduled_at || !draftRow.court_id) return null
    return { kind: 'assign', matchId, courtId: null, scheduledAt: draftRow.scheduled_at, timeKind: draftRow.time_kind }
  }

  if (draftRow?.scheduled_at) {
    if (draftRow.court_id === targetKey && draftRow.queue_order == null) return null
    return { kind: 'assign', matchId, courtId: targetKey, scheduledAt: draftRow.scheduled_at, timeKind: draftRow.time_kind }
  }

  const { queue } = splitCourtColumn(columnIds, draftByMatch)
  const order = reorderQueue(queue, matchId, beforeMatchId)
  if (draftRow?.court_id === targetKey && sameOrder(order, queue)) return null
  return { kind: 'queue', matchId, courtId: targetKey, order }
}

/** Sort key for "by time": fixed/not-before instants first, then court queues, then unscheduled. */
export function scheduleSortKey(row) {
  if (!row) return [2, 0, 0]
  if (row.scheduled_at) return [0, new Date(row.scheduled_at).getTime(), row.queue_order || 0]
  return [1, 0, row.queue_order || 0]
}

export function compareBySchedule(a, b) {
  const ka = scheduleSortKey(a), kb = scheduleSortKey(b)
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
  return 0
}
