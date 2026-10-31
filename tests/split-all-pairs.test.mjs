import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const state = async id => (await asActor(ctx, 'owner', 'select get_tournament_entry_state($1) s', [id])).rows[0].s
const pairSave = (t, pairs, replace, s, actor = 'owner') => asActor(ctx, actor, 'select save_tournament_pairs($1,$2,$3,$4,$5,$6)',
  [t.id, JSON.stringify(pairs), replace, JSON.stringify(s.entries), JSON.stringify(s.matches), s.settings_revision])
const mids = s => s.entries.flatMap(e => e.entry_members.map(m => m.id))

async function paired(count = 4) {
  const t = await fixture(ctx, { category: 'doubles', pairing: 'pick_random', status: 'registration_closed', count })
  const s = await state(t.id)
  const ids = mids(s)
  const pairs = []
  for (let i = 0; i < ids.length; i += 2) pairs.push([ids[i], ids[i + 1]])
  await pairSave(t, pairs, false, s)
  return { t, ids }
}

test('an empty list with replace splits every pair; players, ratings and the bracket follow', async () => {
  const { t, ids } = await paired(4)
  await asActor(ctx, 'owner', 'select set_member_rating($1,$2,$3)', [ids[1], 'tnl', 4.5])
  await asActor(ctx, 'owner', 'select generate_bracket($1)', [t.id])
  const s = await state(t.id)
  assert.equal(s.entries.length, 2)
  assert.ok(s.matches.length > 0)

  const n = (await pairSave(t, [], true, s, 'editor')).rows[0].save_tournament_pairs
  assert.equal(n, 0)
  const after = await state(t.id)
  assert.equal(after.entries.length, 4)
  assert.ok(after.entries.every(e => e.entry_members.length === 1 && e.entry_members[0].member_order === 1))
  assert.deepEqual(mids(after).sort(), [...ids].sort())
  assert.equal(after.matches.length, 0)
  const rating = (await ctx.db.query('select organizer_value from entry_member_ratings where member_id=$1', [ids[1]])).rows[0]
  assert.equal(Number(rating.organizer_value), 4.5)
})

test('a new pairing still needs a pair, and locks and conflicts still apply', async () => {
  const fresh = await fixture(ctx, { category: 'doubles', pairing: 'pick_random', status: 'registration_closed', count: 2 })
  await assert.rejects(pairSave(fresh, [], false, await state(fresh.id)), /At least one complete pair required/)

  const { t } = await paired(4)
  const stale = await state(t.id)
  await ctx.db.query('update tournaments set settings_revision = settings_revision + 1 where id=$1', [t.id])
  const before = await snapshot(ctx)
  await assert.rejects(pairSave(t, [], true, stale), /structureConflict/)
  assert.deepEqual(await snapshot(ctx), before)

  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  await assert.rejects(pairSave(t, [], true, await state(t.id)), /rulesLocked/)
  await assert.rejects(pairSave(t, [], true, await state(t.id), 'counter'), /Not allowed/)
  await reapplyForwardMigrations(ctx)
})
