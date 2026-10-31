import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  defaultSeedKind, ratingSeedOrder, ratingKindCounts,
  asksPlayerRating, formatRatingValue, indexEntryRatings, newRatingRow, parseRatingValue,
  ratingPayload, ratingRowsError, ratingTypesFor,
} from '../src/lib/playerRatings.js'
import { registrationDraftFields, registrationPatch, hasRegistrationRules } from '../src/lib/registrationRules.js'
import { errorMessage } from '../src/lib/errorMessages.js'

test('each sport offers the Lithuanian rating kinds; football none', () => {
  assert.deepEqual(ratingTypesFor('tennis'), ['tnl', 'lts'])
  assert.deepEqual(ratingTypesFor('padel'), ['padel_level', 'tnl', 'padelution'])
  assert.deepEqual(ratingTypesFor('football'), [])
  assert.equal(asksPlayerRating({ sport: 'tennis', player_rating: 'optional' }), true)
  assert.equal(asksPlayerRating({ sport: 'football', player_rating: 'required' }), false)
  assert.equal(asksPlayerRating({ sport: 'padel', player_rating: 'off' }), false)
  assert.equal(asksPlayerRating({ sport: 'padel' }), false)
  assert.deepEqual(newRatingRow('padel', ['padel_level']), { type: 'tnl', value: '' })
})

test('values are read on the same scales as the server', () => {
  assert.equal(parseRatingValue('tnl', '4,25'), 4.25)
  assert.equal(parseRatingValue('tnl', '4.250'), 4.25)
  assert.equal(parseRatingValue('tnl', '4.255'), null)
  assert.equal(parseRatingValue('tnl', '8.5'), null)
  assert.equal(parseRatingValue('lts', '37'), 37)
  assert.equal(parseRatingValue('lts', '0'), null)
  assert.equal(parseRatingValue('lts', '2.5'), null)
  assert.equal(parseRatingValue('padel_level', '4.5'), 4.5)
  assert.equal(parseRatingValue('padel_level', '4.2'), null)
  assert.equal(parseRatingValue('padelution', '2092'), 2092)
  assert.equal(parseRatingValue('padelution', '-1'), null)
  assert.equal(parseRatingValue('tnl', 'abc'), null)
})

test('rows: empty ones are skipped, required needs one, kinds are not repeated', () => {
  assert.equal(ratingRowsError('tennis', [{ type: 'tnl', value: '' }]), null)
  assert.equal(ratingRowsError('tennis', [{ type: 'tnl', value: '' }], true), 'playerRating.errors.required')
  assert.equal(ratingRowsError('tennis', [{ type: 'tnl', value: '9' }]), 'playerRating.errors.invalid')
  assert.equal(ratingRowsError('tennis', [{ type: 'padel_level', value: '4' }]), 'playerRating.errors.invalid')
  assert.equal(ratingRowsError('tennis', [{ type: 'tnl', value: '3' }, { type: 'tnl', value: '4' }]), 'playerRating.errors.duplicate')
  assert.deepEqual(ratingPayload([{ type: 'tnl', value: '4,5' }, { type: 'lts', value: ' ' }]), [{ type: 'tnl', value: 4.5 }])
})

test('stored values read as people write them, and RPC rows index by entry and player', () => {
  assert.equal(formatRatingValue('padel_level', 4.5), 'B+')
  assert.equal(formatRatingValue('tnl', 4), '4.00')
  assert.equal(formatRatingValue('lts', 37), '#37')
  assert.equal(formatRatingValue('padelution', '2092.00'), '2092')
  assert.deepEqual(indexEntryRatings([
    { entry_id: 'e', member_id: 'm1', member_order: 1, rating_type: 'tnl', rating_value: '3.10', organizer_value: null },
    { entry_id: 'e', member_id: 'm2', member_order: 2, rating_type: 'lts', rating_value: '12', organizer_value: '9' },
    { entry_id: 'e', member_id: 'm2', member_order: 2, rating_type: 'tnl', rating_value: null, organizer_value: '4' },
  ]), { e: {
    1: [{ type: 'tnl', value: 3.1, player: 3.1, organizer: null, memberId: 'm1' }],
    2: [{ type: 'lts', value: 9, player: 12, organizer: 9, memberId: 'm2' }, { type: 'tnl', value: 4, player: null, organizer: 4, memberId: 'm2' }],
  } })
})

test('the setting travels in the registration draft and the settings patch', () => {
  assert.equal(registrationDraftFields({}).player_rating, 'off')
  assert.equal(registrationDraftFields({ player_rating: 'required' }).player_rating, 'required')
  const form = { ...registrationDraftFields({}), player_rating: 'optional' }
  assert.equal(hasRegistrationRules(form), true)
  assert.equal(registrationPatch(form).player_rating, 'optional')
  assert.equal(registrationPatch({ ...form, player_rating: 'bogus' }).player_rating, 'off')
})

test('server rating codes translate', () => {
  const t = key => `T:${key}`
  assert.equal(errorMessage('rating.required', t), 'T:playerRating.errors.required')
})

test('RU, EN and LT rating messages share the same key set', async () => {
  const { playerRatingMessages } = await import('../src/i18n/playerRating.js')
  const keys = obj => Object.entries(obj).flatMap(([k, v]) => typeof v === 'object' ? keys(v).map(s => `${k}.${s}`) : [k]).sort()
  const ru = keys(playerRatingMessages.ru)
  assert.deepEqual(keys(playerRatingMessages.en), ru)
  assert.deepEqual(keys(playerRatingMessages.lt), ru)
  for (const kind of [...ratingTypesFor('tennis'), ...ratingTypesFor('padel')]) assert.ok(playerRatingMessages.lt.kinds[kind])
})

const r = (type, value) => ({ type, value })
const pair = id => ({ id, entry_members: [{ member_order: 1 }, { member_order: 2 }] })
const solo = id => ({ id, entry_members: [{ member_order: 1 }] })

test('seeding by a kind: strongest first, lower is better for LTS, unrated last in their order', () => {
  const entries = ['a', 'b', 'c', 'd', 'e'].map(solo)
  const index = { a: { 1: [r('tnl', 3)] }, b: { 1: [r('tnl', 5), r('lts', 40)] }, d: { 1: [r('lts', 7)] }, e: { 1: [r('tnl', 4)] } }
  assert.deepEqual(ratingSeedOrder(entries, index, 'tnl'), { order: ['b', 'e', 'a', 'c', 'd'], rated: 3, unrated: 2 })
  assert.deepEqual(ratingSeedOrder(entries, index, 'lts').order, ['d', 'b', 'a', 'c', 'e'])
  assert.deepEqual(ratingKindCounts('tennis', entries, index), { tnl: 3, lts: 2 })
  assert.equal(defaultSeedKind('tennis', entries, index), 'tnl')
  assert.equal(defaultSeedKind('tennis', entries, {}), '')
})

test('pairs: average of both, both rated before one rated; ties by lot', () => {
  const entries = ['p', 'q', 'r', 's'].map(pair)
  const index = {
    p: { 1: [r('padel_level', 6)] },                                  // one player only: tier 1
    q: { 1: [r('padel_level', 3)], 2: [r('padel_level', 4)] },        // 3.5
    r: { 1: [r('padel_level', 4)], 2: [r('padel_level', 4)] },        // 4
    s: { 1: [r('padel_level', 4.5)], 2: [r('padel_level', 2.5)] },    // 3.5, ties with q
  }
  const first = ratingSeedOrder(entries, index, 'padel_level', () => 0.1).order
  assert.deepEqual(first.slice(0, 1), ['r'])
  assert.deepEqual(first.slice(3), ['p'])
  const lots = [0.9, 0.1, 0.5, 0.2]
  let i = 0
  assert.deepEqual(ratingSeedOrder(entries, index, 'padel_level', () => lots[i++]).order, ['r', 'q', 's', 'p'])
  i = 0
  const swapped = [0.9, 0.6, 0.5, 0.1]
  assert.deepEqual(ratingSeedOrder(entries, index, 'padel_level', () => swapped[i++]).order, ['r', 's', 'q', 'p'])
})
