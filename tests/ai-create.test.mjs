import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkCreate } from '../src/lib/aiSchemas.js'
import { TASKS, createPrompt } from '../api/_ai-tasks.js'
import { AiError } from '../api/_ai-errors.js'

const enabled = { enabledSports: ['tennis', 'padel'], sport: 'tennis' }

test('a full answer becomes wizard fields; text fields are trimmed and cut', () => {
  const { fields, participants, notices } = checkCreate({
    tournament: {
      name: '  Rudens   lyga ', sport: 'tennis', format: 'single_elimination', category: 'doubles', pairing: 'pre_agreed',
      description: 'Sekmadienį 9:00', venue_address: 'SEB arena', contact_phone: '+370 612 00000', contact_email: 'ORG@Club.lt',
      set_format: 'best_of_3', gender: 'mixed', capacity: 8, deadline: '2026-11-13T20:00',
      fee: { mode: 'paid', amount: '40,5', currency: 'EUR', unit: 'pair' }, waitlist: true,
    },
    participants: [{ members: ['Ona', 'Rūta'], contact: 'ona@x.lt' }],
  }, enabled)
  assert.deepEqual(fields, {
    sport: 'tennis', format: 'single_elimination', category: 'doubles', name: 'Rudens lyga', description: 'Sekmadienį 9:00',
    venue_address: 'SEB arena', contact_phone: '+370 612 00000', contact_email: 'org@club.lt', set_format: 'best_of_3', gender: 'mixed',
    registration_capacity: '8', registration_deadline: '2026-11-13T20:00',
    entry_fee_mode: 'paid', entry_fee_amount: '40.50', entry_fee_currency: 'EUR', entry_fee_unit: 'pair', waitlist_enabled: true,
  })
  assert.deepEqual(participants.entries, [{ members: ['Ona', 'Rūta'], contact: 'ona@x.lt', note: null, incomplete: false }])
  assert.deepEqual(notices, [])
})

test('switched-off sports, foreign formats and impossible values are dropped with a notice', () => {
  const football = checkCreate({ tournament: { sport: 'football', format: 'round_robin' } }, enabled)
  assert.deepEqual(football.fields, { format: 'round_robin' })
  assert.deepEqual(football.notices, ['sportOff'])

  const tennisAmericano = checkCreate({ tournament: { sport: 'tennis', format: 'americano' } }, enabled)
  assert.deepEqual(tennisAmericano.fields, { sport: 'tennis' })
  assert.deepEqual(tennisAmericano.notices, ['formatOff'])

  const bad = checkCreate({ tournament: { capacity: 1, deadline: '2026-02-30T20:00', contact_email: 'nope', gender: 'mixed', set_format: 'best_of_7', points_per_match: 21 } }, enabled)
  assert.deepEqual(bad.fields, {}, 'mixed needs doubles, points need a points format')
})

test('a points format brings padel, a valid target and single players', () => {
  const { fields, participants, notices } = checkCreate({
    tournament: { format: 'americano', points_per_match: 24, category: 'doubles', gender: 'women' },
    participants: [{ members: ['Ona', 'Rūta'] }, { members: ['Eglė'] }],
  }, enabled)
  assert.deepEqual(fields, { sport: 'padel', format: 'americano', points_per_match: 24, gender: 'women' })
  assert.deepEqual(participants.entries.map(e => e.members), [['Ona'], ['Rūta'], ['Eglė']])
  assert.deepEqual(notices, ['splitPairs'])

  const kotc = checkCreate({ tournament: { sport: 'padel', format: 'king_of_court', points_per_match: 24 }, participants: [{ members: ['A'] }, { members: ['B'] }, { members: ['C'] }] }, enabled)
  assert.equal(kotc.fields.points_per_match, undefined)
  assert.deepEqual(kotc.notices.sort(), ['kotcPlayers', 'pointsOption'])
})

test('a list of pairs makes a tennis tournament doubles; too many entries are flagged', () => {
  const { fields, notices } = checkCreate({
    tournament: { sport: 'tennis', capacity: 2 },
    participants: [{ members: ['A', 'B'] }, { members: ['C', 'D'] }, { members: ['E', 'F'] }],
  }, enabled)
  assert.equal(fields.category, 'doubles')
  assert.deepEqual(notices.sort(), ['capacityLow', 'doublesFromList'])
})

test('a bare list fills no tournament fields; a broken answer is a bad response', () => {
  const { fields, participants } = checkCreate({ tournament: null, participants: [{ members: ['Jonas'] }, { members: ['Ona'] }] }, enabled)
  assert.deepEqual(fields, {})
  assert.equal(participants.entries.length, 2)
  assert.throws(() => checkCreate('nope'), /ai\.badResponse/)
  assert.throws(() => TASKS.create.check({ tournament: 'x' }, { context: {} }), error => error instanceof AiError && error.code === 'ai.badResponse')
})

test('the create prompt carries the enabled sports, today and the warning language', () => {
  const { system, user } = createPrompt('Padelio Americano šeštadienį', { enabledSports: ['padel', 'golf'], today: '2026-11-10', weekday: 'Tuesday', locale: 'lt' })
  assert.match(system, /json/)
  assert.match(system, /one of \["padel"\]/)
  assert.match(system, /Today is 2026-11-10 \(Tuesday\)/)
  assert.match(system, /Write them in Lithuanian/)
  assert.match(user, /Padelio Americano šeštadienį/)
  assert.equal(TASKS.create.tournament, false)
})

test('a deadline without a year that the model put in a past year moves to the next such date', () => {
  const at = (deadline, today) => checkCreate({ tournament: { deadline } }, { ...enabled, today }).fields.registration_deadline
  assert.equal(at('2025-11-13T23:59', '2026-10-24'), '2026-11-13T23:59')
  assert.equal(at('2025-02-01T10:00', '2026-10-24'), '2027-02-01T10:00', 'already past this year')
  assert.equal(at('2026-10-20T10:00', '2026-10-24'), '2026-10-20T10:00', 'a past date this year is the organizer\'s, the wizard warns')
  assert.equal(at('2026-12-01T10:00', '2026-10-24'), '2026-12-01T10:00')
  assert.equal(at('2025-11-13T23:59', null), '2025-11-13T23:59', 'no date known, nothing changed')
})

test('AI suggestions fill what the text left out and are named; the text always wins', () => {
  const result = checkCreate({
    tournament: { sport: 'padel', venue_address: 'Vilnius Padel Club', fee: { mode: 'paid', amount: 15, unit: 'player' }, format: null },
    suggested: { format: 'americano', points_per_match: 24, capacity: 16, courts: 4, visibility: 'link', venue_address: 'Somewhere else', sport: 'tennis' },
    questions: [
      { question: 'Во сколько начало?', options: ['10:00', '12:00', '', 7] },
      { question: '', options: ['x'] },
      { question: 'Сколько кортов?', options: ['2', '3'] },
      { question: 'Q3', options: [] },
      { question: 'Q4', options: [] },
    ],
  }, enabled)
  assert.equal(result.fields.sport, 'padel', 'text beats suggestion')
  assert.equal(result.fields.venue_address, 'Vilnius Padel Club')
  assert.equal(result.fields.format, 'americano')
  assert.equal(result.fields.courts, 4)
  assert.equal(result.fields.visibility, 'link')
  assert.deepEqual(result.suggested.sort(), ['courts', 'format', 'points_per_match', 'registration_capacity', 'visibility'])
  assert.deepEqual(result.questions, [
    { question: 'Во сколько начало?', options: ['10:00', '12:00', '7'] },
    { question: 'Сколько кортов?', options: ['2', '3'] },
    { question: 'Q3', options: [] },
  ])
})

test('answers to questions go back to the model with the text', async () => {
  const { createPrompt } = await import('../api/_ai-tasks.js')
  const { user, system } = createPrompt('Padelis šeštadienį', { locale: 'ru', answers: [{ question: 'Во сколько начало?', answer: '10:00' }, { question: '', answer: 'x' }] })
  assert.match(user, /The organizer's answers to your questions:\n- Во сколько начало\? → 10:00$/m)
  assert.doesNotMatch(user, /→ x/)
  assert.match(system, /"suggested"/)
  assert.match(system, /"questions": at most 3/)
})

test('questions about what the text gives are dropped; after answers, so are those about chosen values', () => {
  const json = {
    tournament: { sport: 'padel', format: 'americano', points_per_match: 21 },
    suggested: { courts: 2, capacity: 8 },
    questions: [
      { field: 'points_per_match', question: 'Kiek taškų?', options: ['16', '21'] },
      { field: 'courts', question: 'Kiek kortų?', options: ['1', '2'] },
      { field: 'date', question: 'Kada pradžia?', options: ['10:00'] },
      { question: 'Be lauko?', options: [] },
    ],
  }
  assert.deepEqual(checkCreate(json, enabled).questions.map(item => item.question), ['Kiek kortų?', 'Kada pradžia?', 'Be lauko?'])
  assert.deepEqual(checkCreate(json, { ...enabled, answered: true }).questions.map(item => item.question), ['Kada pradžia?', 'Be lauko?'])
})

test('the create task tells the check whether the organizer has answered', async () => {
  const { TASKS } = await import('../api/_ai-tasks.js')
  const json = { tournament: { sport: 'padel' }, suggested: { courts: 2 }, questions: [{ field: 'courts', question: 'Q', options: [] }] }
  assert.equal(TASKS.create.check(json, { context: { enabledSports: ['padel'] } }).questions.length, 1)
  assert.equal(TASKS.create.check(json, { context: { enabledSports: ['padel'], answers: [{ question: 'Q0', answer: 'A' }] } }).questions.length, 0)
})
