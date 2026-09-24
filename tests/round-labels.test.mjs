import assert from 'node:assert/strict'
import { test } from 'node:test'
import { knockoutTotals, matchRoundName } from '../src/lib/roundLabels.js'

const t = (key, params = {}) => ({
  'bracket.final': 'Final',
  'bracket.semifinals': 'Semifinal',
  'bracket.quarterfinals': 'Quarterfinal',
  'bracket.roundN': `Round ${params.n}`,
  'bracket.fractionFinal': `1/${params.k}`,
}[key])

// 16 players all-play-all: 15 rounds of 8 matches, stage 'main' like the DB stores them.
const roundRobin = Array.from({ length: 15 * 8 }, (_, i) => ({ stage: 'main', round_number: Math.floor(i / 8) + 1 }))

test('round-robin tours are numbered, never named as knockout fractions', () => {
  const totals = knockoutTotals(roundRobin, 'round_robin')
  assert.deepEqual(totals, {})
  for (let r = 1; r <= 15; r++) assert.equal(matchRoundName({ stage: 'main', round_number: r }, totals, t), `Round ${r}`)
})

test('single elimination keeps names counted from the final', () => {
  const bracket = [1, 1, 1, 1, 2, 2, 3].map(round_number => ({ stage: 'main', round_number }))
  const totals = knockoutTotals(bracket, 'single_elimination')
  assert.deepEqual([1, 2, 3].map(r => matchRoundName({ stage: 'main', round_number: r }, totals, t)),
    ['Quarterfinal', 'Semifinal', 'Final'])
})

test('group rounds stay ordinal inside groups_playoff', () => {
  const totals = knockoutTotals([{ stage: 'group', round_number: 3 }, { stage: 'winners', round_number: 2 }], 'groups_playoff')
  assert.equal(matchRoundName({ stage: 'group', round_number: 3 }, totals, t), 'Round 3')
  assert.equal(matchRoundName({ stage: 'winners', round_number: 2 }, totals, t), 'Final')
})
