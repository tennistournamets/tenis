import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TIE_PRESETS, genderFits, labelledLine, lineGendersOk, lineType, lineupDraft, lineupDraftError,
  lineupsByLine, membersById, playersNeeded, presetOf, splitRubbers, tieError, tieFromConfig, tieToConfig,
} from '../src/lib/teamTie.js'
import { customDisplayName, entryDisplayNames, matchSideLabel } from '../src/lib/entryDisplay.js'

test('template: presets round-trip, server shape, validation, players needed', () => {
  for (const preset of TIE_PRESETS) assert.equal(presetOf(preset.lines), preset.id)
  assert.equal(presetOf(['XS', 'MD']), 'custom')
  const tie = tieFromConfig({ lines: [{ type: 'MS' }, { type: 'WS' }, { type: 'XD' }], win_rule: 'games', decider: { type: 'XS' }, roster_min: 3, roster_max: 8 })
  assert.deepEqual(tie, { lines: ['MS', 'WS', 'XD'], win_rule: 'games', decider: 'XS', roster_min: 3, roster_max: 8 })
  assert.deepEqual(tieToConfig(tie).lines, [{ type: 'MS' }, { type: 'WS' }, { type: 'XD' }])
  assert.deepEqual(tieFromConfig(null).lines, ['XS', 'XS', 'AD'])
  assert.equal(tieError(tie), null)
  assert.equal(tieError({ ...tie, lines: [] }), 'team.template.errorLines')
  assert.equal(tieError({ ...tie, lines: ['ZZ'] }), 'team.template.errorLines')
  assert.equal(tieError({ ...tie, roster_min: 9, roster_max: 4 }), 'team.template.errorRoster')
  assert.equal(playersNeeded(['XS', 'XS', 'AD']), 2)
  assert.equal(playersNeeded(['MD', 'MD', 'MD', 'WD', 'XD']), 10)
  assert.equal(lineType(tie, 4), 'XS', 'line after the template is the decider')
})

test('gender rules mirror save_tie_lineup', () => {
  assert.ok(genderFits('MS', 'male') && !genderFits('MS', 'female') && !genderFits('MS', null))
  assert.ok(genderFits('AD', null) && genderFits('XD', 'female'))
  assert.ok(lineGendersOk('XD', ['male', 'female']))
  assert.ok(!lineGendersOk('XD', ['male', 'male']))
  assert.ok(lineGendersOk('XD', ['female']))
  assert.ok(!lineGendersOk('WD', ['female', null]))
})

test('lineup drafts: sizes, duplicates, one singles and one doubles per player', () => {
  const tie = tieFromConfig({ lines: ['XS', 'XS', 'AD'] })
  const lines = [1, 2, 3].map(n => ({ id: `l${n}`, line_no: n }))
  const members = { a: { gender: 'male' }, b: { gender: 'female' }, c: { gender: 'male' } }
  const draft = lineupDraft(tie, lines, lineupsByLine([{ line_id: 'l1', side: 'A', slot: 1, member_id: 'a' }]), 'A')
  assert.deepEqual(draft, { 1: ['a'], 2: [''], 3: ['', ''] })
  assert.equal(lineupDraftError(tie, lines, draft, members), null, 'a partial draft is fine')
  assert.equal(lineupDraftError(tie, lines, draft, members, { complete: true }), 'team.errors.lineupIncomplete')
  assert.equal(lineupDraftError(tie, lines, { 1: ['a'], 2: ['a'], 3: ['b', 'c'] }, members), 'team.errors.playerLineLimit')
  assert.equal(lineupDraftError(tie, lines, { 1: ['a'], 2: ['b'], 3: ['c', 'c'] }, members), 'team.errors.invalidLineup')
  assert.equal(lineupDraftError(tie, lines, { 1: ['a'], 2: ['b'], 3: ['b', 'c'] }, members, { complete: true }), null)
})

test('snapshot helpers: ties keep the lists, lines carry player names', () => {
  const tie = { id: 't1', side_a_entry_id: 'ea', side_b_entry_id: 'eb' }
  const line = { id: 'l1', parent_match_id: 't1', line_no: 1, side_a_entry_id: 'ea', side_b_entry_id: 'eb' }
  const { main, linesByTie } = splitRubbers([line, tie])
  assert.deepEqual(main, [tie])
  assert.deepEqual(linesByTie.t1, [line])
  const entries = [
    { id: 'ea', entry_type: 'team', display_name: 'Aces', entry_members: [{ id: 'm1', member_name: 'Jonas', member_order: 1 }] },
    { id: 'eb', entry_type: 'team', display_name: 'Smash', entry_members: [{ id: 'm2', member_name: 'Mantas', member_order: 1 }] },
  ]
  const members = membersById(entries)
  const lineups = lineupsByLine([{ line_id: 'l1', side: 'A', slot: 1, member_id: 'm1' }])
  const labelled = labelledLine(line, lineups, members, id => entries.find(e => e.id === id).display_name)
  assert.equal(labelled.side_a_label, 'Jonas (Aces)')
  assert.equal(labelled.side_b_label, 'Smash', 'a hidden lineup shows the team')
  assert.equal(matchSideLabel(labelled, 'a', {}), 'Jonas (Aces)')
  assert.deepEqual(entryDisplayNames(entries[0]), ['Aces'], 'a team shows its name, not its roster')
  assert.equal(customDisplayName(entries[0]), '')
})
