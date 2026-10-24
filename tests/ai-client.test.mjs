import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { lookup, makeT } from './helpers/messages.mjs'
import { errorKey, errorMessage } from '../src/lib/errorMessages.js'

const LOCALES = ['ru', 'en', 'lt']

const keysOf = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) =>
  child && typeof child === 'object' ? keysOf(child, `${prefix}${key}.`) : [`${prefix}${key}`])

test('AI texts have the same keys in every locale', () => {
  const ru = keysOf(lookup('ru', 'ai')).sort()
  for (const locale of LOCALES) assert.deepEqual(keysOf(lookup(locale, 'ai')).sort(), ru, locale)
})

test('every error code the AI function or the database can return is translated', async () => {
  const sources = await Promise.all(['api/ai.js', 'api/_ai-deepseek.js', 'api/_ai-supabase.js', 'api/_ai-errors.js', 'src/lib/ai.js',
    'supabase/migrations/20261024174519_ai_foundation.sql'].map(path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')))
  const codes = new Set(sources.join('\n').match(/'ai\.[a-zA-Z]+'/g).map(code => code.slice(1, -1)))
  assert.ok(codes.has('ai.limit') && codes.has('ai.notConfigured'))
  for (const code of codes) {
    assert.equal(errorKey(code), `ai.errors.${code.slice(3)}`)
    for (const locale of LOCALES) {
      const t = makeT(locale)
      assert.notEqual(errorMessage(new Error(code), t), t('errors.generic'), `${code} in ${locale}`)
    }
  }
})
