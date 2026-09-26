import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isByeMatch, isFedMatch, swapDraftSlots } from '../src/lib/bracketDisplay.js'

// Five players after a seeded draw: 1 v BYE, 4 v 5, 2 v BYE, 3 v BYE.
function fivePlayers() {
  const m = (id, round, a, b, next, slot) => ({ id, round_number: round, side_a_entry_id: a, side_b_entry_id: b,
    winner_entry_id: a && b ? null : a || b, status: a && b ? 'ready' : a || b ? (round === 1 ? 'finished' : 'pending') : 'pending',
    next_match_id: next, next_slot: slot })
  return [
    m('r1-1', 1, 's1', null, 'r2-1', 'A'), m('r1-2', 1, 's4', 's5', 'r2-1', 'B'),
    m('r1-3', 1, 's2', null, 'r2-2', 'A'), m('r1-4', 1, 's3', null, 'r2-2', 'B'),
    { ...m('r2-1', 2, 's1', null, 'f', 'A'), winner_entry_id: null }, { ...m('r2-2', 2, 's2', 's3', 'f', 'B') },
    { ...m('f', 3, null, null, null, null) },
  ]
}
const byId = (rows, id) => rows.find(r => r.id === id)

test('a BYE player swapped into a full match hands the free pass to the player moved out', () => {
  const rows = fivePlayers()
  assert.equal(swapDraftSlots(rows, { fromMatchId: 'r1-1', fromSide: 'a', toMatchId: 'r1-2', toSide: 'b' }), 'ok')
  assert.deepEqual([byId(rows, 'r1-1').side_a_entry_id, byId(rows, 'r1-1').side_b_entry_id], ['s5', null])
  assert.ok(isByeMatch(byId(rows, 'r1-1')))
  assert.equal(byId(rows, 'r1-2').status, 'ready')
  assert.equal(byId(rows, 'r1-2').winner_entry_id, null)
  assert.equal(byId(rows, 'r2-1').side_a_entry_id, 's5')
  assert.equal(byId(rows, 'r2-1').status, 'pending')
})

test('two BYEs feeding one match swap players and the waiting match follows', () => {
  const rows = fivePlayers()
  assert.equal(swapDraftSlots(rows, { fromMatchId: 'r1-3', fromSide: 'a', toMatchId: 'r1-4', toSide: 'a' }), 'ok')
  assert.deepEqual([byId(rows, 'r2-2').side_a_entry_id, byId(rows, 'r2-2').side_b_entry_id], ['s3', 's2'])
  assert.equal(byId(rows, 'r2-2').status, 'ready')
})

test('fed matches and emptied matches are refused without changes', () => {
  const rows = fivePlayers()
  const before = structuredClone(rows)
  assert.equal(swapDraftSlots(rows, { fromMatchId: 'r1-2', fromSide: 'a', toMatchId: 'r2-1', toSide: 'b' }), 'locked')
  assert.equal(swapDraftSlots(rows, { fromMatchId: 'r1-1', fromSide: 'a', toMatchId: 'r1-3', toSide: 'b' }), 'empty')
  assert.equal(swapDraftSlots(rows, { fromMatchId: 'r1-2', fromSide: 'a', toMatchId: 'r1-2', toSide: 'a' }), 'noop')
  assert.deepEqual(rows, before)
  assert.ok(isFedMatch(rows, 'r2-1'))
  assert.ok(!isFedMatch(rows, 'r1-1'))
})

test('a lower-bracket match is fed by loser routing and stays locked', () => {
  const rows = [
    { id: 'w1', side_a_entry_id: 'p1', side_b_entry_id: 'p2', status: 'ready', next_match_id: 'w2', next_slot: 'A', loser_next_match_id: 'l1', loser_next_slot: 'A' },
    { id: 'l1', side_a_entry_id: null, side_b_entry_id: null, status: 'pending', next_match_id: null },
  ]
  assert.equal(swapDraftSlots(rows, { fromMatchId: 'w1', fromSide: 'a', toMatchId: 'l1', toSide: 'a' }), 'locked')
})
