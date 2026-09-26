import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('selected sport/format cards and list filters expose aria-pressed', () => {
  assert.match(read('src/components/SportPicker.vue'), /:aria-pressed="modelValue === s"/)
  assert.match(read('src/components/FormatPicker.vue'), /:aria-pressed="modelValue === f"/)
  const list = read('src/views/AdminTournamentListView.vue')
  for (const value of ['active', 'completed', 'all']) assert.match(list, new RegExp(`:aria-pressed="statusFilter === '${value}'"`))
})

test('invalid registration fields are marked and linked to their messages', () => {
  const form = read('src/components/RegistrationForm.vue')
  assert.match(form, /:aria-invalid="phoneInvalid \|\| undefined"/)
  assert.match(form, /:aria-describedby="phoneInvalid \? 'reg-phone-error' : undefined"/)
  assert.match(form, /id="reg-phone-error"/)
  assert.match(form, /:aria-invalid="emailInvalid \|\| undefined"/)
  assert.match(form, /id="reg-email-error"/)
})

test('pair editor buttons are labelled in the page language', () => {
  assert.ok(!/aria-label="Remove"/.test(read('src/views/AdminTournamentView.vue')))
})
