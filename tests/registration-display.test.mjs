import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  amountToMinor, closedReasonKey, feeUnitDefault, formatFee, fromDatetimeLocal, hasRegistrationRules, minorToAmount,
  registrationDisplayState, registrationDraftFields, registrationError, registrationPatch, toDatetimeLocal, validateRegistrationForm,
} from '../src/lib/registrationRules.js'
import { registrationRuleMessages } from '../src/i18n/registrationRules.js'

const t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key

test('server codes map to translations and unknown messages fall back to the generic text', () => {
  assert.equal(registrationError('registration.full', t), 'registrationRules.errors.full')
  assert.equal(registrationError('registration.deadlinePassed', t), 'registrationRules.errors.deadlinePassed')
  assert.equal(registrationError('drafts.conflict', t), 'drafts.conflict')
  assert.equal(registrationError('', t, 'registrationForm.error'), 'registrationForm.error')
  assert.equal(registrationError(undefined, t), 'errors.generic')
  assert.equal(registrationError('Registration already exists for this contact', t), 'Registration already exists for this contact')
})

test('display state follows the server reason and closes locally once the deadline is reached', () => {
  const open = { status: 'registration_open', accepting: true, closed_reason: null, deadline_at: '2026-09-20T10:00:00Z', deadline_passed: false }
  const before = Date.parse('2026-09-20T09:59:00Z'), after = Date.parse('2026-09-20T10:00:00Z')
  assert.deepEqual(registrationDisplayState(open, before), { accepting: true, reason: null, deadlinePassed: false, waitlistOpen: false, known: true })
  assert.deepEqual(registrationDisplayState(open, after), { accepting: false, reason: 'deadline', deadlinePassed: true, waitlistOpen: false, known: true })
  assert.equal(registrationDisplayState({ ...open, accepting: false, closed_reason: 'full', waitlist_enabled: true }, before).waitlistOpen, true)
  assert.equal(registrationDisplayState({ ...open, accepting: false, closed_reason: 'full', waitlist_enabled: false }, before).waitlistOpen, false)
  assert.equal(registrationDisplayState({ ...open, accepting: false, closed_reason: 'full' }, before).reason, 'full')
  // A closed status is reported as such even when the deadline also passed.
  assert.equal(registrationDisplayState({ ...open, status: 'registration_closed', accepting: false, closed_reason: 'status' }, after).reason, 'status')
  // Without a registration object (older server) the status alone decides.
  assert.deepEqual(registrationDisplayState(null, after, { status: 'registration_open' }), { accepting: true, reason: null, deadlinePassed: false, waitlistOpen: false, known: false })
  assert.equal(registrationDisplayState(null, after, { status: 'draft' }).reason, 'status')
  assert.equal(closedReasonKey('full'), 'registrationRules.closedFull')
  assert.equal(closedReasonKey('deadline'), 'registrationRules.closedDeadline')
  assert.equal(closedReasonKey('status'), 'registrationRules.closedStatus')
})

test('fee amounts round-trip through minor units and format per locale', () => {
  assert.equal(amountToMinor('20', 'EUR'), 2000)
  assert.equal(amountToMinor('19,99', 'EUR'), 1999)
  assert.equal(amountToMinor('abc', 'EUR'), null)
  assert.equal(amountToMinor('-1', 'EUR'), null)
  assert.equal(minorToAmount(2000, 'EUR'), '20.00')
  assert.equal(minorToAmount(null, 'EUR'), '')
  assert.match(formatFee({ mode: 'paid', amount_minor: 2000, currency: 'EUR' }, 'en'), /20\.00/)
  assert.equal(formatFee({ mode: 'free' }, 'en'), '')
  assert.equal(formatFee(null, 'en'), '')
  assert.equal(feeUnitDefault({ sport: 'football', category: 'singles' }), 'team')
  assert.equal(feeUnitDefault({ sport: 'padel', category: 'doubles' }), 'pair')
  assert.equal(feeUnitDefault({ sport: 'tennis', category: 'singles' }), 'player')
})

test('draft fields, validation and the settings patch only carry real columns', () => {
  const row = { registration_capacity: 16, capacity_public: false, registration_deadline: '2026-09-25T15:00:00.000Z',
    entry_fee_mode: 'paid', entry_fee_minor: 1500, entry_fee_currency: 'EUR', entry_fee_unit: 'pair', sport: 'tennis', category: 'doubles' }
  const draft = registrationDraftFields(row)
  assert.deepEqual(Object.keys(draft).sort(), ['capacity_public', 'entry_fee_amount', 'entry_fee_currency', 'entry_fee_mode', 'entry_fee_unit', 'registration_capacity', 'registration_deadline', 'waitlist_enabled'])
  assert.equal(draft.registration_capacity, '16')
  assert.equal(draft.entry_fee_amount, '15.00')
  assert.equal(fromDatetimeLocal(draft.registration_deadline), row.registration_deadline)
  assert.equal(validateRegistrationForm(draft), null)
  assert.deepEqual(registrationPatch(draft, row), { registration_capacity: 16, capacity_public: false, registration_deadline: row.registration_deadline,
    entry_fee_mode: 'paid', entry_fee_minor: 1500, entry_fee_currency: 'EUR', entry_fee_unit: 'pair', waitlist_enabled: false })

  const empty = registrationDraftFields({})
  assert.equal(hasRegistrationRules(empty), false)
  assert.deepEqual(registrationPatch(empty), { registration_capacity: null, capacity_public: true, registration_deadline: null,
    entry_fee_mode: null, entry_fee_minor: null, entry_fee_currency: null, entry_fee_unit: null, waitlist_enabled: false })
  assert.equal(hasRegistrationRules({ ...empty, waitlist_enabled: true }), true)
  assert.equal(registrationPatch({ ...empty, entry_fee_mode: 'paid', entry_fee_amount: '5' }, { sport: 'football' }).entry_fee_unit, 'team')
  assert.equal(registrationPatch({ ...empty, entry_fee_mode: 'free', entry_fee_amount: '5' }).entry_fee_minor, null)
  assert.equal(hasRegistrationRules({ ...empty, registration_capacity: '8' }), true)
  assert.equal(validateRegistrationForm({ ...empty, registration_capacity: '0' }), 'registrationRules.errors.invalidCapacity')
  assert.equal(validateRegistrationForm({ ...empty, registration_capacity: '1.5' }), 'registrationRules.errors.invalidCapacity')
  assert.equal(validateRegistrationForm({ ...empty, entry_fee_mode: 'paid', entry_fee_amount: '' }), 'registrationRules.errors.invalidFee')
  assert.equal(validateRegistrationForm({ ...empty, entry_fee_mode: 'paid', entry_fee_amount: '3', entry_fee_currency: 'XXX' }), 'registrationRules.errors.invalidFee')
  assert.equal(toDatetimeLocal(''), '')
  assert.equal(toDatetimeLocal('not a date'), '')
  assert.equal(fromDatetimeLocal(''), null)
})

test('RU, EN and LT registration messages share the same key set', () => {
  const keys = obj => Object.entries(obj).flatMap(([k, v]) => typeof v === 'object' ? keys(v).map(s => `${k}.${s}`) : [k]).sort()
  const ru = keys(registrationRuleMessages.ru)
  assert.ok(ru.length > 40)
  assert.deepEqual(keys(registrationRuleMessages.en), ru)
  assert.deepEqual(keys(registrationRuleMessages.lt), ru)
  for (const locale of ['ru', 'en', 'lt']) {
    for (const key of ['occupied', 'adminSummary']) assert.match(registrationRuleMessages[locale][key], /\{occupied\}.*\{capacity\}/)
    assert.match(registrationRuleMessages[locale].approveAllResult, /\{approved\}.*\{skipped\}/)
  }
})
