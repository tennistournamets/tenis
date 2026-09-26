import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('live score rows and "who won the point" buttons share one order after a change of ends', () => {
  const source = readFileSync(new URL('../src/components/LiveScoringModal.vue', import.meta.url), 'utf8')
  const rows = /class="live-board"[\s\S]*?v-for="side in (\w+|\[[^\]]+\])"/.exec(source)?.[1]
  const buttons = /class="live-tap-zones"[\s\S]*?v-for="side in (\w+|\[[^\]]+\])"/.exec(source)?.[1]
  assert.equal(rows, 'sides')
  assert.equal(buttons, 'sides')
  assert.match(source, /const sides = computed\(\(\) => \(displaySwapped\.value \? \['b', 'a'\] : \['a', 'b'\]\)\)/)
})
