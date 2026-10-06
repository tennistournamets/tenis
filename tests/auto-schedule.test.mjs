import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isValidMatchMinutes, planSchedule, planShift } from '../src/lib/autoSchedule.js'

const START = '2026-10-10T10:00:00.000Z'
const at = (hhmm, day = '2026-10-10') => `${day}T${hhmm}:00.000Z`
const courts = n => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, sort_order: i + 1 }))
const match = (id, patch = {}) => ({
  id, stage: 'main', round_number: 1, match_number: 1, status: 'pending', group_id: null,
  side_a_entry_id: `${id}-a`, side_b_entry_id: `${id}-b`, next_match_id: null, loser_next_match_id: null, ...patch,
})

/** Single elimination for 8: r1 m1..m4 → r2 s1, s2 → final. */
function eight() {
  const r1 = [1, 2, 3, 4].map(n => match(`r1m${n}`, { match_number: n, next_match_id: n <= 2 ? 's1' : 's2' }))
  const semis = [1, 2].map(n => match(`s${n}`, { round_number: 2, match_number: n, side_a_entry_id: null, side_b_entry_id: null, next_match_id: 'f' }))
  const final = match('f', { round_number: 3, side_a_entry_id: null, side_b_entry_id: null })
  return [...r1, ...semis, final]
}
const plan = (input) => planSchedule({ tournament: { format: 'single_elimination' }, startAt: START, matchMinutes: 90, now: START, ...input })
const byMatch = result => Object.fromEntries(result.rows.map(r => [r.match_id, r]))
const slot = row => [row.court_id, row.scheduled_at.slice(11, 16), row.queue_order]

test('a bracket fills the courts round by round; a round waits for the matches that feed it', () => {
  const result = plan({ matches: eight(), courts: courts(2) })
  assert.equal(result.ok, true)
  const rows = byMatch(result)
  assert.deepEqual(slot(rows.r1m1), ['c1', '10:00', 1])
  assert.deepEqual(slot(rows.r1m2), ['c2', '10:00', 1])
  assert.deepEqual(slot(rows.r1m3), ['c1', '11:30', 2])
  assert.deepEqual(slot(rows.r1m4), ['c2', '11:30', 2])
  assert.deepEqual(slot(rows.s1), ['c1', '13:00', 3])
  assert.deepEqual(slot(rows.s2), ['c2', '13:00', 3])
  assert.deepEqual(slot(rows.f), ['c1', '14:30', 4])
  assert.ok(result.rows.every(r => r.time_kind === 'not_before'))
  assert.equal(result.planned, 7)
  assert.equal(result.endsAt, at('16:00'))
})

test('minimum rest delays the next round, not the courts', () => {
  const rows = byMatch(plan({ matches: eight(), courts: courts(4), restMinutes: 30 }))
  assert.equal(rows.r1m4.scheduled_at, at('10:00'))
  assert.equal(rows.s1.scheduled_at, at('12:00'))
  assert.equal(rows.f.scheduled_at, at('14:00'))
})

test('times start from now when the start is past and are rounded up to five minutes', () => {
  const rows = byMatch(plan({ matches: eight(), courts: courts(4), now: '2026-10-10T12:41:10.000Z' }))
  assert.equal(rows.r1m1.scheduled_at, at('12:45'))
  const odd = byMatch(plan({ matches: eight(), courts: courts(4), matchMinutes: 37 }))
  assert.equal(odd.s1.scheduled_at, at('10:40'))
})

test('a recalculation keeps played and live matches and plans the rest from now', () => {
  const ms = eight()
  ms[0].status = 'finished'; ms[1].status = 'finished'
  ms[4].side_a_entry_id = 'r1m1-a'; ms[4].side_b_entry_id = 'r1m2-b'
  const draft = {
    r1m1: { court_id: 'c1', queue_order: 1, scheduled_at: at('10:00'), time_kind: 'not_before' },
    r1m2: { court_id: 'c2', queue_order: 1, scheduled_at: at('10:00'), time_kind: 'not_before' },
    r1m3: { court_id: 'c1', queue_order: 2, scheduled_at: at('11:30'), time_kind: 'not_before' },
  }
  const live = [{ match_id: 'r1m3', status: 'active', created_at: at('11:50') }]
  const result = plan({ matches: ms, courts: courts(2), draft, live, now: at('12:00') })
  const rows = byMatch(result)
  assert.equal(rows.r1m1, undefined)
  assert.equal(rows.r1m3, undefined, 'a live match keeps its row')
  // c1 is busy with the live match until 13:20 (its start + 90 min); c2 is free from now.
  assert.deepEqual(slot(rows.r1m4), ['c2', '12:00', 2])
  assert.deepEqual(slot(rows.s1), ['c1', '13:20', 3], 'right after the live match, queue after its place')
  assert.deepEqual(slot(rows.s2), ['c2', '13:30', 3], 'waits for the live match and r1m4')
  assert.equal(rows.f.scheduled_at, at('15:00'))
})

test('a match pinned to an exact time stays and blocks its court', () => {
  const draft = { r1m2: { court_id: 'c1', queue_order: 5, scheduled_at: at('10:30'), time_kind: 'fixed' } }
  const result = plan({ matches: eight(), courts: courts(1), draft })
  const rows = byMatch(result)
  assert.deepEqual(slot(rows.r1m2), ['c1', '10:30', 1])
  assert.equal(rows.r1m2.time_kind, 'fixed')
  assert.deepEqual(slot(rows.r1m1), ['c1', '12:00', 2], 'no 90-minute gap before 10:30')
  assert.equal(result.kept, 1)
  assert.equal(result.planned, 6)
})

test('byes, empty courts and bad input', () => {
  const ms = [match('m1'), match('m2', { match_number: 2, side_b_entry_id: null })]
  const result = plan({ matches: ms, courts: courts(1) })
  assert.deepEqual(result.skipped, ['m2'])
  assert.deepEqual(result.rows.map(r => r.match_id), ['m1'])
  assert.deepEqual(plan({ matches: ms, courts: [] }), { ok: false, error: 'noCourts' })
  assert.deepEqual(plan({ matches: ms, courts: courts(2), courtIds: ['nope'] }), { ok: false, error: 'noCourts' })
  assert.deepEqual(plan({ matches: ms, courts: courts(2), courtIds: [] }), { ok: false, error: 'noCourts' }, 'nothing ticked means no court')
  assert.deepEqual(plan({ matches: ms, courts: courts(1), matchMinutes: 0 }), { ok: false, error: 'invalidDuration' })
  assert.deepEqual(plan({ matches: ms, courts: courts(1), startAt: 'soon' }), { ok: false, error: 'invalidStart' })
  assert.equal(isValidMatchMinutes(90), true)
  assert.equal(isValidMatchMinutes(4), false)
  assert.equal(isValidMatchMinutes(1.5), false)
})

test('only the chosen courts are used and queue numbers continue after played matches', () => {
  const ms = [match('done', { status: 'finished' }), match('m1'), match('m2', { match_number: 2 })]
  const draft = { done: { court_id: 'c2', queue_order: 4, scheduled_at: at('09:00'), time_kind: 'fixed' } }
  const rows = byMatch(plan({ matches: ms, courts: courts(3), courtIds: ['c2'], draft }))
  assert.deepEqual(slot(rows.m1), ['c2', '10:00', 5])
  assert.deepEqual(slot(rows.m2), ['c2', '11:30', 6])
})

test('round robin only waits for the players, not for the whole round', () => {
  // 4 players, circle method: r1 (1-4, 2-3), r2 (1-3, 4-2), r3 (1-2, 3-4).
  const rr = [[1, 4], [2, 3], [1, 3], [4, 2], [1, 2], [3, 4]].map(([a, b], i) =>
    match(`g${i}`, { round_number: Math.floor(i / 2) + 1, match_number: (i % 2) + 1, side_a_entry_id: `p${a}`, side_b_entry_id: `p${b}` }))
  const rows = byMatch(planSchedule({ tournament: { format: 'round_robin' }, matches: rr, courts: courts(3), startAt: START, matchMinutes: 60, now: START }))
  assert.equal(rows.g0.scheduled_at, at('10:00'))
  assert.equal(rows.g1.scheduled_at, at('10:00'))
  assert.equal(rows.g2.scheduled_at, at('11:00'))
  assert.equal(rows.g5.scheduled_at, at('12:00'))
})

test('points formats play round by round; the partners count as players', () => {
  const am = [
    match('a1', { round_number: 1, match_number: 1, side_a_entry_id: 'p1', side_a2_entry_id: 'p2', side_b_entry_id: 'p3', side_b2_entry_id: 'p4' }),
    match('a2', { round_number: 1, match_number: 2, side_a_entry_id: 'p5', side_a2_entry_id: 'p6', side_b_entry_id: 'p7', side_b2_entry_id: 'p8' }),
    match('b1', { round_number: 2, match_number: 1, side_a_entry_id: 'p1', side_a2_entry_id: 'p5', side_b_entry_id: 'p9', side_b2_entry_id: 'p10' }),
  ]
  const rows = byMatch(planSchedule({ tournament: { format: 'americano' }, matches: am, courts: courts(3), startAt: START, matchMinutes: 20, now: START }))
  assert.equal(rows.a1.scheduled_at, at('10:00'))
  assert.equal(rows.a2.scheduled_at, at('10:00'))
  assert.equal(rows.b1.scheduled_at, at('10:20'), 'third court is free, but the round waits')
})

test('a group playoff starts after every group match', () => {
  const ms = [
    match('g1', { stage: 'group', group_id: 'A' }),
    match('g2', { stage: 'group', group_id: 'B', round_number: 2 }),
    match('k1', { stage: 'winners', side_a_entry_id: null, side_b_entry_id: null }),
  ]
  const rows = byMatch(planSchedule({ tournament: { format: 'groups_playoff' }, matches: ms, courts: courts(3), groups: [{ id: 'A', group_index: 0 }, { id: 'B', group_index: 1 }], startAt: START, matchMinutes: 60, now: START }))
  assert.equal(rows.g2.scheduled_at, at('10:00'))
  assert.equal(rows.k1.scheduled_at, at('11:00'))
})

test('double elimination: the losers bracket waits for the losers it receives', () => {
  const ms = [
    match('w1', { stage: 'winners', next_match_id: 'w3', loser_next_match_id: 'l1' }),
    match('w2', { stage: 'winners', match_number: 2, next_match_id: 'w3', loser_next_match_id: 'l1' }),
    match('w3', { stage: 'winners', round_number: 2, side_a_entry_id: null, side_b_entry_id: null, next_match_id: 'gf', loser_next_match_id: 'l2' }),
    match('l1', { stage: 'losers', side_a_entry_id: null, side_b_entry_id: null, next_match_id: 'l2' }),
    match('l2', { stage: 'losers', round_number: 2, side_a_entry_id: null, side_b_entry_id: null, next_match_id: 'gf' }),
    match('gf', { stage: 'grand_final', round_number: 3, side_a_entry_id: null, side_b_entry_id: null }),
  ]
  const rows = byMatch(planSchedule({ tournament: { format: 'double_elimination' }, matches: ms, courts: courts(2), startAt: START, matchMinutes: 60, now: START }))
  assert.equal(rows.w1.scheduled_at, at('10:00'))
  assert.equal(rows.w3.scheduled_at, at('11:00'))
  assert.equal(rows.l1.scheduled_at, at('11:00'))
  assert.equal(rows.l2.scheduled_at, at('12:00'))
  assert.equal(rows.gf.scheduled_at, at('13:00'))
})

test('planShift counts moved matches and the largest delay', () => {
  const draft = {
    m1: { court_id: 'c1', scheduled_at: at('10:00') },
    m2: { court_id: 'c1', scheduled_at: at('11:00') },
    m3: { court_id: 'c1', scheduled_at: at('12:00') },
  }
  const rows = [
    { match_id: 'm1', court_id: 'c1', scheduled_at: at('10:00') },
    { match_id: 'm2', court_id: 'c1', scheduled_at: at('11:40') },
    { match_id: 'm3', court_id: 'c2', scheduled_at: at('12:00') },
    { match_id: 'm4', court_id: 'c2', scheduled_at: at('13:00') },
  ]
  assert.deepEqual(planShift(draft, rows), { moved: 2, maxDelayMinutes: 40 })
})
