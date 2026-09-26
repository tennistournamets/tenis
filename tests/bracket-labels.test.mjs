import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bracketRoundName, correctionMatchTitle } from '../src/lib/roundLabels.js'
import { readDrawMode, writeDrawMode } from '../src/lib/drawModePreference.js'

const t = (key, params = {}) => ({
  'bracket.final': 'Final',
  'bracket.semifinals': 'Semifinal',
  'bracket.quarterfinals': 'Quarterfinal',
  'bracket.roundN': `Round ${params.n}`,
  'bracket.fractionFinal': `1/${params.k}`,
  'mobile.matchStage.main': 'Bracket',
  'mobile.matchStage.winners': 'Upper bracket',
  'mobile.matchStage.losers': 'Lower bracket',
  'mobile.matchStage.grand_final': 'Grand final',
  'mobile.matchStage.group': 'Group',
}[key])

// Double elimination of 16: winners rounds 1–4, losers rounds 1–6, one grand final.
const de = [
  ...[8, 4, 2, 1].flatMap((n, r) => Array.from({ length: n }, (_, i) => ({ stage: 'winners', round_number: r + 1, match_number: i + 1 }))),
  ...[4, 4, 2, 2, 1, 1].flatMap((n, r) => Array.from({ length: n }, (_, i) => ({ stage: 'losers', round_number: r + 1, match_number: i + 1 }))),
  { stage: 'grand_final', round_number: 1, match_number: 1 },
]

test('lower-bracket columns are numbered; upper and single brackets count from the final', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(r => bracketRoundName('losers', r, 6, t)), ['Round 1', 'Round 2', 'Round 3', 'Round 4', 'Round 5', 'Round 6'])
  assert.deepEqual([1, 2, 3, 4].map(r => bracketRoundName('winners', r, 4, t)), ['1/8', 'Quarterfinal', 'Semifinal', 'Final'])
  assert.equal(bracketRoundName('main', 2, 3, t), 'Semifinal')
  assert.equal(bracketRoundName('grand_final', 1, 1, t), 'Final')
})

test('the correction preview names rounds like the bracket, with the stage only where it matters', () => {
  assert.equal(correctionMatchTitle({ stage: 'winners', round_number: 3, match_number: 1 }, de, t), 'Upper bracket · Semifinal · №1')
  assert.equal(correctionMatchTitle({ stage: 'losers', round_number: 2, match_number: 3 }, de, t), 'Lower bracket · Round 2 · №3')
  assert.equal(correctionMatchTitle({ stage: 'grand_final', round_number: 1, match_number: 1 }, de, t), 'Grand final')
  const se = [1, 1, 1, 1, 2, 2, 3].map((round_number, i) => ({ stage: 'main', round_number, match_number: i + 1 }))
  assert.equal(correctionMatchTitle({ stage: 'main', round_number: 2, match_number: 1 }, se, t), 'Semifinal · №1')
  // Group playoff: its knockout is stage "winners" without a lower bracket.
  const gp = [{ stage: 'group', round_number: 1001 }, { stage: 'winners', round_number: 1 }, { stage: 'winners', round_number: 2 }]
  assert.equal(correctionMatchTitle({ stage: 'winners', round_number: 2, match_number: 1 }, gp, t), 'Final · №1')
  assert.equal(correctionMatchTitle({ stage: 'group', round_number: 1002, match_number: 2 }, gp, t), 'Group · Round 2 · №2')
  // Without the bracket the round cannot be named from the final.
  assert.equal(correctionMatchTitle({ stage: 'main', round_number: 2, match_number: 1 }, [], t), 'Round 2 · №1')
})

test('the draw mode is remembered per tournament and survives broken storage', () => {
  const data = new Map()
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) }
  assert.equal(readDrawMode('t1', storage), 'auto-random')
  writeDrawMode('t1', 'manual', storage)
  writeDrawMode('t2', 'bogus', storage)
  assert.equal(readDrawMode('t1', storage), 'manual')
  assert.equal(readDrawMode('t2', storage), 'auto-random')
  const broken = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  assert.equal(readDrawMode('t1', broken), 'auto-random')
  assert.doesNotThrow(() => writeDrawMode('t1', 'manual', broken))
  assert.equal(readDrawMode('t1', null), 'auto-random')
})
