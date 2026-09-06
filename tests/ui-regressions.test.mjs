import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyTournamentLink, tournamentShareUrl } from '../src/lib/shareLink.js'
import { displaySides } from '../src/lib/liveSides.js'
import { scoreLine } from '../src/lib/useTennisScoring.js'

test('copy waits for clipboard confirmation and preserves the encoded public URL', async t => {
  let resolve, written
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    clipboard: { writeText(url) { written = url; return new Promise(r => { resolve = r }) } },
  } })
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator)
  let completed = false
  const pending = copyTournamentLink('cup / 2026').then(url => { completed = true; return url })
  await Promise.resolve()
  assert.equal(completed, false)
  resolve()
  assert.equal(await pending, '/tournaments/cup%20%2F%202026')
  assert.equal(written, tournamentShareUrl('cup / 2026'))
})

test('missing and rejected clipboard APIs never report successful copying', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  t.after(() => original ? Object.defineProperty(globalThis, 'navigator', original) : delete globalThis.navigator)
  for (const navigator of [undefined, {}, { clipboard: {} }, { clipboard: { writeText: async () => { throw new Error('denied') } } }]) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator })
    await assert.rejects(copyTournamentLink('test'), /unavailable|denied/)
  }
})

test('saved court orientation restores both flags independently of automatic changeovers', () => {
  for (const swapped of [false, true]) for (const auto of [false, true]) for (const changeover of [false, true]) {
    assert.deepEqual(displaySides({ sides_swapped: swapped, sides_auto: auto }, {}, changeover),
      swapped !== (auto && changeover) ? ['b', 'a'] : ['a', 'b'])
  }
})

test('ordinary final sets appear once for either winner in best of three and five', () => {
  for (const winner of ['a', 'b']) for (const requiredSets of [2, 3]) {
    const sets = Array.from({ length: requiredSets }, (_, i) => ({ set_index: i + 1,
      side_a_games: winner === 'a' ? 6 : 0, side_b_games: winner === 'b' ? 6 : 0 }))
    const state = { sets, winner, requiredSets, games: winner === 'a' ? { a: 6, b: 0 } : { a: 0, b: 6 } }
    assert.equal(scoreLine(state), Array(requiredSets).fill(winner === 'a' ? '6:0' : '0:6').join(' · '))
    assert.equal(scoreLine({ ...state, winner: null }).split(' · ').length, requiredSets + 1)
  }
})
