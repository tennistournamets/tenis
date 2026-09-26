import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const row = async id => (await ctx.db.query('select * from tournaments where id=$1', [id])).rows[0]
const revision = async id => (await row(id)).settings_revision
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])
const state = async (t, actor = 'anon') => (await asActor(ctx, actor, 'select tournament_registration_state($1) s', [t.id])).rows[0].s
const sync = async (t, actor = 'anon') => (await asActor(ctx, actor, 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
const register = (t, contact, name = 'Player', actor = 'anon', type = 'singles', partner = null) =>
  asActor(ctx, actor, "select (register_entry($1,$2,$3,$4,$5)->>'id')::uuid id", [t.id, type, contact, name, partner])
const statusMap = async t => Object.fromEntries((await ctx.db.query('select id,status from entries where tournament_id=$1', [t.id])).rows.map(r => [r.id, r.status]))
// Inserts within one millisecond share created_at; fix the submission order explicitly where it matters.
const orderEntries = async ids => { for (const [i, id] of ids.entries()) await ctx.db.query("update entries set created_at=now()-interval '1 hour'+make_interval(secs=>$2) where id=$1", [id, i]) }
const open = (options = {}) => fixture(ctx, { status: 'registration_open', isPublic: true, ...options })

test('tournaments without limits keep the previous behaviour and report an open registration', async () => {
  const t = await open({ count: 2 })
  const { rows } = await register(t, 'free@example.test')
  assert.equal((await ctx.db.query('select status from entries where id=$1', [rows[0].id])).rows[0].status, 'pending')
  await asActor(ctx, 'owner', "update entries set status='approved' where id=$1", [rows[0].id])
  const s = await state(t)
  assert.equal(s.accepting, true)
  assert.equal(s.closed_reason, null)
  assert.equal(s.capacity, null)
  assert.equal(s.occupied, 3)
  assert.equal(s.is_full, false)
  assert.equal(s.deadline_passed, false)
  assert.equal(s.fee, null)
  assert.equal((await sync(t)).registration.accepting, true)
})

test('approved entries fill the capacity; public registration closes with the "full" reason', async () => {
  const t = await open({ count: 2 })
  await settings(t, { registration_capacity: 2 })
  const before = await snapshot(ctx)
  await assert.rejects(register(t, 'late@example.test'), /registration\.full/)
  assert.deepEqual(await snapshot(ctx), before)
  const s = await state(t)
  assert.deepEqual([s.accepting, s.closed_reason, s.is_full, s.capacity, s.occupied, s.free], [false, 'full', true, 2, 2, 0])
  assert.equal(s.capacity_unit, 'entries')
})

test('pending entries do not take seats, and approval beyond the limit is rejected on every write path', async () => {
  const t = await open({ count: 2 })
  await settings(t, { registration_capacity: 3 })
  const first = (await register(t, 'first@example.test', 'First')).rows[0].id
  const second = (await register(t, 'second@example.test', 'Second')).rows[0].id
  assert.equal((await state(t)).occupied, 2)
  await asActor(ctx, 'owner', "update entries set status='approved' where id=$1", [first])
  assert.equal((await state(t)).is_full, true)
  await assertDeniedUnchanged(ctx, 'owner', "update entries set status='approved' where id=$1", [second], /registration\.full/)
  await assertDeniedUnchanged(ctx, 'editor', "update entries set status='approved' where tournament_id=$1 and status='pending'", [t.id], /registration\.full/)
  await assertDeniedUnchanged(ctx, 'owner', `insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
    values ($1,'singles','Manual','manual@example.test','approved')`, [t.id], /registration\.full/)
  // Re-approving an already approved entry or rejecting never touches the limit.
  await asActor(ctx, 'owner', "update entries set status='approved' where id=$1", [first])
  await asActor(ctx, 'owner', "update entries set status='rejected' where id=$1", [second])
  assert.deepEqual(await statusMap(t), { [t.entries[0]]: 'approved', [t.entries[1]]: 'approved', [first]: 'approved', [second]: 'rejected' })
})

test('approve all keeps submission order and reports entries that did not fit', async () => {
  const t = await open({ count: 1 })
  await settings(t, { registration_capacity: 3 })
  const bulk = []
  for (const n of [1, 2, 3]) bulk.push((await register(t, `bulk${n}@example.test`, `Bulk ${n}`)).rows[0].id)
  await orderEntries([...t.entries, ...bulk])
  await assertDeniedUnchanged(ctx, 'counter', 'select approve_pending_entries($1)', [t.id])
  const { rows } = await asActor(ctx, 'editor', 'select approve_pending_entries($1) r', [t.id])
  assert.deepEqual(rows[0].r, { approved: 2, skipped: 1 })
  assert.deepEqual(await statusMap(t), { [t.entries[0]]: 'approved', [bulk[0]]: 'approved', [bulk[1]]: 'approved', [bulk[2]]: 'pending' })
  const unlimited = await open({ count: 0 })
  for (const n of [1, 2]) await register(unlimited, `all${n}@example.test`, `All ${n}`)
  assert.deepEqual((await asActor(ctx, 'owner', 'select approve_pending_entries($1) r', [unlimited.id])).rows[0].r, { approved: 2, skipped: 0 })
})

test('a passed deadline closes public intake but leaves approvals and settings to the organizer', async () => {
  const t = await open({ count: 1 })
  const pending = (await register(t, 'early@example.test', 'Early')).rows[0].id
  await settings(t, { registration_deadline: new Date(Date.now() + 3600_000).toISOString() })
  assert.equal((await state(t)).accepting, true)
  await settings(t, { registration_deadline: new Date(Date.now() - 60_000).toISOString() })
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles','late@example.test','Late')", [t.id], /registration\.deadlinePassed/)
  const s = await state(t)
  assert.deepEqual([s.accepting, s.closed_reason, s.deadline_passed, s.status], [false, 'deadline', true, 'registration_open'])
  await asActor(ctx, 'owner', "update entries set status='approved' where id=$1", [pending])
  assert.equal((await state(t)).occupied, 2)
  await settings(t, { registration_deadline: null })
  assert.equal((await state(t)).accepting, true)
})

test('closed status wins over deadline and capacity in the reported reason', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', isPublic: true, count: 2 })
  await settings(t, { registration_capacity: 2, registration_deadline: new Date(Date.now() - 60_000).toISOString() })
  const s = await state(t)
  assert.deepEqual([s.accepting, s.closed_reason, s.is_full, s.deadline_passed], [false, 'status', true, true])
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles','x@example.test','X')", [t.id], /Registration is closed/)
})

test('settings validate capacity and fee; lowering the limit below the occupied seats is rejected', async () => {
  const t = await open({ count: 3 })
  for (const patch of [{ registration_capacity: 0 }, { registration_capacity: -2 }, { capacity_public: null },
    { entry_fee_mode: 'paid' }, { entry_fee_mode: 'paid', entry_fee_minor: 500, entry_fee_currency: 'EU', entry_fee_unit: 'player' },
    { entry_fee_mode: 'paid', entry_fee_minor: -1, entry_fee_currency: 'EUR', entry_fee_unit: 'player' },
    { entry_fee_mode: 'paid', entry_fee_minor: 500, entry_fee_currency: 'EUR', entry_fee_unit: 'club' },
    { entry_fee_mode: 'donation' }]) {
    const before = await snapshot(ctx)
    await assert.rejects(settings(t, patch), /registration\.invalidCapacity|registration\.invalidFee|Invalid settings/)
    assert.deepEqual(await snapshot(ctx), before)
  }
  await assert.rejects(settings(t, { registration_capacity: 2 }), /registration\.capacityBelowOccupied/)
  await settings(t, { registration_capacity: 3 })
  assert.equal((await state(t)).is_full, true)
  await settings(t, { entry_fee_mode: 'paid', entry_fee_minor: 2000, entry_fee_currency: 'eur', entry_fee_unit: 'player' })
  assert.deepEqual((await state(t)).fee, { mode: 'paid', amount_minor: 2000, currency: 'EUR', unit: 'player' })
  await settings(t, { entry_fee_mode: 'free' })
  assert.deepEqual((await state(t)).fee, { mode: 'free', amount_minor: null, currency: null, unit: null })
  assert.equal((await row(t.id)).entry_fee_currency, null)
  // Editing unrelated settings never re-validates an existing limit against the count.
  await ctx.db.query('update tournaments set registration_capacity=1 where id=$1', [t.id])
  await settings(t, { name: 'Renamed' })
  assert.equal((await row(t.id)).name, 'Renamed')
})

test('random-pairing doubles count people: pairs need two seats, pairing itself stays possible when full', async () => {
  const t = await open({ count: 2, category: 'doubles', pairing: 'pick_random' })
  await settings(t, { registration_capacity: 3 })
  assert.deepEqual([(await state(t)).capacity_unit, (await state(t)).occupied], ['players', 2])
  const pair = (await register(t, 'pair@example.test', 'Ann', 'anon', 'doubles', 'Bob')).rows[0].id
  const single = (await register(t, 'single@example.test', 'Cid', 'anon', 'doubles', null)).rows[0].id
  await assertDeniedUnchanged(ctx, 'owner', "update entries set status='approved' where id=$1", [pair], /registration\.full/)
  await asActor(ctx, 'owner', "update entries set status='approved' where id=$1", [single])
  assert.deepEqual([(await state(t)).occupied, (await state(t)).is_full], [3, true])
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'doubles','more@example.test','Dan')", [t.id], /registration\.full/)
  // A manually inserted approved entry is checked when its people are written.
  const manual = (await asActor(ctx, 'owner', `insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
    values ($1,'doubles','Eve','eve@example.test','approved') returning id`, [t.id])).rows[0].id
  await assertDeniedUnchanged(ctx, 'owner', "insert into entry_members(entry_id,member_name,member_order) values ($1,'Eve',1)", [manual], /registration\.full/)
  await ctx.db.query('delete from entries where id=$1', [manual])
  // Exactly full with two single people: forming a pair moves members without exceeding the limit.
  await asActor(ctx, 'owner', "update entries set status='rejected' where id=$1", [single])
  await settings(t, { registration_capacity: 2 })
  assert.equal((await state(t)).is_full, true)
  assert.equal((await asActor(ctx, 'owner', 'select form_random_pairs($1) n', [t.id])).rows[0].n, 1)
  assert.deepEqual([(await state(t)).occupied, (await state(t)).is_full], [2, true])
  assert.equal((await ctx.db.query("select count(*)::int n from entries where tournament_id=$1 and status='approved'", [t.id])).rows[0].n, 1)
})

test('the display flag travels with the numbers; hidden tournaments report no state to strangers', async () => {
  const t = await open({ count: 1 })
  await settings(t, { registration_capacity: 1, capacity_public: false })
  const pub = await state(t)
  assert.deepEqual([pub.capacity, pub.occupied, pub.free, pub.capacity_public, pub.is_full, pub.closed_reason], [1, 1, 0, false, true, 'full'])
  const hidden = await fixture(ctx, { status: 'registration_open', isPublic: false, count: 1 })
  assert.equal(await state(hidden), null)
  assert.equal((await state(hidden, 'counter'))?.status, 'registration_open')
  assert.equal((await sync(t)).tournament.registration_capacity, 1)
  assert.equal((await sync(t)).registration.capacity_public, false)
  await assert.rejects(asActor(ctx, 'anon', 'select contact_phone from tournaments where id=$1', [t.id]), /permission denied/)
})

test('the forward migration chain replays without changing data and keeps the trigger definitions', async () => {
  const t = await open({ count: 2 })
  await settings(t, { registration_capacity: 4, entry_fee_mode: 'paid', entry_fee_minor: 1500, entry_fee_currency: 'EUR', entry_fee_unit: 'player' })
  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
  const triggers = (await ctx.db.query(`select tgname from pg_trigger where tgname in ('trg_entries_capacity','trg_entry_members_capacity') order by tgname`)).rows.map(r => r.tgname)
  assert.deepEqual(triggers, ['trg_entries_capacity', 'trg_entry_members_capacity'])
  assert.deepEqual((await state(t)).fee, { mode: 'paid', amount_minor: 1500, currency: 'EUR', unit: 'player' })
})
