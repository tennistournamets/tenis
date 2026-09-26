import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { deadlineInPast, restoreDraftFields } from '../src/lib/wizardDraft.js'
import { registrationDraftFields } from '../src/lib/registrationRules.js'
import { resolveCategory } from '../src/lib/sportConfig.js'

const initial = {
  name: '', sport: 'tennis', category: 'singles', venue_lat: null, venue_lng: null,
  scoring_config: { tennis: { game_rule: 'advantage' } }, is_public: true, ...registrationDraftFields({}),
}

test('a reloaded draft keeps the map point and the participant limit', () => {
  // What the wizard wrote: v-model on <input type=number> stores a number.
  const stored = JSON.parse(JSON.stringify({ ...initial, name: 'Cup', venue_lat: 54.6872, venue_lng: 25.2797,
    registration_capacity: 16, scoring_config: { tennis: { game_rule: 'no_ad' } } }))
  const restored = restoreDraftFields(initial, stored)
  assert.equal(restored.venue_lat, 54.6872)
  assert.equal(restored.venue_lng, 25.2797)
  assert.equal(restored.registration_capacity, '16')
  assert.deepEqual(restored.scoring_config, { tennis: { game_rule: 'no_ad' } })
  assert.equal(restored.name, 'Cup')
})

test('malformed draft values are ignored', () => {
  const restored = restoreDraftFields(initial, { venue_lat: { x: 1 }, venue_lng: Number.NaN, is_public: 'yes',
    scoring_config: [1], registration_capacity: Infinity, unknown: 1 })
  assert.deepEqual(restored, {})
  assert.deepEqual(restoreDraftFields(initial, null), {})
})

test('a deadline in the past is detected for the wizard warning', () => {
  const now = new Date('2026-09-26T12:00:00').getTime()
  assert.equal(deadlineInPast('2026-09-25T10:00', now), true)
  assert.equal(deadlineInPast('2026-09-27T10:00', now), false)
  assert.equal(deadlineInPast('', now), false)
})

test('viewing padel and going back to tennis keeps singles', () => {
  const source = readFileSync(new URL('../src/views/AdminTournamentCreateView.vue', import.meta.url), 'utf8')
  assert.ok(!/form\.category = c\.forcedCategory/.test(source), 'the sport watcher must not overwrite the chosen category')
  const category = 'singles'
  assert.equal(resolveCategory('padel', category), 'doubles')
  assert.equal(resolveCategory('tennis', category), 'singles')
})

test('a taken slug sends the organizer back to the step with the slug field', () => {
  const source = readFileSync(new URL('../src/views/AdminTournamentCreateView.vue', import.meta.url), 'utf8')
  assert.match(source, /error\.code === '23505'\) \{[\s\S]{0,300}step\.value = 3[\s\S]{0,120}mobile\.slugTaken/)
})
