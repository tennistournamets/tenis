import assert from 'node:assert/strict'
import test from 'node:test'
import { asActor, createDatabase, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

const request = (ctx, actor, id, message = null) =>
  asActor(ctx, actor, 'select * from request_sponsorship($1,$2)', [id, message])
const decide = (ctx, actor, requestId, status) =>
  asActor(ctx, actor, 'select * from decide_sponsorship_request($1,$2)', [requestId, status])
const approved = async (ctx, actor, id) =>
  (await asActor(ctx, actor, 'select is_sponsorship_approved($1) ok', [id])).rows[0].ok

test('only the tournament owner asks for sponsorship; the request is pending until a platform admin decides', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await fixture(ctx)

  for (const actor of ['anon', 'editor', 'counter', 'outsider', 'platform_admin']) {
    await assert.rejects(request(ctx, actor, id), /Not allowed|Authentication required|permission denied/, actor)
  }
  const row = (await request(ctx, 'owner', id, '  Local car dealer, 3 banners  ')).rows[0]
  assert.equal(row.status, 'pending')
  assert.equal(row.message, 'Local car dealer, 3 banners')
  assert.equal(row.requested_by, ctx.actors.owner)
  assert.equal(await approved(ctx, 'anon', id), false)

  // Asking twice keeps one row per tournament.
  await request(ctx, 'owner', id, 'Updated note')
  const rows = (await ctx.db.query('select * from sponsorship_requests where tournament_id=$1', [id])).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message, 'Updated note')

  await assert.rejects(request(ctx, 'owner', id, 'x'.repeat(501)), /Message is too long/)
})

test('organizers read their own request, outsiders and anon read nothing, direct writes are closed', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await fixture(ctx)
  await request(ctx, 'owner', id)

  for (const actor of ['owner', 'editor', 'platform_admin']) {
    assert.equal((await asActor(ctx, actor, 'select status from sponsorship_requests where tournament_id=$1', [id])).rows.length, 1, actor)
  }
  for (const actor of ['counter', 'outsider']) {
    assert.equal((await asActor(ctx, actor, 'select status from sponsorship_requests where tournament_id=$1', [id])).rows.length, 0, actor)
  }
  await assert.rejects(asActor(ctx, 'anon', 'select * from sponsorship_requests'), /permission denied/)
  for (const actor of ['owner', 'platform_admin']) {
    await assert.rejects(asActor(ctx, actor, "update sponsorship_requests set status='approved' where tournament_id=$1", [id]), /permission denied/, actor)
    await assert.rejects(asActor(ctx, actor, 'insert into sponsorship_requests(tournament_id) values ($1)', [id]), /permission denied/, actor)
    await assert.rejects(asActor(ctx, actor, 'delete from sponsorship_requests where tournament_id=$1', [id]), /permission denied/, actor)
  }
  assert.equal((await ctx.db.query('select status from sponsorship_requests where tournament_id=$1', [id])).rows[0].status, 'pending')
})

test('the platform admin lists requests with owner and tournament, approves and rejects; nobody else can', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await fixture(ctx)
  await ctx.db.query("insert into players(user_id,display_name) values ($1,'Olga Owner')", [ctx.actors.owner])
  const req = (await request(ctx, 'owner', id, 'Please')).rows[0]

  for (const actor of ['anon', 'owner', 'editor', 'outsider']) {
    await assert.rejects(asActor(ctx, actor, 'select * from list_sponsorship_requests()'), /Platform admin required|permission denied/, actor)
    await assert.rejects(decide(ctx, actor, req.id, 'approved'), /Platform admin required|permission denied/, actor)
  }

  const list = (await asActor(ctx, 'platform_admin', 'select * from list_sponsorship_requests()')).rows
  assert.equal(list.length, 1)
  assert.equal(list[0].tournament_id, id)
  assert.equal(list[0].tournament_name, 'RPC access test')
  assert.equal(list[0].owner_name, 'Olga Owner')
  assert.equal(list[0].owner_email, 'owner@example.test')
  assert.equal(list[0].status, 'pending')
  assert.equal(list[0].message, 'Please')

  const ok = (await decide(ctx, 'platform_admin', req.id, 'approved')).rows[0]
  assert.equal(ok.status, 'approved')
  assert.equal(ok.decided_by, ctx.actors.platform_admin)
  assert.ok(ok.decided_at)
  assert.equal(await approved(ctx, 'anon', id), true)
  assert.equal(await approved(ctx, 'outsider', id), true)

  // An approved tournament stays approved when the owner presses the button again.
  assert.equal((await request(ctx, 'owner', id, 'again')).rows[0].status, 'approved')

  await assert.rejects(decide(ctx, 'platform_admin', req.id, 'maybe'), /Invalid sponsorship status/)
  await assert.rejects(decide(ctx, 'platform_admin', '00000000-0000-0000-0000-000000000000', 'approved'), /Sponsorship request not found/)

  const no = (await decide(ctx, 'platform_admin', req.id, 'rejected')).rows[0]
  assert.equal(no.status, 'rejected')
  assert.equal(await approved(ctx, 'anon', id), false)

  // After a rejection the owner may ask again: the same row goes back to pending.
  const again = (await request(ctx, 'owner', id, 'Second try')).rows[0]
  assert.equal(again.id, req.id)
  assert.equal(again.status, 'pending')
  assert.equal(again.decided_by, null)
  assert.equal(again.decided_at, null)

  const back = (await decide(ctx, 'platform_admin', req.id, 'pending')).rows[0]
  assert.equal(back.decided_at, null)
})

test('a deleted tournament takes its request along; the migration replays without losing decisions', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const kept = await fixture(ctx)
  const gone = await fixture(ctx)
  const req = (await request(ctx, 'owner', kept.id)).rows[0]
  await request(ctx, 'owner', gone.id)
  await decide(ctx, 'platform_admin', req.id, 'approved')

  await ctx.db.query('delete from tournaments where id=$1', [gone.id])
  assert.equal((await ctx.db.query('select count(*)::int n from sponsorship_requests')).rows[0].n, 1)

  await reapplyForwardMigrations(ctx)
  assert.equal(await approved(ctx, 'anon', kept.id), true)
  await assert.rejects(asActor(ctx, 'outsider', "update sponsorship_requests set status='rejected'"), /permission denied/)
})

test('without a players row the owner name comes from the sign-in profile, then the email', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const first = await fixture(ctx)
  await ctx.db.query(`update auth.users set raw_user_meta_data='{"full_name":"Dmitrij P."}' where id=$1`, [ctx.actors.owner])
  await request(ctx, 'owner', first.id)
  const second = await fixture(ctx, { owner: 'editor' })
  await request(ctx, 'editor', second.id)

  const rows = (await asActor(ctx, 'platform_admin', 'select tournament_id, owner_name, owner_email from list_sponsorship_requests()')).rows
  const byId = Object.fromEntries(rows.map(r => [r.tournament_id, r]))
  assert.equal(byId[first.id].owner_name, 'Dmitrij P.')
  assert.equal(byId[second.id].owner_name, null)
  assert.equal(byId[second.id].owner_email, 'editor@example.test')
})
