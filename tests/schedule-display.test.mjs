import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyScheduleAction, blocksPublish, compareBySchedule, conflictText, draftDiff, effectiveSchedule, formatScheduleTime,
  hasHardConflict, indexSchedule, isoToZonedLocal, reorderQueue, scheduleDropAction, scheduleError, scheduleLocked,
  scheduleSummary, splitCourtColumn, zonedLocalToIso, zoneOffsetMs,
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
  assert.equal(scheduleError('Not allowed', t), 'serverErrors.notAllowed')
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
  // m3 was removed from the draft: organizers must not see its old court.
  assert.equal(effectiveSchedule(rows, true).m3, undefined)
  assert.equal(effectiveSchedule(rows, false).m3.queue_order, 2)
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

test('a finished or live match keeps its schedule without blocking publication', () => {
  // publish_schedule ignores exactly these two kinds; assigning still refuses
  // them, which is why hasHardConflict and blocksPublish stay separate.
  assert.equal(blocksPublish({ kind: 'match_finished', severity: 'hard' }), false)
  assert.equal(blocksPublish({ kind: 'match_live', severity: 'hard' }), false)
  assert.equal(blocksPublish({ kind: 'court_busy', severity: 'hard' }), true)
  assert.equal(blocksPublish({ kind: 'participant_busy', severity: 'hard' }), true)
  assert.equal(blocksPublish({ kind: 'queue_taken', severity: 'hard' }), true)
  assert.equal(blocksPublish({ kind: 'rest_short', severity: 'soft' }), false)
  assert.equal(blocksPublish({ kind: 'order_violation', severity: 'soft' }), false)
  // A draft whose only hard conflicts are finished matches still publishes.
  const draft = [{ match_id: 'm1', conflicts: [{ kind: 'match_finished', severity: 'hard' }] },
    { match_id: 'm2', conflicts: [{ kind: 'rest_short', severity: 'soft' }] }]
  assert.equal(draft.some(c => c.conflicts.some(blocksPublish)), false)
  assert.equal(hasHardConflict(draft[0].conflicts), true)
})

test('a court column splits into the timed head and the numbered queue', () => {
  const draft = {
    timed: { queue_order: null, scheduled_at: '2026-10-01T10:00:00Z', time_kind: 'fixed' },
    bare: { queue_order: null, court_id: 'c1' },
    q2: { queue_order: 2 },
    q1: { queue_order: 1 },
  }
  const columnIds = ['timed', 'bare', 'q2', 'q1']
  assert.deepEqual(splitCourtColumn(columnIds, draft), { head: ['timed', 'bare'], queue: ['q1', 'q2'] })
  assert.deepEqual(columnIds, ['timed', 'bare', 'q2', 'q1'], 'input is not mutated')
  assert.deepEqual(splitCourtColumn([], {}), { head: [], queue: [] })
})

test('reordering a queue moves one id and never duplicates or drops the rest', () => {
  const queue = ['a', 'b', 'c']
  assert.deepEqual(reorderQueue(queue, 'c', 'a'), ['c', 'a', 'b'])
  assert.deepEqual(reorderQueue(queue, 'a', 'c'), ['b', 'a', 'c'])
  assert.deepEqual(reorderQueue(queue, 'a', null), ['b', 'c', 'a'])
  assert.deepEqual(reorderQueue(queue, 'd', 'b'), ['a', 'd', 'b', 'c'])
  assert.deepEqual(reorderQueue(queue, 'd', null), ['a', 'b', 'c', 'd'])
  assert.deepEqual(reorderQueue(queue, 'd', 'missing'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(reorderQueue(queue, 'b', 'c'), ['a', 'b', 'c'], 'dropping before the next card changes nothing')
  assert.deepEqual(queue, ['a', 'b', 'c'], 'input is not mutated')
})

test('one drop yields at most one write, and a timed match keeps its time without a queue number', () => {
  const draftByMatch = { q1: { court_id: 'c1', queue_order: 1 }, q2: { court_id: 'c1', queue_order: 2 } }
  const columnIds = ['q1', 'q2']
  const onCourt = extra => ({ targetKey: 'c1', columnIds, draftByMatch, ...extra })

  // Unassigned match joins the end of the queue.
  assert.deepEqual(scheduleDropAction(onCourt({ matchId: 'new' })),
    { kind: 'queue', matchId: 'new', courtId: 'c1', order: ['q1', 'q2', 'new'] })
  // Dropped in front of a card.
  assert.deepEqual(scheduleDropAction(onCourt({ matchId: 'new', beforeMatchId: 'q1' })),
    { kind: 'queue', matchId: 'new', courtId: 'c1', order: ['new', 'q1', 'q2'] })
  // Reorder inside the same court.
  assert.deepEqual(scheduleDropAction(onCourt({ matchId: 'q2', draftRow: draftByMatch.q2, beforeMatchId: 'q1' })),
    { kind: 'queue', matchId: 'q2', courtId: 'c1', order: ['q2', 'q1'] })
  // Same court, same place: no write at all.
  assert.equal(scheduleDropAction(onCourt({ matchId: 'q2', draftRow: draftByMatch.q2, beforeMatchId: null })), null)

  // A timed match keeps scheduled_at and time_kind and takes no queue number,
  // so it stays ahead of the queue; the drop index is ignored.
  const timed = { court_id: 'c2', scheduled_at: '2026-10-01T10:00:00Z', time_kind: 'fixed' }
  assert.deepEqual(scheduleDropAction(onCourt({ matchId: 'timed', draftRow: timed, beforeMatchId: 'q1' })),
    { kind: 'assign', matchId: 'timed', courtId: 'c1', scheduledAt: '2026-10-01T10:00:00Z', timeKind: 'fixed' })
  assert.equal(scheduleDropAction(onCourt({ matchId: 'timed', draftRow: { ...timed, court_id: 'c1' } })), null)

  // Unassigning.
  assert.deepEqual(scheduleDropAction({ matchId: 'q1', draftRow: draftByMatch.q1, targetKey: 'unassigned' }),
    { kind: 'clear', matchId: 'q1' })
  assert.equal(scheduleDropAction({ matchId: 'new', draftRow: null, targetKey: 'unassigned' }), null)

  // "Без корта" keeps the time and clears the court; an untimed row cannot live there.
  assert.deepEqual(scheduleDropAction({ matchId: 'timed', draftRow: { ...timed, court_id: 'c1' }, targetKey: 'none' }),
    { kind: 'assign', matchId: 'timed', courtId: null, scheduledAt: '2026-10-01T10:00:00Z', timeKind: 'fixed' })
  assert.equal(scheduleDropAction({ matchId: 'q1', draftRow: draftByMatch.q1, targetKey: 'none' }), null)

  // Finished and live matches are refused before the server sees them.
  assert.equal(scheduleDropAction(onCourt({ matchId: 'new', locked: true })), null)
  assert.equal(scheduleLocked({ status: 'finished' }, null), true)
  assert.equal(scheduleLocked({ status: 'in_progress' }, { status: 'active' }), true)
  assert.equal(scheduleLocked({ status: 'in_progress' }, { status: 'stopped' }), false)
  assert.equal(scheduleLocked({ status: 'in_progress' }, null), false)
})

test('a dropped card lands before the server answers, and the answer moves nothing', () => {
  const draft = (match_id, patch) => ({ id: `${match_id}-d`, match_id, state: 'draft',
    court_id: null, scheduled_at: null, time_kind: null, queue_order: null, ...patch })
  const queue = (rows, court) => rows.filter(r => r.state === 'draft' && r.court_id === court && r.queue_order)
    .sort((a, b) => a.queue_order - b.queue_order).map(r => [r.match_id, r.queue_order])
  const base = [
    draft('m1', { court_id: 'c1', queue_order: 1 }),
    draft('m2', { court_id: 'c1', queue_order: 2 }),
    draft('m3', { court_id: 'c1', queue_order: 3 }),
    row('m1', 'published', { court_id: 'c1', queue_order: 1 }),
  ]

  // Appending an unscheduled match numbers the column 1..N.
  const appended = applyScheduleAction(base, { kind: 'queue', matchId: 'm9', courtId: 'c1', order: ['m1', 'm2', 'm3', 'm9'] })
  assert.deepEqual(queue(appended, 'c1'), [['m1', 1], ['m2', 2], ['m3', 3], ['m9', 4]])
  assert.equal(appended.filter(r => r.state === 'published').length, 1, 'published rows are untouched')
  assert.deepEqual(queue(base, 'c1'), [['m1', 1], ['m2', 2], ['m3', 3]], 'the input is not mutated')

  // Reordering renumbers densely.
  assert.deepEqual(queue(applyScheduleAction(base, { kind: 'queue', matchId: 'm3', courtId: 'c1', order: ['m3', 'm1', 'm2'] }), 'c1'),
    [['m3', 1], ['m1', 2], ['m2', 3]])

  // Leaving a court closes the gap behind, exactly as the RPC does.
  const moved = applyScheduleAction(base, { kind: 'queue', matchId: 'm1', courtId: 'c2', order: ['m1'] })
  assert.deepEqual(queue(moved, 'c1'), [['m2', 1], ['m3', 2]])
  assert.deepEqual(queue(moved, 'c2'), [['m1', 1]])

  // A stale order keeps the rows it forgot, after the listed ones.
  assert.deepEqual(queue(applyScheduleAction(base, { kind: 'queue', matchId: 'm3', courtId: 'c1', order: ['m3'] }), 'c1'),
    [['m3', 1], ['m1', 2], ['m2', 3]])

  // A timed match keeps its time, takes no queue number, and frees its old court.
  const timed = applyScheduleAction(base, { kind: 'assign', matchId: 'm1', courtId: 'c2', scheduledAt: '2026-10-01T10:00:00Z', timeKind: 'fixed' })
  const row1 = timed.find(r => r.state === 'draft' && r.match_id === 'm1')
  assert.deepEqual([row1.court_id, row1.queue_order, row1.scheduled_at, row1.time_kind],
    ['c2', null, '2026-10-01T10:00:00Z', 'fixed'])
  assert.deepEqual(queue(timed, 'c1'), [['m2', 1], ['m3', 2]])

  // Clearing drops the draft row and compacts the court it left.
  const cleared = applyScheduleAction(base, { kind: 'clear', matchId: 'm2' })
  assert.equal(cleared.some(r => r.state === 'draft' && r.match_id === 'm2'), false)
  assert.deepEqual(queue(cleared, 'c1'), [['m1', 1], ['m3', 2]])

  assert.equal(applyScheduleAction(base, null), base)
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

test('a court queue may not put a match before the match that feeds it', async () => {
  const { queueOrderConflicts, mergeConflicts } = await import('../src/lib/schedule.js')
  const matches = [{ id: 'sf1', next_match_id: 'f' }, { id: 'sf2', next_match_id: 'f' }, { id: 'f' }]
  const draft = { f: { court_id: 'c5', queue_order: 1 }, sf1: { court_id: 'c5', queue_order: 2 }, sf2: { court_id: 'c4', queue_order: 3 } }
  assert.deepEqual(queueOrderConflicts(matches, draft), [{ match_id: 'f', conflicts: [{ kind: 'order_violation', severity: 'soft', match_id: 'sf1' }] }])
  assert.deepEqual(queueOrderConflicts(matches, { ...draft, f: { court_id: 'c5', queue_order: 3 } }), [])
  const merged = mergeConflicts([{ match_id: 'f', conflicts: [{ kind: 'order_violation', severity: 'soft', match_id: 'sf1' }] }],
    queueOrderConflicts(matches, draft))
  assert.equal(merged.length, 1)
  assert.equal(merged[0].conflicts.length, 1)
})
