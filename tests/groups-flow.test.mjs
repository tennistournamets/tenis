import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  advanceOptions, changesField, compareGroupMatches, correctionTexts, groupMatchProgress, groupRoundLabel,
  groupsError, playoffPreviewItems, rosterMismatch,
} from '../src/lib/groupsFlow.js'
import { customDisplayName, entryDisplayNames } from '../src/lib/entryDisplay.js'
import { groupsFlowMessages } from '../src/i18n/groupsFlow.js'

const t = (key, params = {}) => `${key}${Object.keys(params).length ? JSON.stringify(params) : ''}`
const tLabels = (key, params = {}) => ({ 'admin.group': 'Group', 'bracket.roundN': `Round ${params.n}` }[key] ?? key)
const match = (a, b, extra = {}) => ({ side_a_entry_id: a, side_b_entry_id: b, ...extra })

test('B5: generated matches are stale when the approved field changes, in any format', () => {
  const approved = ['a', 'b', 'c'].map(id => ({ id }))
  assert.deepEqual(rosterMismatch(approved, []), { stale: false, missing: [], extra: [] })
  const rr = [match('a', 'b'), match('a', 'c'), match('b', 'c')]
  assert.equal(rosterMismatch(approved, rr).stale, false)
  // A rejected entry still in the matches, a newly approved one without any.
  assert.deepEqual(rosterMismatch([{ id: 'a' }, { id: 'b' }], rr), { stale: true, missing: [], extra: ['c'] })
  assert.deepEqual(rosterMismatch([...approved, { id: 'd' }], rr), { stale: true, missing: ['d'], extra: [] })
  // A knockout draw with a BYE covers the field through round one.
  assert.equal(rosterMismatch(approved, [match('a', null), match('b', 'c'), match('a', null, { round_number: 2 })]).stale, false)
  assert.equal(changesField('approved', 'rejected'), true)
  assert.equal(changesField('pending', 'approved'), true)
  assert.equal(changesField('approved', 'pending'), true)
  assert.equal(changesField('pending', 'rejected'), false)
})

test('B8: group matches carry their group letter and sort tour by tour', () => {
  const names = { g1: 'A', g2: 'B' }
  assert.equal(groupRoundLabel({ group_id: 'g2', round_number: 1002 }, names, tLabels), 'Group B · Round 2')
  assert.equal(groupRoundLabel({ group_id: 'x', round_number: 3 }, names, tLabels), 'Group · Round 3')
  const rows = [
    { id: 'b1', round_number: 1001, match_number: 1 }, { id: 'a2', round_number: 2, match_number: 1 },
    { id: 'a1', round_number: 1, match_number: 1 }, { id: 'b2', round_number: 1002, match_number: 1 },
  ]
  assert.deepEqual(rows.sort(compareGroupMatches).map(r => r.id), ['a1', 'b1', 'a2', 'b2'])
  assert.deepEqual(groupMatchProgress([{ stage: 'group', status: 'finished' }, { stage: 'group', status: 'ready' }, { stage: 'winners', status: 'finished' }]), { total: 2, done: 1 })
})

test('B2: advance choices never exceed the smallest group', () => {
  assert.deepEqual(advanceOptions(9, 3), [1, 2, 3])
  assert.deepEqual(advanceOptions(9, 4), [1, 2])
  assert.deepEqual(advanceOptions(40, 2), [1, 2, 3, 4])
  assert.deepEqual(advanceOptions(3, 2), [1])
})

test('B1/B3: playoff preview items and correction texts', () => {
  const side = (name, seed, group, rank) => ({ name, seed, group_name: group, group_rank: rank })
  const items = playoffPreviewItems({ pairs: [{ match_number: 1, a: side('Ann', 1, 'A', 1), b: null }, { match_number: 2, a: side('Bob', 4, 'B', 2), b: side('Cid', 5, 'C', 2) }] }, t)
  assert.equal(items.length, 2)
  assert.match(items[0].effect, /pairBye/)
  assert.match(items[1].teams, /Bob .* — Cid/)
  assert.match(items[1].effect, /pairPlay/)
  const reseed = correctionTexts({ reseed_playoff: true, group_stage: true, schedule_matches: 2, schedule_published: 1 }, t)
  assert.match(reseed.intro, /correctionReseed/)
  assert.match(reseed.warning, /correctionSchedule\{"n":2,"published":1\}/)
  assert.doesNotMatch(correctionTexts({ reseed_playoff: true, schedule_matches: 0 }, t).warning, /correctionSchedule/)
  assert.match(correctionTexts({ reseed_playoff: false }, t).intro, /scoringFlow\.correctionIntro/)
  assert.equal(groupsError('groupsFlow.regenerateLocked', t), 'groupsFlow.regenerateLocked')
})

test('B10: a chosen bracket name wins over member names; default names do not', () => {
  const members = names => names.map((member_name, i) => ({ member_name, member_order: i + 1 }))
  const pair = { entry_type: 'doubles', display_name: 'Ann / Bob', entry_members: members(['Ann', 'Bob']) }
  assert.equal(customDisplayName(pair), '')
  assert.deepEqual(entryDisplayNames(pair), ['Ann', 'Bob'])
  assert.deepEqual(entryDisplayNames({ ...pair, display_name: 'Rockets' }), ['Rockets'])
  assert.deepEqual(entryDisplayNames({ entry_type: 'singles', display_name: 'Anna K.', entry_members: members(['Anna Karenina']) }), ['Anna K.'])
  assert.deepEqual(entryDisplayNames({ entry_type: 'singles', display_name: 'Anna', entry_members: members(['Anna']) }), ['Anna'])
  assert.deepEqual(entryDisplayNames({ entry_type: 'singles', display_name: 'Solo', entry_members: [] }), ['Solo'])
})

test('groupsFlow strings exist in every locale', () => {
  const keys = Object.keys(groupsFlowMessages.ru).sort()
  for (const locale of ['en', 'lt']) assert.deepEqual(Object.keys(groupsFlowMessages[locale]).sort(), keys, locale)
})
