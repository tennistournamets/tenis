import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])
const state = async (t, actor = 'anon') => (await asActor(ctx, actor, 'select tournament_registration_state($1) s', [t.id])).rows[0].s
const register = async (t, contact, name = 'Player', actor = 'anon') =>
  (await asActor(ctx, actor, "select register_entry($1,'singles',$2,$3) r", [t.id, contact, name])).rows[0].r
const visible = async (t, actor) => (await asActor(ctx, actor, 'select id,status from entries where tournament_id=$1 order by created_at,id', [t.id])).rows
const statusMap = async t => Object.fromEntries((await ctx.db.query('select id,status from entries where tournament_id=$1', [t.id])).rows.map(r => [r.id, r.status]))
// Inserts within one millisecond share created_at; fix the submission order explicitly where it matters.
const orderEntries = async ids => { for (const [i, id] of ids.entries()) await ctx.db.query("update entries set created_at=now()-interval '1 hour'+make_interval(secs=>$2) where id=$1", [id, i]) }
const fullWithWaitlist = async (count = 2) => {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, count })
  await settings(t, { registration_capacity: count, waitlist_enabled: true })
  return t
}

test('a full tournament with the waitlist enabled queues new applications instead of rejecting them', async () => {
  const t = await fullWithWaitlist()
  const queued = await register(t, 'queued@example.test', 'Queued')
  assert.equal(queued.status, 'waitlisted')
  const s = await state(t)
  assert.deepEqual([s.accepting, s.closed_reason, s.waitlist_enabled, s.waitlist_open, s.waitlist_count, s.occupied], [false, 'full', true, true, 1, 2])
  assert.deepEqual((await visible(t, 'anon')).map(r => r.status).sort(), ['approved', 'approved'])
  assert.deepEqual((await visible(t, 'counter')).map(r => r.status).sort(), ['approved', 'approved'])
  assert.deepEqual((await visible(t, 'owner')).map(r => r.status).sort(), ['approved', 'approved', 'waitlisted'])
  const publicSync = (await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.equal(publicSync.entries.length, 2)
  assert.equal(publicSync.registration.waitlist_count, 1)
  assert.equal(publicSync.tournament.waitlist_enabled, true)
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles','queued@example.test','Again')", [t.id], /already exists/)
})

test('without the waitlist a full tournament still rejects, and a passed deadline closes the waitlist too', async () => {
  const closed = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 1 })
  await settings(closed, { registration_capacity: 1 })
  assert.equal((await state(closed)).waitlist_open, false)
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles','no@example.test','No')", [closed.id], /registration\.full/)
  const late = await fullWithWaitlist(1)
  await settings(late, { registration_deadline: new Date(Date.now() - 60_000).toISOString() })
  assert.deepEqual([(await state(late)).closed_reason, (await state(late)).waitlist_open], ['deadline', false])
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles','late@example.test','Late')", [late.id], /registration\.deadlinePassed/)
  const open = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 0 })
  await settings(open, { registration_capacity: 4, waitlist_enabled: true })
  assert.equal((await register(open, 'seat@example.test', 'Seat')).status, 'pending')
})

test('promotion from the waitlist obeys the capacity: a freed seat can be given to the first in line', async () => {
  const t = await fullWithWaitlist()
  const first = (await register(t, 'first@example.test', 'First')).id
  const second = (await register(t, 'second@example.test', 'Second')).id
  await assertDeniedUnchanged(ctx, 'owner', "update entries set status='approved' where id=$1", [first], /registration\.full/)
  await asActor(ctx, 'owner', "update entries set status='rejected' where id=$1", [t.entries[0]])
  assert.deepEqual([(await state(t)).is_full, (await state(t)).free, (await state(t)).waitlist_count], [false, 1, 2])
  await asActor(ctx, 'editor', "update entries set status='approved' where id=$1", [first])
  await assertDeniedUnchanged(ctx, 'owner', "update entries set status='approved' where id=$1", [second], /registration\.full/)
  await asActor(ctx, 'owner', "update entries set status='pending' where id=$1", [second])
  assert.deepEqual(await statusMap(t), { [t.entries[0]]: 'rejected', [t.entries[1]]: 'approved', [first]: 'approved', [second]: 'pending' })
  assert.equal((await state(t)).waitlist_count, 0)
})

test('approve all leaves the waitlist untouched; only pending applications are considered', async () => {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 0 })
  await settings(t, { registration_capacity: 3, waitlist_enabled: true })
  const p = []
  for (const n of [1, 2, 3]) { const r = await register(t, `p${n}@example.test`, `P${n}`); assert.equal(r.status, 'pending'); p.push(r.id) }
  await asActor(ctx, 'owner', "update entries set status='approved' where tournament_id=$1 and status='pending'", [t.id])
  const w1 = (await register(t, 'w1@example.test', 'W1'))
  assert.equal(w1.status, 'waitlisted')
  await asActor(ctx, 'owner', "update entries set status='rejected' where id=$1", [p[0]])
  const p4 = await register(t, 'p4@example.test', 'P4')
  assert.equal(p4.status, 'pending')
  assert.deepEqual((await asActor(ctx, 'owner', 'select approve_pending_entries($1) r', [t.id])).rows[0].r, { approved: 1, skipped: 0 })
  assert.deepEqual(await statusMap(t), { [p[0]]: 'rejected', [p[1]]: 'approved', [p[2]]: 'approved', [w1.id]: 'waitlisted', [p4.id]: 'approved' })
})

test('the waitlist flag is a validated setting and the forward chain replays cleanly', async () => {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 1 })
  const before = await snapshot(ctx)
  await assert.rejects(settings(t, { waitlist_enabled: null }), /Invalid settings/)
  assert.deepEqual(await snapshot(ctx), before)
  await settings(t, { waitlist_enabled: true })
  assert.equal((await state(t)).waitlist_enabled, true)
  const labels = (await ctx.db.query("select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='registration_status' order by enumsortorder")).rows.map(r => r.enumlabel)
  assert.deepEqual(labels, ['pending', 'approved', 'rejected', 'waitlisted'])
  const snap = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), snap)
  assert.equal((await register(t, 'after@example.test', 'After')).status, 'pending')
})
