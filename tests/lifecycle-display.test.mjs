import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalMatch, finishConfirmation, tournamentChampion, unplayedMatches } from '../src/lib/tournamentChampion.js'
import { scoringAccess } from '../src/lib/scoringAccess.js'
import { browserClientId } from '../src/lib/access.js'
import { entryNamesError, feeUnitsFor, organizerContactError, registrationPatch, validateRegistrationForm } from '../src/lib/registrationRules.js'
import { indexEntryContacts, phoneHref } from '../src/lib/entryContacts.js'

const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
const m = (id, stage, round, extra = {}) => ({ id, stage, round_number: round, match_number: 1, status: 'pending',
  side_a_entry_id: 'a', side_b_entry_id: 'b', winner_entry_id: null, next_match_id: null, ...extra })
const won = (match, winner) => ({ ...match, status: 'finished', winner_entry_id: winner })

test('single elimination: the final winner is the champion, only once the final is played', () => {
  const semi = m('s1', 'main', 1, { next_match_id: 'f' })
  const final = m('f', 'main', 2)
  assert.equal(finalMatch('single_elimination', [semi, final]).id, 'f')
  assert.equal(tournamentChampion({ format: 'single_elimination', matches: [won(semi, 'a'), final] }), null)
  assert.deepEqual(tournamentChampion({ format: 'single_elimination', matches: [won(semi, 'a'), won(final, 'b')] }),
    { entryId: 'b', source: 'final', matchId: 'f' })
})

test('double elimination: the grand final decides, not the winners-bracket final', () => {
  const wbFinal = won(m('w', 'winners', 2), 'a')
  const lbFinal = won(m('l', 'losers', 2, { next_match_id: 'gf' }), 'b')
  const gf = m('gf', 'grand_final', 1)
  assert.equal(tournamentChampion({ format: 'double_elimination', matches: [wbFinal, lbFinal, gf] }), null)
  assert.equal(tournamentChampion({ format: 'double_elimination', matches: [wbFinal, lbFinal, won(gf, 'b')] }).entryId, 'b')
})

test('groups and playoff: the playoff final decides; group results alone do not', () => {
  const groups = [won(m('g1', 'group', 1), 'a'), won(m('g2', 'group', 2), 'b')]
  assert.equal(tournamentChampion({ format: 'groups_playoff', matches: groups }), null)
  const final = won(m('pf', 'winners', 2), 'a')
  const semi = won(m('ps', 'winners', 1, { next_match_id: 'pf' }), 'a')
  assert.equal(tournamentChampion({ format: 'groups_playoff', matches: [...groups, semi, final] }).entryId, 'a')
})

test('round robin: the standings leader once every match is played, or when the organizer finished', () => {
  const standings = [{ entry_id: 'b', rank: 1 }, { entry_id: 'a', rank: 2 }]
  const played = [won(m('r1', 'main', 1), 'b'), won(m('r2', 'main', 2), 'b')]
  const open = [played[0], m('r2', 'main', 2)]
  assert.deepEqual(tournamentChampion({ format: 'round_robin', status: 'in_progress', matches: played, standings }), { entryId: 'b', source: 'standings' })
  assert.equal(tournamentChampion({ format: 'round_robin', status: 'in_progress', matches: open, standings }), null)
  assert.equal(tournamentChampion({ format: 'round_robin', status: 'completed', matches: open, standings }).entryId, 'b')
  // Nothing played or a shared first place: no champion.
  assert.equal(tournamentChampion({ format: 'round_robin', status: 'completed', matches: [m('r1', 'main', 1)], standings }), null)
  assert.equal(tournamentChampion({ format: 'round_robin', status: 'completed', matches: played,
    standings: [{ entry_id: 'a', rank: 1 }, { entry_id: 'b', rank: 1 }] }), null)
})

test('unplayed matches: future knockout slots count, BYEs and rest slots do not', () => {
  const bye = { ...m('bye', 'main', 1), side_b_entry_id: null, status: 'finished', winner_entry_id: 'a' }
  const future = { ...m('f', 'main', 2), side_a_entry_id: null, side_b_entry_id: null }
  assert.deepEqual(unplayedMatches('single_elimination', [bye, future]).map(x => x.id), ['f'])
  const rest = { ...m('rest', 'main', 1), side_b_entry_id: null }
  assert.deepEqual(unplayedMatches('round_robin', [rest, m('r', 'main', 2)]).map(x => x.id), ['r'])
  assert.deepEqual(unplayedMatches('double_elimination', [m('gf', 'grand_final', 1), m('l', 'losers', 1), m('w', 'winners', 1)]).map(x => x.id), ['w', 'l', 'gf'])
})

test('finishing with unplayed matches asks explicitly and lists them; a played-out tournament asks as before', () => {
  const played = finishConfirmation({ format: 'single_elimination', matches: [won(m('f', 'main', 1), 'a')], t })
  assert.deepEqual([played.message, played.options, played.unplayed], ['admin.finishTournamentConfirm', {}, 0])
  const matches = Array.from({ length: 10 }, (_, i) => ({ ...m(`m${i}`, 'main', 1), match_number: i + 1, next_match_id: 'x' }))
  const ask = finishConfirmation({ format: 'single_elimination', matches, label: id => `name-${id}`, t })
  assert.equal(ask.message, 'lifecycle.finishUnplayed')
  assert.equal(ask.unplayed, 10)
  assert.equal(ask.options.danger, true)
  assert.equal(ask.options.confirmLabel, 'lifecycle.finishAnyway')
  assert.equal(ask.options.details.intro, 'lifecycle.finishUnplayedIntro:{"n":10}')
  assert.equal(ask.options.details.items.length, 9)
  assert.equal(ask.options.details.items[0].teams, 'name-a — name-b')
  assert.equal(ask.options.details.items.at(-1).teams, 'lifecycle.finishUnplayedMore:{"n":2}')
})

test('a results-only counter may stop live scoring, like every live scorer', () => {
  const tournament = { sport: 'tennis', status: 'in_progress' }
  for (const role of ['owner', 'editor', 'counter']) assert.equal(scoringAccess(tournament, role).stopLive, true, role)
  for (const role of [null, 'outsider']) assert.equal(scoringAccess(tournament, role).stopLive, false)
  assert.equal(scoringAccess({ ...tournament, status: 'completed' }, 'counter').stopLive, false)
})

test('the browser id is created once and reused; blocked storage still yields an id', () => {
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  const first = browserClientId(storage, () => '11111111-2222-3333-4444-555555555555')
  assert.equal(first, '11111111-2222-3333-4444-555555555555')
  assert.equal(browserClientId(storage, () => 'other-id-000'), first)
  const blocked = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(browserClientId(blocked, () => 'fallback-id-1'), 'fallback-id-1')
  store.set('champ_client_id', '<script>')
  assert.equal(browserClientId(storage, () => 'replaced-id-1'), 'replaced-id-1')
})

test('entry names: length limits and the same player twice in a pair', () => {
  assert.equal(entryNamesError('singles', 'Ann', '', ''), null)
  assert.equal(entryNamesError('singles', 'x'.repeat(101), '', ''), 'registrationRules.errors.nameTooLong')
  assert.equal(entryNamesError('doubles', 'Ann', 'Bea', 'y'.repeat(161)), 'registrationRules.errors.nameTooLong')
  assert.equal(entryNamesError('doubles', 'Анна Петрова', ' анна   петрова ', ''), 'registrationRules.errors.samePlayer')
  assert.equal(entryNamesError('doubles', 'Анна Петрова', '', ''), null)
  assert.equal(entryNamesError('singles', 'Ann', 'ann', ''), null)
})

test('organizer contacts, waitlist and fee rules mirror the server', () => {
  assert.equal(organizerContactError('', ''), null)
  assert.equal(organizerContactError('+370 600 00000', 'org@example.test'), null)
  assert.equal(organizerContactError('abc', ''), 'registrationRules.errors.invalidPhone')
  assert.equal(organizerContactError('', 'nope'), 'registrationRules.errors.invalidEmail')
  const base = { registration_capacity: '', entry_fee_mode: '', entry_fee_amount: '', entry_fee_currency: 'EUR', entry_fee_unit: '', waitlist_enabled: false }
  assert.equal(validateRegistrationForm({ ...base, waitlist_enabled: true }), 'registrationRules.errors.waitlistNeedsCapacity')
  assert.equal(validateRegistrationForm({ ...base, waitlist_enabled: true, registration_capacity: '8' }), null)
  assert.equal(validateRegistrationForm({ ...base, entry_fee_mode: 'paid', entry_fee_amount: '0' }), 'registrationRules.errors.zeroFee')
  assert.equal(validateRegistrationForm({ ...base, entry_fee_mode: 'paid', entry_fee_amount: '5' }), null)
  assert.deepEqual(feeUnitsFor({ sport: 'tennis', category: 'singles' }), ['player'])
  assert.deepEqual(feeUnitsFor({ sport: 'padel', category: 'doubles' }), ['pair', 'player'])
  assert.deepEqual(feeUnitsFor({ sport: 'football', category: 'singles' }), ['team', 'player'])
  const paid = { ...base, entry_fee_mode: 'paid', entry_fee_amount: '5', entry_fee_unit: 'pair' }
  assert.equal(registrationPatch(paid, { sport: 'tennis', category: 'singles' }).entry_fee_unit, 'player')
  assert.equal(registrationPatch(paid, { sport: 'tennis', category: 'doubles' }).entry_fee_unit, 'pair')
})

test('contacts index and phone links', () => {
  assert.deepEqual(indexEntryContacts([
    { entry_id: 'e1', contact_phone: '+370 600', contact_email: null },
    { entry_id: 'e2', contact_phone: null, contact_email: null },
    { entry_id: 'e3', contact_phone: null, contact_email: 'a@b.c' },
  ]), { e1: { phone: '+370 600', email: null }, e3: { phone: null, email: 'a@b.c' } })
  assert.deepEqual(indexEntryContacts(null), {})
  assert.equal(phoneHref('+370 (600) 12-345'), 'tel:+37060012345')
  assert.equal(phoneHref(''), '')
})
