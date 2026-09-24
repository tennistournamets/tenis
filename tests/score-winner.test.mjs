import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidedSets, hasMatchWinner, scoreRows } from '../src/lib/tennisRules.js'

const rows = (...sets) => scoreRows(sets.map(([a, b], i) => ({ set_index: i + 1, side_a_games: a, side_b_games: b })))

test('an unfinished first set is not a match result', () => {
  assert.equal(hasMatchWinner(rows([0, 1]), {}, 'best_of_3'), false)
  assert.deepEqual(decidedSets(rows([0, 1]), {}, 'best_of_3'), { a: 0, b: 0, required: 2 })
})

test('two won sets finish best of three, three finish best of five', () => {
  assert.equal(hasMatchWinner(rows([6, 4], [7, 6]), {}, 'best_of_3'), true)
  assert.equal(hasMatchWinner(rows([6, 4], [3, 6]), {}, 'best_of_3'), false)
  assert.equal(hasMatchWinner(rows([6, 4], [6, 3]), {}, 'best_of_5'), false)
})

test('a deciding match tie-break counts by its points', () => {
  const config = { tennis: { final_set_rule: 'match_tiebreak_10' } }
  const r = rows([6, 4], [3, 6])
  r[2].side_a_tiebreak = 10; r[2].side_b_tiebreak = 8
  assert.equal(hasMatchWinner(r, config, 'best_of_3'), true)
})

test('a 6:6 set with a finished tie-break is won and saved as 7:6', async () => {
  const { buildSetPayload } = await import('../src/lib/tennisRules.js')
  const r = rows([6, 4], [4, 6], [6, 6])
  r[2].side_a_tiebreak = 7; r[2].side_b_tiebreak = 5
  assert.equal(hasMatchWinner(r, {}, 'best_of_3'), true)
  const third = buildSetPayload(r, {}, 'best_of_3')[2]
  assert.deepEqual([third.side_a_games, third.side_b_games, third.side_a_tiebreak, third.side_b_tiebreak], [7, 6, 7, 5])
  // An unfinished tie-break keeps 6:6 and no winner.
  r[2].side_a_tiebreak = 6; r[2].side_b_tiebreak = 5
  assert.equal(hasMatchWinner(r, {}, 'best_of_3'), false)
  assert.deepEqual([buildSetPayload(r, {}, 'best_of_3')[2].side_a_games], [6])
})
