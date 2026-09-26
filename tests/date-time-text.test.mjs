import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { formatDateTimeText, parseDateTimeText } from '../src/lib/dateTimeText.js'

test('typing keystroke by keystroke commits only the complete value', () => {
  const text = '25.09.2026 10:00'
  const commits = []
  for (let i = 1; i <= text.length; i++) {
    const parsed = parseDateTimeText(text.slice(0, i))
    if (parsed) commits.push(parsed)
  }
  // "1" is never read as the 1st of the current month at the current time.
  assert.deepEqual(commits, ['2026-09-25T10:00'])
})

test('typed time is kept exactly, not replaced by the current time', () => {
  assert.equal(parseDateTimeText('25.09.2026 10:00'), '2026-09-25T10:00')
  assert.equal(parseDateTimeText('5.9.2026 9:03'), '2026-09-05T09:03')
  assert.equal(parseDateTimeText(' 01.01.2027, 23:59 '), '2027-01-01T23:59')
})

test('empty clears; impossible dates and partial text are rejected', () => {
  assert.equal(parseDateTimeText(''), '')
  assert.equal(parseDateTimeText('   '), '')
  for (const bad of ['1', '25.09.2026', '25.09.2026 10', '25.09.2026 10:0', '31.02.2026 10:00', '25.13.2026 10:00', '25.09.2026 24:00', '25.09.2026 10:60', '25.09.2026 10:000']) {
    assert.equal(parseDateTimeText(bad), null, bad)
  }
})

test('display format round-trips the model', () => {
  assert.equal(formatDateTimeText('2026-09-25T10:00'), '25.09.2026 10:00')
  assert.equal(formatDateTimeText(''), '')
  assert.equal(parseDateTimeText(formatDateTimeText('2026-12-31T07:05')), '2026-12-31T07:05')
})

test('the field no longer forwards keystrokes to the picker parser and passes a selector as teleport', () => {
  const source = readFileSync(new URL('../src/components/DateTimeField.vue', import.meta.url), 'utf8')
  assert.ok(!/@input="onInput"/.test(source))
  assert.ok(!/applyOnBlur: true/.test(source))
  assert.match(source, /teleportTarget\.value = `dialog\[data-dt-teleport=/)
})
