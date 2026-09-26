import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { lookup, makeT } from './helpers/messages.mjs'
import { SERVER_ERRORS, errorKey, errorMessage, isTransientError } from '../src/lib/errorMessages.js'
import { scoringError } from '../src/lib/tennisRules.js'
import { registrationError } from '../src/lib/registrationRules.js'
import { accessError } from '../src/lib/access.js'

const LOCALES = ['ru', 'en', 'lt']
const keyT = key => key

test('every mapped server error has a translation in every locale', () => {
  for (const [, key] of SERVER_ERRORS) for (const locale of LOCALES) {
    assert.equal(typeof lookup(locale, key), 'string', `${locale}: ${key}`)
  }
  const en = Object.keys(lookup('en', 'serverErrors'))
  for (const locale of LOCALES) assert.deepEqual(Object.keys(lookup(locale, 'serverErrors')), en, locale)
})

test('backlog D1 messages are translated, never shown raw', () => {
  const cases = {
    'Registration already exists for this contact': 'admin.addEntryDuplicateContact',
    'Single entry requires one participant': 'serverErrors.singleEntryOnePlayer',
    'Tournament is private': 'serverErrors.tournamentPrivate',
    'All group matches must be finished first': 'serverErrors.groupsUnfinished',
    'Scoring rules are locked': 'tennisRules.locked',
    'Scoring rules are locked after the tournament starts or scores exist': 'tennisRules.locked',
    'Too many sets for this match format': 'tennisRules.invalidScore',
    'canceling statement due to statement timeout': 'serverErrors.timeout',
    'TypeError: Failed to fetch': 'serverErrors.network',
    'Load failed': 'serverErrors.network',
    'duplicate key value violates unique constraint "matches_tournament_id_stage_round_number_match_number_key"': 'serverErrors.conflict',
    'Could not find the function public.set_entry_seed_order(p_entry_ids, p_tournament_id) in the schema cache': 'serverErrors.outdated',
    'User with email qa-nonexistent@example.com not found': 'access.errors.userNotFound',
    'Scores can be entered only after the tournament starts': 'serverErrors.beforeStart',
    'Double elimination v1 requires a power-of-two participant count (got 6)': 'serverErrors.doubleElimSize',
    'Odd number of unpaired players (3). Remove or add one before forming pairs.': 'serverErrors.oddPlayers',
  }
  for (const [message, key] of Object.entries(cases)) {
    assert.equal(errorKey(message), key, message)
    for (const locale of LOCALES) {
      const text = errorMessage(message, makeT(locale))
      assert.notEqual(text, message, `${locale}: ${message}`)
      assert.equal(text, lookup(locale, key))
    }
  }
})

test('codes on error objects are recognised without relying on the text', () => {
  assert.equal(errorKey({ code: '57014', message: '' }), 'serverErrors.timeout')
  assert.equal(errorKey({ code: '23505', message: 'x' }), 'serverErrors.conflict')
  assert.equal(errorKey({ code: 'PGRST202', message: 'y' }), 'serverErrors.outdated')
  assert.equal(errorKey({ code: 'PGRST301', message: 'JWT expired' }), 'serverErrors.sessionExpired')
  assert.equal(errorKey({ name: 'AbortError', message: 'signal is aborted without reason' }), 'serverErrors.timeout')
  assert.equal(errorKey(new TypeError('Failed to fetch')), 'serverErrors.network')
  assert.equal(isTransientError(new TypeError('NetworkError when attempting to fetch resource.')), true)
  assert.equal(isTransientError('Not allowed'), false)
})

test('message codes map through their namespaces and new keys work without a table row', () => {
  assert.equal(errorMessage('access.lastOwner', keyT), 'access.errors.lastOwner')
  assert.equal(errorMessage('schedule.conflict', keyT), 'schedule.errors.conflict')
  assert.equal(errorMessage('registration.full', keyT), 'registrationRules.errors.full')
  assert.equal(errorMessage('serverErrors.network', keyT), 'serverErrors.network')
  // A code another stream raises straight from SQL is translated once its text exists.
  const t = makeT('ru')
  assert.equal(errorMessage('nextStep.label', t), lookup('ru', 'nextStep.label'))
})

test('unknown and empty errors fall back to translated text', t => {
  const warn = t.mock.method(console, 'warn', () => {})
  assert.equal(errorMessage('Some brand new server failure', keyT), 'errors.generic')
  assert.equal(errorMessage('Some brand new server failure', keyT, 'registrationForm.error'), 'registrationForm.error')
  assert.equal(errorMessage('bracket.notYetTranslated', keyT, 'drafts.unavailable'), 'drafts.unavailable')
  assert.equal(warn.mock.callCount(), 3)
  assert.equal(errorMessage(undefined, keyT), 'errors.generic')
  assert.equal(scoringError('', keyT), 'scoringFlow.unavailable')
  assert.equal(scoringError('Unknown', keyT), 'errors.generic')
  assert.equal(registrationError(null, keyT, 'registrationForm.error'), 'registrationForm.error')
  assert.equal(accessError({ message: 'Not authorized' }, keyT), 'serverErrors.notAllowed')
})

test('views show mapped errors instead of raw error.message', () => {
  for (const file of ['src/views/AdminTournamentView.vue', 'src/views/AdminTournamentListView.vue', 'src/components/admin/TournamentSettingsForm.vue']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.ok(!/(errorText|loadError|settingsError)\.value = error\??\.message/.test(source), file)
    assert.ok(!/= error\??\.message \|\|/.test(source), file)
  }
})
