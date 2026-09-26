import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('switching admin tabs keeps the router history.state', () => {
  const source = readFileSync(new URL('../src/views/AdminTournamentView.vue', import.meta.url), 'utf8')
  assert.ok(!/history\.replaceState\(null/.test(source))
  assert.match(source, /history\.replaceState\(\{ \.\.\.\(history\.state \|\| \{\}\), current: url \}, '', url\)/)
})
