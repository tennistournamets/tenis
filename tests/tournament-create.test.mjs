import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPayload, createTournamentFromForm, defaultCreateForm } from '../src/lib/tournamentCreate.js'

test('the create payload follows the sport, format and visibility like the wizard did', () => {
  const padel = createPayload({ ...defaultCreateForm(), sport: 'padel', format: 'americano', points_per_match: 21, gender: 'mixed', visibility: 'private', name: 'Americano' }, 'americano')
  assert.equal(padel.p_category, 'doubles')
  assert.equal(padel.p_doubles_pairing_mode, 'pick_random')
  assert.equal(padel.p_set_format, null)
  assert.deepEqual(padel.p_scoring_config, { points_per_match: 21, gender: 'men' }, 'no mixed when partners rotate')
  assert.equal(padel.p_is_public, false)

  const tennis = createPayload({ ...defaultCreateForm(), category: 'doubles', gender: 'mixed', format: 'groups_playoff', advance_per_group: 3, name: 'Lyga' }, 'lyga')
  assert.equal(tennis.p_doubles_pairing_mode, 'pre_agreed')
  assert.deepEqual(tennis.p_format_config, { advance_per_group: 3 })
  assert.equal(tennis.p_scoring_config.gender, 'mixed')
  assert.equal(tennis.p_scoring_config.tennis.game_rule, 'advantage')
})

test('rules, participants (pending) and courts follow the created tournament', async () => {
  const calls = []
  const supabase = {
    rpc: async (name, args) => {
      calls.push([name, args])
      if (name === 'create_tournament') return { data: 'T1', error: null }
      if (name === 'add_manual_entries') return { data: [{ ok: true }, { ok: false }], error: null }
      return { data: null, error: null }
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings_revision: 1 } }) }) }) }),
  }
  const form = { ...defaultCreateForm(), name: 'Cup', registration_capacity: '16', visibility: 'public' }
  const result = await createTournamentFromForm(supabase, form, {
    slug: 'cup', participants: [{ members: ['Ona'] }, { members: ['Rūta'] }], notify: true, courtNames: ['Court 1', 'Court 2'],
  })
  assert.deepEqual(result, { id: 'T1', rulesFailed: false, participantsFailed: 1, courtsFailed: false })
  assert.deepEqual(calls.map(([name]) => name), ['create_tournament', 'update_tournament_settings', 'add_manual_entries', 'save_courts'])
  assert.equal(calls[1][1].p_patch.visibility, 'public')
  assert.equal(calls[2][1].p_status, 'pending')
  assert.equal(calls[2][1].p_notify, true)
  assert.deepEqual(calls[3][1], { p_tournament_id: 'T1', p_courts: [{ name: 'Court 1' }, { name: 'Court 2' }], p_expected_revision: 1 })
})

test('a taken address is passed on to the caller', async () => {
  const supabase = { rpc: async () => ({ data: null, error: { code: '23505', message: 'duplicate' } }) }
  await assert.rejects(createTournamentFromForm(supabase, { ...defaultCreateForm(), name: 'X' }, { slug: 'x' }), error => error.code === '23505')
})
