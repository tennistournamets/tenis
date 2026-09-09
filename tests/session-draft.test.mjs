import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  clearSessionDraft,
  readSessionDraft,
  userDraftKey,
  writeSessionDraft,
} from '../src/lib/sessionDraft.js'

class MemoryStorage {
  values = new Map()
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
afterEach(() => {
  if (originalDescriptor) Object.defineProperty(globalThis, 'sessionStorage', originalDescriptor)
  else delete globalThis.sessionStorage
})

function useStorage() {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  return storage
}

test('session drafts are versioned, isolated by user and removable after save or discard', () => {
  useStorage()
  const first = userDraftKey('create-tournament', 'user-a')
  const second = userDraftKey('create-tournament', 'user-b')

  assert.notEqual(first, second)
  assert.equal(writeSessionDraft(first, { step: 3, form: { name: 'Autumn Cup' } }), true)
  assert.deepEqual(readSessionDraft(first), { step: 3, form: { name: 'Autumn Cup' } })
  assert.equal(readSessionDraft(second), null)

  clearSessionDraft(first)
  assert.equal(readSessionDraft(first), null)
})

test('corrupt and obsolete session values are ignored without breaking the form', () => {
  const storage = useStorage()
  storage.setItem('broken', '{')
  storage.setItem('old', JSON.stringify({ version: 0, value: { secret: true } }))
  storage.setItem('empty', JSON.stringify({ version: 1, value: null }))

  assert.equal(readSessionDraft('broken'), null)
  assert.equal(storage.getItem('broken'), null)
  assert.equal(readSessionDraft('old'), null)
  assert.equal(readSessionDraft('empty'), null)
})
