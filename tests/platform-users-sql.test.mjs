import assert from 'node:assert/strict'
import test from 'node:test'
import { asActor, createDatabase, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

const overview = (ctx, actor) =>
  asActor(ctx, actor, 'select platform_users_overview() r').then(res => res.rows[0].r)

test('only a platform admin can read the users overview', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  await assert.rejects(overview(ctx, 'anon'), /permission denied/)
  for (const actor of ['owner', 'editor', 'counter', 'outsider']) {
    await assert.rejects(overview(ctx, actor), /Platform admin required/)
  }
  assert.ok((await overview(ctx, 'platform_admin')).users.length)
})

test('every account with its tournaments, roles, progress and platform totals', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id, entries } = await fixture(ctx, { status: 'in_progress', count: 4 })
  await fixture(ctx, { status: 'completed', count: 2, owner: 'outsider' })
  await ctx.db.query("insert into entries(tournament_id,entry_type,display_name,phone_or_email,status) values ($1,'singles','Late','late@example.test','pending')", [id])
  // One played match, one BYE: only the played one counts.
  await ctx.db.query(`insert into matches(tournament_id,stage,round_number,match_number,side_a_entry_id,side_b_entry_id,winner_entry_id,status)
    values ($1,'main',1,1,$2,$3,$2,'finished'), ($1,'main',1,2,$4,null,$4,'finished')`, [id, entries[0], entries[1], entries[2]])

  await ctx.db.query("update auth.users set raw_user_meta_data = '{\"full_name\":\"Olga Owner\",\"avatar_url\":\"https://example.test/o.png\"}', last_sign_in_at = now() where id = $1", [ctx.actors.owner])
  await ctx.db.query("update auth.users set created_at = now() - interval '60 days', last_sign_in_at = now() - interval '20 days' where id = $1", [ctx.actors.counter])
  await ctx.db.query("insert into players(user_id, display_name) values ($1, 'Edgar Editor')", [ctx.actors.editor])
  // A session refresh is activity too: the counter signed in 20 days ago but was here 3 days ago.
  await ctx.db.query("insert into auth.sessions(user_id, updated_at, refreshed_at) values ($1, now() - interval '3 days', null)", [ctx.actors.counter])
  await ctx.db.query("insert into auth.sessions(user_id, updated_at, refreshed_at) values ($1, now() - interval '40 days', (now() - interval '1 day') at time zone 'UTC')", [ctx.actors.editor])

  const data = await overview(ctx, 'platform_admin')
  const byEmail = Object.fromEntries(data.users.map(u => [u.email, u]))

  const owner = byEmail['owner@example.test']
  assert.equal(owner.name, 'Olga Owner')
  assert.equal(owner.avatar_url, 'https://example.test/o.png')
  assert.equal(owner.tournaments.length, 1)
  assert.deepEqual(
    (({ role, status, approved, pending, matches, played }) => ({ role, status, approved, pending, matches, played }))(owner.tournaments[0]),
    { role: 'owner', status: 'in_progress', approved: 4, pending: 1, matches: 2, played: 1 },
  )
  assert.equal(byEmail['editor@example.test'].name, 'Edgar Editor', 'player profile name wins')
  assert.equal(byEmail['editor@example.test'].tournaments[0].role, 'editor')
  assert.equal(byEmail['outsider@example.test'].tournaments[0].status, 'completed')
  assert.equal(byEmail['platform_admin@example.test'].is_platform_admin, true)
  assert.equal(byEmail['platform_admin@example.test'].tournaments.length, 0)
  assert.equal(owner.is_platform_admin, false)
  assert.equal(data.users.at(-1).email, 'counter@example.test', 'newest accounts first')

  const days = (value) => Math.round((Date.now() - new Date(value).getTime()) / 86400000)
  assert.equal(days(byEmail['counter@example.test'].last_sign_in_at), 20)
  assert.equal(days(byEmail['counter@example.test'].last_seen_at), 3, 'the later of sign-in and session')
  assert.equal(days(byEmail['editor@example.test'].last_seen_at), 1, 'refreshed_at (UTC, no zone) wins over updated_at')
  assert.equal(days(owner.last_seen_at), 0, 'sign-in without a session')
  assert.equal(byEmail['outsider@example.test'].last_seen_at, null)

  assert.deepEqual(data.totals, {
    users: 5, users_7d: 4, users_30d: 4, active_7d: 3, organizers: 4,
    tournaments: 2, tournaments_7d: 2, tournaments_30d: 2, in_progress: 1, completed: 1,
    participants: 6, matches_played: 1,
  })
})

test('the migration replays without changing the answer', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  await fixture(ctx)
  const before = await overview(ctx, 'platform_admin')
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await overview(ctx, 'platform_admin'), before)
})
