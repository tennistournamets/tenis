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

test('brackets round up to a power of two; double elimination needs one exactly', () => {
  assert.deepEqual(bracketPlan(16, 'double_elimination'), { n: 16, size: 16, rounds: 4, byes: 0, upper: 15, lower: 14, final: 1, valid: true })
  assert.equal(bracketPlan(12, 'double_elimination').valid, false)
  assert.deepEqual(bracketPlan(12), { n: 12, size: 16, rounds: 4, byes: 4, matches: 11, valid: true })
})
