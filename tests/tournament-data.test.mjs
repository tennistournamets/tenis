import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublicTournamentReader, readTournamentSnapshot } from '../src/lib/tournamentRepository.js'
import { buildGroupsView, groupSetsByMatch, indexEntries, indexLiveScores } from '../src/lib/tournamentProjections.js'

function fakeClient({ lookups = [], snapshots = [] } = {}) {
  const calls = { lookups: [], snapshots: [] }
  return {
    calls,
    from(table) {
      assert.equal(table, 'tournaments')
      return {
        select(fields) {
          assert.equal(fields, 'id')
          return {
            eq(field, slug) {
              assert.equal(field, 'slug')
              return { async maybeSingle() {
                calls.lookups.push(slug)
                assert.ok(lookups.length, 'unexpected slug lookup')
                return lookups.shift()
              } }
            },
          }
        },
      }
    },
    async rpc(name, params) {
      assert.equal(name, 'get_tournament_sync_state')
      calls.snapshots.push(params.p_tournament_id)
      assert.ok(snapshots.length, 'unexpected snapshot read')
      return snapshots.shift()
    },
  }
}

const found = id => ({ data: { id }, error: null })
const absent = { data: null, error: null }
const snapshot = (id, slug, matches = []) => ({ data: { tournament: { id, slug }, matches }, error: null })

test('public refresh resolves the slug once and reads a new snapshot on every refresh', async () => {
  const initial = snapshot('a', 'cup'), updated = snapshot('a', 'cup', [{ id: 'new-match' }])
  const client = fakeClient({ lookups: [found('a')], snapshots: [initial, updated] })
  const resolved = []
  const read = createPublicTournamentReader(client, 'cup', { onResolve: id => resolved.push(id) })
  assert.equal(await read(), initial.data)
  assert.equal(await read(), updated.data)
  assert.deepEqual(client.calls, { lookups: ['cup'], snapshots: ['a', 'a'] })
  assert.deepEqual(resolved, ['a'])
})

test('snapshot query errors throw without replacing a valid cache or returning empty data', async () => {
  const error = { message: 'network unavailable' }, current = snapshot('a', 'cup')
  const client = fakeClient({ lookups: [found('a')], snapshots: [current, { data: null, error }, current] })
  const read = createPublicTournamentReader(client, 'cup')
  await read()
  await assert.rejects(read(), value => value === error)
  assert.equal(await read(), current.data)
  assert.deepEqual(client.calls, { lookups: ['cup'], snapshots: ['a', 'a', 'a'] })
})

test('a failed slug lookup can be retried and does not become a not-found response', async () => {
  const error = { message: 'lookup unavailable' }, current = snapshot('a', 'cup')
  const client = fakeClient({ lookups: [{ data: null, error }, found('a')], snapshots: [current] })
  const read = createPublicTournamentReader(client, 'cup')
  await assert.rejects(read(), value => value === error)
  assert.equal(await read(), current.data)
  assert.deepEqual(client.calls.lookups, ['cup', 'cup'])
})

test('not-found is not cached, so a newly visible tournament can appear on the next refresh', async () => {
  const current = snapshot('a', 'cup')
  const client = fakeClient({ lookups: [absent, found('a')], snapshots: [current] })
  const read = createPublicTournamentReader(client, 'cup')
  assert.equal(await read(), null)
  assert.equal(await read(), current.data)
  assert.deepEqual(client.calls, { lookups: ['cup', 'cup'], snapshots: ['a'] })
})

test('a renamed tournament is cleared and another tournament at the old slug is resolved immediately', async () => {
  const current = snapshot('a', 'cup'), renamed = snapshot('a', 'new-cup'), replacement = snapshot('b', 'cup')
  const client = fakeClient({ lookups: [found('a'), found('b')], snapshots: [current, renamed, replacement] })
  const resolved = []
  const read = createPublicTournamentReader(client, 'cup', { onResolve: id => resolved.push(id) })
  assert.equal(await read(), current.data)
  assert.equal(await read(), replacement.data)
  assert.deepEqual(resolved, ['a', null, 'b'])
  assert.deepEqual(client.calls, { lookups: ['cup', 'cup'], snapshots: ['a', 'a', 'b'] })
})

test('a rename between initial lookup and snapshot never displays the renamed tournament', async () => {
  const client = fakeClient({ lookups: [found('a'), absent], snapshots: [snapshot('a', 'new-cup')] })
  const resolved = []
  const read = createPublicTournamentReader(client, 'cup', { onResolve: id => resolved.push(id) })
  assert.equal(await read(), null)
  assert.deepEqual(resolved, ['a', null])
})

test('revoked access clears the cached ID; restoring access can be detected by a later refresh', async () => {
  const current = snapshot('a', 'cup')
  const client = fakeClient({ lookups: [found('a'), absent, found('a')], snapshots: [current, absent, current] })
  const resolved = []
  const read = createPublicTournamentReader(client, 'cup', { onResolve: id => resolved.push(id) })
  await read()
  assert.equal(await read(), null)
  assert.equal(await read(), current.data)
  assert.deepEqual(resolved, ['a', null, 'a'])
})

test('known invalid data is invalidated before a failed replacement lookup is reported', async () => {
  const error = { message: 'replacement lookup unavailable' }
  const client = fakeClient({ lookups: [found('a'), { data: null, error }], snapshots: [snapshot('a', 'renamed')] })
  let visibleId = 'a'
  const read = createPublicTournamentReader(client, 'cup', { onResolve: id => { visibleId = id } })
  await assert.rejects(read(), value => value === error)
  assert.equal(visibleId, null)
})

test('an inconsistent lookup/snapshot does not loop or reuse an invalid ID', async () => {
  const current = snapshot('a', 'cup')
  const client = fakeClient({ lookups: [found('a'), found('a'), found('a')], snapshots: [absent, current] })
  const read = createPublicTournamentReader(client, 'cup')
  assert.equal(await read(), null)
  assert.equal(await read(), current.data)
  assert.deepEqual(client.calls, { lookups: ['cup', 'cup', 'cup'], snapshots: ['a', 'a'] })
})

test('a second slug change during replacement resolution returns absence instead of stale content', async () => {
  const client = fakeClient({
    lookups: [found('a'), found('b')],
    snapshots: [snapshot('a', 'renamed-a'), snapshot('b', 'renamed-b')],
  })
  const resolved = []
  const read = createPublicTournamentReader(client, 'cup', { onResolve: id => resolved.push(id) })
  assert.equal(await read(), null)
  assert.deepEqual(resolved, ['a', null, 'b', null])
  assert.equal(client.calls.snapshots.length, 2)
})

test('plain snapshot reads distinguish server errors, absence and a valid empty tournament', async () => {
  const error = { message: 'RPC unavailable' }, empty = snapshot('a', 'cup')
  const client = fakeClient({ snapshots: [{ data: null, error }, absent, empty] })
  await assert.rejects(readTournamentSnapshot(client, 'a'), value => value === error)
  assert.equal(await readTournamentSnapshot(client, 'a'), null)
  assert.equal(await readTournamentSnapshot(client, 'a'), empty.data)
})

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

test('shared indexes preserve row identity and set order without mutating the snapshot', () => {
  const entries = freezeDeep([{ id: 'e', name: 'Player' }])
  const sets = freezeDeep([{ id: 's2', match_id: 'm', set_number: 2 }, { id: 's1', match_id: 'm', set_number: 1 }])
  const live = freezeDeep([{ match_id: 'm', score_a: 1 }])
  assert.equal(indexEntries(entries).e, entries[0])
  assert.equal(indexLiveScores(live).m, live[0])
  const grouped = groupSetsByMatch(sets)
  assert.deepEqual(grouped.m, sets)
  assert.equal(grouped.m[0], sets[0])
  assert.notEqual(grouped.m, sets)
  assert.deepEqual(indexEntries([]), {})
  assert.deepEqual(indexLiveScores([]), {})
  assert.deepEqual(groupSetsByMatch([]), {})
})

test('group view orders groups, rounds and matches, excludes playoffs and keeps empty groups', () => {
  const groups = freezeDeep([{ id: 'b', group_index: 2, name: 'B' }, { id: 'a', group_index: 1, name: 'A' }, { id: 'c', group_index: 3, name: 'C' }])
  const matches = freezeDeep([
    { id: 'a21', stage: 'group', group_id: 'a', round_number: 2, match_number: 1 },
    { id: 'a12', stage: 'group', group_id: 'a', round_number: 1, match_number: 2 },
    { id: 'b11', stage: 'group', group_id: 'b', round_number: 1, match_number: 1 },
    { id: 'a11', stage: 'group', group_id: 'a', round_number: 1, match_number: 1 },
    { id: 'playoff', stage: 'winners', group_id: 'a', round_number: 1, match_number: 1 },
    { id: 'orphan', stage: 'group', group_id: 'missing', round_number: 1, match_number: 1 },
  ])
  const standings = freezeDeep({ a: [{ entry_id: 'e', points: 3 }] })
  const result = buildGroupsView(groups, matches, standings)
  assert.deepEqual(result.map(group => [group.id, group.name]), [['a', 'A'], ['b', 'B'], ['c', 'C']])
  assert.deepEqual(result[0].rounds.map(({ round, list }) => [round, list.map(match => match.id)]), [[1, ['a11', 'a12']], [2, ['a21']]])
  assert.equal(result[0].rounds[0].list[0], matches[3])
  assert.equal(result[0].standings, standings.a)
  assert.deepEqual(result[1].standings, [])
  assert.deepEqual(result[2].rounds, [])
  assert.deepEqual(buildGroupsView([], [], {}), [])
})
