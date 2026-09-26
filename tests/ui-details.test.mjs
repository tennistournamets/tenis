import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { lookup } from './helpers/messages.mjs'

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('locked scoring-rule selects are disabled themselves, not only by the fieldset', () => {
  const source = read('src/components/TennisRulesSettings.vue')
  const selects = source.match(/<select\b[^>]*>/g)
  assert.ok(selects.length >= 6)
  for (const tag of selects) assert.match(tag, /:disabled="disabled"/)
})

test('a settings conflict does not claim "no changes" while a draft exists', () => {
  assert.match(read('src/components/admin/TournamentSettingsForm.vue'),
    /footer-status" role="status">\{\{ canSaveSettings \? t\('drafts\.unsaved'\) : t\('admin\.noChanges'\) \}\}/)
})

test('court rows name the actual problem', () => {
  const source = read('src/components/admin/CourtsEditor.vue')
  assert.match(source, /if \(name\.length > 60\) return 'courtNameTooLong'/)
  for (const locale of ['ru', 'en', 'lt']) for (const key of ['courtNameEmpty', 'courtNameTooLong', 'courtNameDuplicate']) {
    assert.equal(typeof lookup(locale, `schedule.errors.${key}`), 'string', `${locale} ${key}`)
  }
})

test('"vs" and pending names use the readable muted colour', () => {
  for (const file of ['src/components/ScoreEditor.vue', 'src/components/admin/ScheduleBoard.vue']) {
    const source = read(file)
    assert.ok(!/(__vs|is-tbd)[^{]*\{[^}]*color: var\(--disabled\)/.test(source), file)
  }
})
