import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { asActor, createDatabase, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

const list = async (ctx, actor) => (await asActor(ctx, actor, 'select list_my_tournaments() list')).rows[0].list

async function addMatch(ctx, id, number, a, b, status) {
  const matchId = randomUUID()
  await ctx.db.query(`insert into matches(id,tournament_id,round_number,match_number,side_a_entry_id,side_b_entry_id,status)
    values ($1,$2,1,$3,$4,$5,$6)`, [matchId, id, number, a, b, status])
  return matchId
}

async function seedProgress(ctx) {
  const { id, entries } = await fixture(ctx)
  await ctx.db.query(`insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
    values ($1,'singles','Waiting','waiting@example.test','pending')`, [id])
  await addMatch(ctx, id, 1, entries[0], entries[1], 'finished')
  await addMatch(ctx, id, 2, entries[2], null, 'finished')
  const live = await addMatch(ctx, id, 3, entries[2], entries[3], 'ready')
  await ctx.db.query(`insert into live_scores(match_id,tournament_id,counter_user_id,status,state,history,revision)
    values ($1,$2,$3,'active','{}','[]',1)`, [live, id, ctx.actors.counter])
  return id
}

test('one call returns every tournament of the organizer with its role and card counts', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const id = await seedProgress(ctx)
  const [row] = await list(ctx, 'owner')
  assert.equal(row.id, id)
  assert.equal(row.name, 'RPC access test')
  assert.equal(row.role, 'owner')
  assert.equal(row.status, 'in_progress')
  for (const key of ['slug', 'sport', 'format', 'category', 'set_format', 'doubles_pairing_mode', 'visibility', 'registration_deadline', 'registration_capacity', 'created_at']) {
    assert.ok(Object.hasOwn(row, key), key)
  }
  // A finished match with an empty side is a BYE, not a played match.
  assert.deepEqual(row.progress, { approved: 4, pending: 1, matches: 3, played: 1, byes: 1, live: 1 })
})

test('the list follows table policies: roles see their own rows, a counter does not count pending entries', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  await seedProgress(ctx)
  const editor = await list(ctx, 'editor')
  assert.equal(editor[0].role, 'editor')
  assert.equal(editor[0].progress.pending, 1)
  const counter = await list(ctx, 'counter')
  assert.equal(counter[0].role, 'counter')
  assert.deepEqual(counter[0].progress, { approved: 4, pending: 0, matches: 3, played: 1, byes: 1, live: 1 })
  assert.deepEqual(await list(ctx, 'outsider'), [])
  assert.deepEqual(await list(ctx, 'platform_admin'), [])
  await assert.rejects(list(ctx, 'anon'), /permission denied/)
})

test('newest tournaments come first; a tournament without data has zero counts', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const older = await seedProgress(ctx)
  await ctx.db.query("update tournaments set created_at=now()-interval '1 day' where id=$1", [older])
  const { id: newer } = await fixture(ctx, { count: 0, status: 'draft' })
  const rows = await list(ctx, 'owner')
  assert.deepEqual(rows.map(r => r.id), [newer, older])
  assert.deepEqual(rows[0].progress, { approved: 0, pending: 0, matches: 0, played: 0, byes: 0, live: 0 })
})

test('the migration can be applied again', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  await seedProgress(ctx)
  await reapplyForwardMigrations(ctx)
  assert.equal((await list(ctx, 'owner')).length, 1)
})
