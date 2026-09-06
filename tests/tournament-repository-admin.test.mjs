import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readAdminTournamentSnapshot } from '../src/lib/tournamentRepository.js'

function clientFor(role, errors = {}) {
  const calls = []
  const data = { tournament: { id: 'cup' }, matches: [] }
  return { calls, data, async rpc(name, args) {
    assert.equal(args.p_tournament_id, 'cup')
    calls.push(name)
    return { data: { get_tournament_sync_state: data, get_my_tournament_role: role,
      get_tournament_admins_with_email: [{ user_id: 'owner', role: 'owner' }] }[name], error: errors[name] || null }
  } }
}

test('admin snapshot always verifies current role, but only refreshes the admin list on request', async () => {
  const client = clientFor('editor')
  assert.deepEqual(await readAdminTournamentSnapshot(client, 'cup'), { data: client.data, role: 'editor', adminRows: undefined })
  assert.equal(client.calls.length, 2)
  const full = await readAdminTournamentSnapshot(client, 'cup', { includeAdmins: true })
  assert.equal(full.adminRows[0].role, 'owner')
  assert.equal(client.calls.filter(name => name === 'get_my_tournament_role').length, 2)
  assert.equal(client.calls.filter(name => name === 'get_tournament_admins_with_email').length, 1)
})

test('counter and revoked roles clear the admin list without asking for emails', async () => {
  for (const role of ['counter', null]) {
    const client = clientFor(role)
    const result = await readAdminTournamentSnapshot(client, 'cup', { includeAdmins: true })
    assert.equal(result.role, role)
    assert.deepEqual(result.adminRows, [])
    assert.equal(client.calls.includes('get_tournament_admins_with_email'), false)
  }
})

test('a failed part of the admin snapshot rejects the whole read instead of applying partial data', async () => {
  for (const name of ['get_tournament_sync_state', 'get_my_tournament_role', 'get_tournament_admins_with_email']) {
    const error = { message: `failed ${name}` }
    await assert.rejects(readAdminTournamentSnapshot(clientFor('owner', { [name]: error }), 'cup', { includeAdmins: true }), value => value === error)
  }
})
