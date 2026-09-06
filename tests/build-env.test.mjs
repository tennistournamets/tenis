import assert from 'node:assert/strict'
import { test } from 'node:test'
import config from '../vite.config.js'

test('build refuses private credentials under the public VITE_ prefix without printing their values', () => {
  const key = 'VITE_SUPABASE_DB_PASSWORD', previous = process.env[key]
  process.env[key] = 'synthetic-private-value'
  try {
    assert.throws(() => config({ mode: 'test' }), error =>
      error.message.includes(key) && !error.message.includes(process.env[key]))
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})
