import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { checkImport, cleanContact, cleanName, entryShape, importRow, nameKey } from '../src/lib/aiSchemas.js'
import { TASKS, importPrompt } from '../api/_ai-tasks.js'
import { AiError } from '../api/_ai-errors.js'
import { clipText } from '../src/lib/aiFileText.js'

test('entry shape follows the category, pairing mode and individual formats', () => {
  assert.equal(entryShape({ category: 'singles', format: 'single_elimination' }), 'single')
  assert.equal(entryShape({ category: 'doubles', doubles_pairing_mode: 'pre_agreed' }), 'pair')
  assert.equal(entryShape({ category: 'doubles', doubles_pairing_mode: 'pick_random' }), 'pairOptional')
  assert.equal(entryShape({ category: 'doubles', doubles_pairing_mode: 'pick_random', format: 'americano' }), 'single')
  assert.equal(entryShape({ category: 'singles', sport: 'football' }), 'single')
})

test('names, contacts and seeds from the model are cleaned, never trusted', () => {
  assert.equal(cleanName('  3)  Žygimantas   Šeškus '), 'Žygimantas Šeškus')
  assert.equal(cleanName('• Ona​ Jonaitienė'), 'Ona Jonaitienė')
  assert.equal(cleanName('12. Rūta'), 'Rūta')
  assert.equal(cleanName('x'.repeat(150)).length, 100)
  assert.equal(cleanName({ name: 'x' }), '')
  assert.equal(cleanContact(' Ieva.P@Gmail.com '), 'ieva.p@gmail.com')
  assert.equal(cleanContact('+370 612 34567'), '+370 612 34567')
  assert.equal(cleanContact('call me'), null)

  const result = checkImport({
    entries: [
      { members: ['Jonas', 'Mantas'], contact: 'nope', seed: 2, note: '  paid  ' },
      { members: 'Eglė', seed: 0 },
      { members: ['', '  '] },
      'garbage',
      { members: ['A', 'B', 'C'], seed: 1.5 },
    ],
    unparsed: ['???', 42, null],
    warnings: ['  one  ', 'two', 'three', 'four', 'five', 'six'],
  }, { shape: 'pair' })
  assert.deepEqual(result.entries, [
    { members: ['Jonas', 'Mantas'], contact: null, seed: 2, note: 'paid', incomplete: false },
    { members: ['Eglė'], contact: null, seed: null, note: null, incomplete: true },
    { members: ['A', 'B'], contact: null, seed: null, note: null, incomplete: false },
    { members: ['C'], contact: null, seed: null, note: null, incomplete: true },
  ])
  assert.deepEqual(result.unparsed, ['???', '42'])
  assert.deepEqual(result.remarks, ['one', 'two', 'three', 'four', 'five'])
  assert.deepEqual(result.notices, ['splitGroups'])
})

test('pairs become single players where every entry is one participant', () => {
  const { entries, notices } = checkImport({ entries: [{ members: ['Jonas', 'Mantas'], contact: 'j@x.lt', seed: 1 }] }, { shape: 'single' })
  assert.deepEqual(entries.map(e => [e.members, e.contact, e.seed]), [[['Jonas'], 'j@x.lt', 1], [['Mantas'], null, null]])
  assert.deepEqual(notices, ['splitPairs'])
})

test('an answer without entries is a bad response; long lists are cut', () => {
  assert.throws(() => checkImport({ people: [] }), /ai\.badResponse/)
  assert.throws(() => TASKS.import.check({ people: [] }, { context: {} }), error => error instanceof AiError && error.code === 'ai.badResponse')
  const many = checkImport({ entries: Array.from({ length: 300 }, (_, i) => ({ members: [`P${i}`] })) })
  assert.equal(many.entries.length, 256)
  assert.deepEqual(many.notices, ['cut'])
})

test('duplicate keys ignore case, spaces and diacritics; rows match add_manual_entries', () => {
  assert.equal(nameKey('  Rūta  ŠIMKUTĖ '), nameKey('ruta simkute'))
  assert.equal(nameKey('Алёна'), nameKey('алена'))
  assert.deepEqual(importRow({ members: ['Ona', 'Rūta'], contact: null }), { member_one: 'Ona', member_two: 'Rūta', display_name: null, contact: null })
  assert.deepEqual(importRow({ members: ['Ona'], contact: '+37060000000' }), { member_one: 'Ona', member_two: null, display_name: null, contact: '+37060000000' })
})

test('the import prompt asks for json, the entry rule of the tournament and remarks in the UI language', async () => {
  const input = await readFile(new URL('./fixtures/ai/import/whatsapp-pairs.txt', import.meta.url), 'utf8')
  const pair = importPrompt(input, { shape: 'pair', locale: 'ru' })
  assert.match(pair.system, /json/)
  assert.match(pair.system, /PAIR of two players/)
  assert.match(pair.system, /Write them in Russian/)
  assert.ok(pair.user.includes('Jonas Petraitis / Mantas Kazlauskas'))
  assert.match(importPrompt(input, { shape: 'nonsense' }).system, /ONE participant/)
  assert.match(importPrompt(input, { shape: 'nonsense' }).system, /Write them in Lithuanian/)
  assert.match(importPrompt(input, { sport: 'football' }).system, /football teams/)
})

test('file text is clipped to what the AI accepts', () => {
  assert.deepEqual(clipText('abc', 5), { text: 'abc', clipped: false })
  assert.deepEqual(clipText('abcdef', 5), { text: 'abcde', clipped: true })
})
