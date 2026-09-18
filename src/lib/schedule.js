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
