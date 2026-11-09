import assert from 'node:assert/strict'
import test from 'node:test'
import { filterCounts, filterUsers, latestTournament, sortUsers } from '../src/lib/platformUsers.js'

const users = [
  { id: 'a', name: 'Ona Petraitė', email: 'ona@club.lt', created_at: '2026-10-01T10:00:00Z', last_seen_at: '2026-11-08T10:00:00Z', tournaments: [{ created_at: '2026-11-01T00:00:00Z' }] },
  { id: 'b', name: null, email: 'coach@padel.lt', created_at: '2026-11-05T10:00:00Z', last_seen_at: null, tournaments: [] },
  { id: 'c', name: 'Jonas', email: 'jonas@mail.lt', created_at: '2026-09-01T10:00:00Z', last_seen_at: '2026-11-01T10:00:00Z', tournaments: [{ created_at: '2026-10-20T00:00:00Z' }, { created_at: '2026-10-01T00:00:00Z' }] },
]
const ids = (list) => list.map((user) => user.id)

test('search matches name or email, case-insensitive, and survives a missing name', () => {
  assert.deepEqual(ids(filterUsers(users, { query: 'PETRAIT' })), ['a'])
  assert.deepEqual(ids(filterUsers(users, { query: 'padel' })), ['b'])
  assert.deepEqual(ids(filterUsers(users, { query: '  ' })), ['a', 'b', 'c'])
})

test('filters by having tournaments and counts each filter', () => {
  assert.deepEqual(ids(filterUsers(users, { filter: 'withTournaments' })), ['a', 'c'])
  assert.deepEqual(ids(filterUsers(users, { filter: 'withoutTournaments', query: 'coach' })), ['b'])
  assert.deepEqual(filterCounts(users), { all: 3, withTournaments: 2, withoutTournaments: 1 })
})

test('sorts by joining date, last activity (never last) and tournament count', () => {
  assert.deepEqual(ids(sortUsers(users, 'created')), ['b', 'a', 'c'])
  assert.deepEqual(ids(sortUsers(users, 'lastSeen')), ['a', 'c', 'b'])
  assert.deepEqual(ids(sortUsers(users, 'tournaments')), ['c', 'a', 'b'])
  assert.deepEqual(ids(sortUsers(users, 'unknown')), ['b', 'a', 'c'])
  assert.deepEqual(ids(users), ['a', 'b', 'c'], 'input is not reordered')
  assert.equal(latestTournament(users[2]).created_at, '2026-10-20T00:00:00Z')
  assert.equal(latestTournament(users[1]), null)
})
