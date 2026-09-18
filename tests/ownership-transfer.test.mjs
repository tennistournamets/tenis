import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const transfer = async (t, actor, who, rev = null) =>
  (await asActor(ctx, actor, 'select transfer_tournament_ownership($1,$2,$3) r', [t.id, `${who}@example.test`, rev ?? await revision(t.id)])).rows[0].r
const roles = async t => Object.fromEntries((await ctx.db.query('select user_id, role from tournament_admins where tournament_id=$1', [t.id])).rows.map(r => [r.user_id, r.role]))
const events = async t => (await ctx.db.query('select actor_user_id, action, target_user_id, details from tournament_admin_events where tournament_id=$1 order by created_at', [t.id])).rows

test('only the owner transfers ownership; the previous owner becomes an editor and the transfer is journaled', async () => {
  const t = await fixture(ctx)
  for (const actor of ['editor', 'counter', 'outsider', 'platform_admin', 'anon']) {
    await assertDeniedUnchanged(ctx, actor, 'select transfer_tournament_ownership($1,$2,$3)', [t.id, 'outsider@example.test', await revision(t.id)])
  }
  await assertDeniedUnchanged(ctx, 'owner', 'select transfer_tournament_ownership($1,$2,$3)', [t.id, 'nobody@example.test', await revision(t.id)], /access\.userNotFound/)
  await assertDeniedUnchanged(ctx, 'owner', 'select transfer_tournament_ownership($1,$2,$3)', [t.id, 'owner@example.test', await revision(t.id)], /access\.transferSelf/)
  await assertDeniedUnchanged(ctx, 'owner', 'select transfer_tournament_ownership($1,$2,$3)', [t.id, 'outsider@example.test', -1], /drafts\.conflict/)
  const before = await revision(t.id)
  const result = await transfer(t, 'owner', 'outsider')
  assert.equal(result.new_owner_user_id, ctx.actors.outsider)
  assert.equal(result.your_role, 'editor')
  assert.equal(result.settings_revision, before + 1)
  const after = await roles(t)
  assert.equal(after[ctx.actors.outsider], 'owner')
  assert.equal(after[ctx.actors.owner], 'editor')
  assert.equal(after[ctx.actors.editor], 'editor')
  assert.equal((await ctx.db.query('select created_by from tournaments where id=$1', [t.id])).rows[0].created_by, ctx.actors.outsider)
  assert.deepEqual(await events(t), [{ actor_user_id: ctx.actors.owner, action: 'ownership_transferred', target_user_id: ctx.actors.outsider, details: { previous_owner: ctx.actors.owner } }])
  // The former owner is now an editor: no second transfer, but the new owner may hand it back.
  await assertDeniedUnchanged(ctx, 'owner', 'select transfer_tournament_ownership($1,$2,$3)', [t.id, 'editor@example.test', await revision(t.id)])
  await transfer(t, 'outsider', 'owner')
  assert.equal((await roles(t))[ctx.actors.owner], 'owner')
  assert.equal((await roles(t))[ctx.actors.outsider], 'editor')
  assert.equal((await events(t)).length, 2)
})

test('an existing assistant becomes the owner without a duplicate membership; the journal is readable by managers only', async () => {
  const t = await fixture(ctx)
  await transfer(t, 'owner', 'editor')
  const after = await roles(t)
  assert.equal(after[ctx.actors.editor], 'owner')
  assert.equal(after[ctx.actors.owner], 'editor')
  assert.equal((await ctx.db.query('select count(*)::int n from tournament_admins where tournament_id=$1', [t.id])).rows[0].n, 3)
  for (const actor of ['owner', 'editor']) assert.equal((await asActor(ctx, actor, 'select action from tournament_admin_events where tournament_id=$1', [t.id])).rows.length, 1)
  for (const actor of ['counter', 'outsider', 'platform_admin']) assert.deepEqual((await asActor(ctx, actor, 'select action from tournament_admin_events where tournament_id=$1', [t.id])).rows, [])
  await assert.rejects(asActor(ctx, 'anon', 'select action from tournament_admin_events where tournament_id=$1', [t.id]), /permission denied/)
  for (const actor of ['owner', 'editor']) {
    await assertDeniedUnchanged(ctx, actor, "insert into tournament_admin_events(tournament_id,action) values ($1,'forged') returning id", [t.id], /permission denied/)
  }
  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
})
