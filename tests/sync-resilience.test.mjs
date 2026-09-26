import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createSnapshotRefresh } from '../src/lib/tournamentSync.js'
import { createTimeoutFetch } from '../src/lib/fetchTimeout.js'
import { errorKey } from '../src/lib/errorMessages.js'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(r => setImmediate(r))

test('a slow successful snapshot is applied even though the poll invalidated it', async () => {
  let clock = 0
  const reads = [], applied = []
  const q = createSnapshotRefresh({ read: () => { const d = deferred(); reads.push(d); return d.promise },
    apply: x => applied.push(x), onError: assert.fail, now: () => clock, slowReadMs: 10000 })
  const done = q.refresh()
  clock = 30000; q.request() // the 30 s recovery poll fires while the read is still running
  clock = 35000; reads[0].resolve('slow'); await tick()
  assert.deepEqual(applied, ['slow'], 'shown immediately instead of being thrown away')
  assert.equal(reads.length, 2, 'and read once more for the event that arrived meanwhile')
  reads[1].resolve('fresh'); assert.equal(await done, true)
  assert.deepEqual(applied, ['slow', 'fresh']); q.dispose()
})

test('continuous invalidation cannot starve the page: the second response is applied', async () => {
  const reads = [], applied = []
  const q = createSnapshotRefresh({ read: () => { const d = deferred(); reads.push(d); return d.promise },
    apply: x => applied.push(x), onError: assert.fail, now: () => 0 })
  const done = q.refresh()
  q.request(); reads[0].resolve('r1'); await tick()
  assert.deepEqual(applied, [], 'a fast invalidated read is still discarded once')
  q.request(); reads[1].resolve('r2'); await tick()
  assert.deepEqual(applied, ['r2'])
  reads[2].resolve('r3'); assert.equal(await done, true)
  assert.deepEqual(applied, ['r2', 'r3']); q.dispose()
})

test('client timeout aborts a stalled request with a TimeoutError', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const stalled = (_url, init) => new Promise((_, reject) => {
    signal = init.signal
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })
  const request = createTimeoutFetch(stalled, 1000)('https://x.test/rest/v1/rpc/get_tournament_sync_state')
  t.mock.timers.tick(999); await tick(); assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await assert.rejects(request, error => error.name === 'TimeoutError' && errorKey(`${error.name}: ${error.message}`) === 'serverErrors.timeout')
})

test('client timeout keeps the caller abort signal and clean successes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fast = createTimeoutFetch(async () => 'ok', 1000)
  assert.equal(await fast('/a'), 'ok')
  const outer = new AbortController()
  let seen
  const hanging = createTimeoutFetch((_u, init) => new Promise((_, reject) => {
    seen = init.signal; init.signal.addEventListener('abort', () => reject(new Error('caller aborted')))
  }), 1000)
  const pending = hanging('/b', { signal: outer.signal })
  outer.abort()
  await assert.rejects(pending, /caller aborted/)
  assert.equal(seen.aborted, true)
})

test('the supabase client uses the timeout fetch; the admin error screen can retry', () => {
  assert.match(readFileSync(new URL('../src/lib/supabase.js', import.meta.url), 'utf8'), /global: \{ fetch: createTimeoutFetch\(/)
  const view = readFileSync(new URL('../src/views/AdminTournamentView.vue', import.meta.url), 'utf8')
  assert.match(view, /v-else-if="errorText && !tournament"[\s\S]{0,300}@click="retryLoad"/)
})
