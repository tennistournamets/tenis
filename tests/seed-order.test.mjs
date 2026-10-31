import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeOrder, moveIndex, moveToPosition, parsePosition, registrationOrder } from '../src/lib/seedOrder.js'
import { seedEditorMessages } from '../src/i18n/seedEditor.js'

const base = ['a', 'b', 'c', 'd', 'e']

test('typing a place moves the entry there and clamps to the list', () => {
  assert.deepEqual(moveToPosition(base, 'e', 1), ['e', 'a', 'b', 'c', 'd'])
  assert.deepEqual(moveToPosition(base, 'a', 3), ['b', 'c', 'a', 'd', 'e'])
  assert.deepEqual(moveToPosition(base, 'b', 99), ['a', 'c', 'd', 'e', 'b'])
  assert.deepEqual(moveToPosition(base, 'c', 0), ['c', 'a', 'b', 'd', 'e'])
  assert.deepEqual(moveToPosition(base, 'zz', 1), base)
  assert.deepEqual(base, ['a', 'b', 'c', 'd', 'e'], 'input is not mutated')
})

test('dragging and arrow keys move by index', () => {
  assert.deepEqual(moveIndex(base, 0, 2), ['b', 'c', 'a', 'd', 'e'])
  assert.deepEqual(moveIndex(base, 4, 0), ['e', 'a', 'b', 'c', 'd'])
  assert.deepEqual(moveIndex(base, 1, -1), ['b', 'a', 'c', 'd', 'e'])
  assert.deepEqual(moveIndex(base, 3, 3), base)
})

test('"№" accepts whole numbers from 1', () => {
  assert.equal(parsePosition(' 3 '), 3)
  assert.equal(parsePosition('0'), null)
  assert.equal(parsePosition('2.5'), null)
  assert.equal(parsePosition('abc'), null)
  assert.equal(parsePosition(''), null)
})

test('registration order and live changes of the field', () => {
  const entries = [
    { id: 'x', created_at: '2026-10-31T10:00:02Z' },
    { id: 'b', created_at: '2026-10-31T10:00:01Z' },
    { id: 'a', created_at: '2026-10-31T10:00:01Z' },
  ]
  assert.deepEqual(registrationOrder(entries), ['a', 'b', 'x'])
  // 'c' withdrew, 'f' was approved meanwhile: the draft keeps its order.
  assert.deepEqual(mergeOrder(['c', 'a', 'b'], ['a', 'b', 'f']), ['a', 'b', 'f'])
})

test('seed editor texts exist in RU, EN and LT', () => {
  const keys = o => Object.keys(o).sort()
  assert.deepEqual(keys(seedEditorMessages.en), keys(seedEditorMessages.ru))
  assert.deepEqual(keys(seedEditorMessages.lt), keys(seedEditorMessages.ru))
})
