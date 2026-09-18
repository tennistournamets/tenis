import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareBySchedule, conflictText, draftDiff, effectiveSchedule, formatScheduleTime, hasHardConflict, indexSchedule,
  isoToZonedLocal, scheduleError, scheduleSummary, zonedLocalToIso, zoneOffsetMs,
} from '../src/lib/schedule.js'
import { isTournamentEvent } from '../src/lib/tournamentSync.js'
import { scheduleMessages } from '../src/i18n/schedule.js'

const t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key
const row = (match_id, state, patch = {}) => ({ id: `${match_id}-${state}`, match_id, state, court_id: null, scheduled_at: null, time_kind: null, queue_order: null, ...patch })

test('server codes map to schedule translations and fall through to the other families', () => {
  assert.equal(scheduleError('schedule.conflict', t), 'schedule.errors.conflict')
  assert.equal(scheduleError('schedule.warnings', t), 'schedule.errors.warnings')
  assert.equal(scheduleError('registration.full', t), 'registrationRules.errors.full')
  assert.equal(scheduleError('drafts.conflict', t), 'drafts.conflict')
  assert.equal(scheduleError('', t), 'errors.generic')
  assert.equal(scheduleError('Not allowed', t), 'Not allowed')
})

test('draft and published rows are indexed separately; organizers see the draft, spectators the publication', () => {
  const rows = [row('m1', 'published', { court_id: 'c1', scheduled_at: '2026-10-01T10:00:00Z', time_kind: 'fixed' }),
    row('m1', 'draft', { court_id: 'c1', scheduled_at: '2026-10-01T12:00:00Z', time_kind: 'fixed' }),
    row('m2', 'draft', { court_id: 'c2', queue_order: 1 }),
    row('m3', 'published', { court_id: 'c2', queue_order: 2 })]
  const index = indexSchedule(rows)
  assert.deepEqual(Object.keys(index.draft).sort(), ['m1', 'm2'])
  assert.deepEqual(Object.keys(index.published).sort(), ['m1', 'm3'])
  assert.equal(effectiveSchedule(rows, false).m1.scheduled_at, '2026-10-01T10:00:00Z')
  assert.equal(effectiveSchedule(rows, true).m1.scheduled_at, '2026-10-01T12:00:00Z')
  assert.equal(effectiveSchedule(rows, true).m3.queue_order, 2)
  assert.equal(effectiveSchedule(rows, false).m2, undefined)
  // m1 changed, m2 added, m3 removed from the draft.
  assert.deepEqual(draftDiff(rows).changed.sort(), ['m1', 'm2', 'm3'])
  const same = [row('m1', 'published', { scheduled_at: '2026-10-01T10:00:00+00:00', time_kind: 'fixed' }), row('m1', 'draft', { scheduled_at: '2026-10-01T10:00:00.000Z', time_kind: 'fixed' })]
  assert.equal(draftDiff(same).count, 0)
  assert.equal(draftDiff([]).count, 0)
})

test('times typed in the tournament zone become the right instant and format back, DST included', () => {
  assert.equal(zonedLocalToIso('2026-07-01T10:00', 'Europe/Vilnius'), '2026-07-01T07:00:00.000Z')
  assert.equal(zonedLocalToIso('2026-12-01T10:00', 'Europe/Vilnius'), '2026-12-01T08:00:00.000Z')
  assert.equal(zonedLocalToIso('2026-07-01T10:00', 'UTC'), '2026-07-01T10:00:00.000Z')
  assert.equal(zonedLocalToIso('garbage', 'UTC'), null)
  assert.equal(zonedLocalToIso('', 'UTC'), null)
  assert.equal(isoToZonedLocal('2026-07-01T07:00:00.000Z', 'Europe/Vilnius'), '2026-07-01T10:00')
  assert.equal(isoToZonedLocal('2026-12-01T08:00:00.000Z', 'Europe/Vilnius'), '2026-12-01T10:00')
  assert.equal(isoToZonedLocal('', 'UTC'), '')
  assert.equal(zoneOffsetMs(new Date('2026-07-01T00:00:00Z'), 'Europe/Vilnius'), 3 * 3600_000)
  assert.equal(zoneOffsetMs(new Date('2026-07-01T00:00:00Z'), 'Nowhere/Invalid'), 0)
  // Browser-local fallback round-trips regardless of the machine zone.
  const local = zonedLocalToIso('2026-03-15T09:30', '')
  assert.equal(isoToZonedLocal(local, ''), '2026-03-15T09:30')
  assert.match(formatScheduleTime('2026-10-01T10:00:00Z', 'en', 'UTC'), /10:00/)
  assert.equal(formatScheduleTime('', 'en', 'UTC'), '')
})

test('a match card line composes court, time mode and queue place', () => {
  const courtsById = { c1: { id: 'c1', name: 'Court 1' } }
  const opts = { courtsById, t, locale: 'en', timeZone: 'UTC' }
  assert.match(scheduleSummary(row('m', 'draft', { court_id: 'c1', scheduled_at: '2026-10-01T10:00:00Z', time_kind: 'fixed' }), opts), /^Court 1 · .*10:00$/)
  assert.match(scheduleSummary(row('m', 'draft', { scheduled_at: '2026-10-01T10:00:00Z', time_kind: 'not_before' }), opts), /^schedule\.notBefore:\{"time":".*10:00"\}$/)
  assert.equal(scheduleSummary(row('m', 'draft', { court_id: 'c1', queue_order: 2 }), opts), 'Court 1 · schedule.queueLabel:{"n":2}')
  assert.equal(scheduleSummary(row('m', 'draft', { court_id: 'missing', queue_order: 1 }), opts), 'schedule.queueLabel:{"n":1}')
  assert.equal(scheduleSummary(null, opts), '')
  const label = id => ({ x: 'A — B' })[id] || ''
  assert.equal(conflictText({ kind: 'rest_short', severity: 'soft', match_id: 'x', minutes: 30 }, t, label), 'schedule.kinds.rest_short:{"match":"A — B","minutes":30}')
  assert.equal(conflictText({ kind: 'match_live', severity: 'hard' }, t, label), 'schedule.kinds.match_live:{"match":"","minutes":""}')
  assert.equal(hasHardConflict([{ severity: 'soft' }]), false)
  assert.equal(hasHardConflict([{ severity: 'soft' }, { severity: 'hard' }]), true)
})

test('sorting by time puts timed matches first, then court queues, then unscheduled ones', () => {
  const timed = row('a', 'draft', { scheduled_at: '2026-10-01T12:00:00Z', time_kind: 'fixed' })
  const earlier = row('b', 'draft', { scheduled_at: '2026-10-01T09:00:00Z', time_kind: 'not_before' })
  const queued = row('c', 'draft', { court_id: 'c1', queue_order: 2 })
  const first = row('d', 'draft', { court_id: 'c1', queue_order: 1 })
  const order = [null, queued, timed, first, earlier].sort(compareBySchedule).map(r => r?.match_id ?? null)
  assert.deepEqual(order, ['b', 'a', 'd', 'c', null])
})

test('realtime events for courts and schedule rows are scoped by tournament like other tables', () => {
  const state = { entries: [], matches: [], sets: [], live: [], groups: [] }
  for (const table of ['courts', 'match_schedule']) {
    assert.equal(isTournamentEvent({ table, eventType: 'INSERT', new: { id: 'x', tournament_id: 't' } }, 't', state), true)
    assert.equal(isTournamentEvent({ table, eventType: 'UPDATE', new: { id: 'x', tournament_id: 'other' } }, 't', state), false)
    assert.equal(isTournamentEvent({ table, eventType: 'DELETE', old: { id: 'x', tournament_id: 't' } }, 't', state), true)
    assert.equal(isTournamentEvent({ table, eventType: 'DELETE', old: { id: 'x', tournament_id: 'other' } }, 't', state), false)
  }
})

test('RU, EN and LT schedule messages share the same key set and placeholders', () => {
  const keys = obj => Object.entries(obj).flatMap(([k, v]) => typeof v === 'object' ? keys(v).map(s => `${k}.${s}`) : [k]).sort()
  const ru = keys(scheduleMessages.ru)
  assert.ok(ru.length > 50)
  assert.deepEqual(keys(scheduleMessages.en), ru)
  assert.deepEqual(keys(scheduleMessages.lt), ru)
  for (const locale of ['ru', 'en', 'lt']) {
    assert.match(scheduleMessages[locale].kinds.rest_short, /\{minutes\}.*\{match\}/)
    assert.match(scheduleMessages[locale].queueLabel, /\{n\}/)
    assert.match(scheduleMessages[locale].notBefore, /\{time\}/)
  }
})
