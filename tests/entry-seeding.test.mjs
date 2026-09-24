import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const seeds = async t => (await ctx.db.query('select id,seed_order from entries where tournament_id=$1', [t.id])).rows
  .reduce((map, r) => ({ ...map, [r.id]: r.seed_order }), {})
const setSeeds = (t, ids, actor = 'owner') => asActor(ctx, actor, 'select set_entry_seed_order($1,$2::uuid[])', [t.id, ids])

test('organizers reorder the approved field; the snapshot exposes the order', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', count: 3 })
  const [a, b, c] = t.entries
  await setSeeds(t, [c, a, b])
  assert.deepEqual(await seeds(t), { [c]: 1, [a]: 2, [b]: 3 })
  await setSeeds(t, [b, c], 'editor')
  assert.deepEqual(await seeds(t), { [b]: 1, [c]: 2, [a]: null })
  const sync = (await asActor(ctx, 'owner', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.deepEqual(Object.fromEntries(sync.entries.map(e => [e.id, e.seed_order])), { [b]: 1, [c]: 2, [a]: null })
})

test('seeding is refused to other roles, after the start, and for foreign or repeated entries', async () => {
  const t = await fixture(ctx, { status: 'registration_open', count: 2 })
  const other = await fixture(ctx, { status: 'registration_open', count: 1 })
  for (const actor of ['counter', 'anon']) await assertDeniedUnchanged(ctx, actor, 'select set_entry_seed_order($1,$2::uuid[])', [t.id, t.entries], /Not allowed|permission denied/)
  await assertDeniedUnchanged(ctx, 'owner', 'select set_entry_seed_order($1,$2::uuid[])', [t.id, [t.entries[0], t.entries[0]]], /seeding\.duplicate/)
  await assertDeniedUnchanged(ctx, 'owner', 'select set_entry_seed_order($1,$2::uuid[])', [t.id, [t.entries[0], other.entries[0]]], /seeding\.foreignEntry/)
  const started = await fixture(ctx, { status: 'in_progress', count: 2 })
  await assertDeniedUnchanged(ctx, 'owner', 'select set_entry_seed_order($1,$2::uuid[])', [started.id, started.entries], /seeding\.locked/)
})

test('the seeding migration replays cleanly over itself', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', count: 2 })
  await setSeeds(t, [...t.entries].reverse())
  const snap = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), snap)
})
