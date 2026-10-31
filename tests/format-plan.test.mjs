import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bracketPlan, groupCountOptions, groupPlan, roundRobinPlan } from '../src/lib/formatPlan.js'

test('round robin of 16 is 120 matches in 15 rounds; odd fields need a round per player', () => {
  assert.deepEqual(roundRobinPlan(16), { n: 16, matches: 120, rounds: 15 })
  assert.deepEqual(roundRobinPlan(5), { n: 5, matches: 10, rounds: 5 })
  assert.deepEqual(roundRobinPlan(1), { n: 1, matches: 0, rounds: 0 })
})

test('groups split the field evenly and count their all-play-all matches', () => {
  const plan = groupPlan(16, 2)
  assert.deepEqual(plan.sizes, [8, 8])
  assert.equal(plan.matches, 56)
  assert.equal(plan.qualifiers, 4)
  assert.deepEqual(groupPlan(10, 3).sizes, [4, 3, 3])
  assert.deepEqual(groupCountOptions(16), [2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(groupCountOptions(5), [2])
})

test('brackets round up to a power of two; double elimination takes any count with BYEs', () => {
  assert.deepEqual(bracketPlan(16, 'double_elimination'), { n: 16, size: 16, rounds: 4, byes: 0, upper: 15, lower: 14, final: 1, valid: true })
  // 12 entries in 16 lines: 4 BYEs; the games played are 2n-2 = 22 (11 upper, 10 lower, 1 final).
  assert.deepEqual(bracketPlan(12, 'double_elimination'), { n: 12, size: 16, rounds: 4, byes: 4, upper: 11, lower: 10, final: 1, valid: true })
  assert.deepEqual([6, 1].map(n => { const p = bracketPlan(n, 'double_elimination'); return [p.valid, p.upper, p.lower, p.final] }), [[true, 5, 4, 1], [false, 0, 0, 0]])
  assert.equal(bracketPlan(2, 'double_elimination').valid, true)
  assert.deepEqual(bracketPlan(2, 'double_elimination'), { n: 2, size: 2, rounds: 1, byes: 0, upper: 1, lower: 0, final: 1, valid: true })
  assert.deepEqual(bracketPlan(12), { n: 12, size: 16, rounds: 4, byes: 4, matches: 11, valid: true })
})
