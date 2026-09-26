import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const row = async id => (await ctx.db.query('select * from tournaments where id=$1', [id])).rows[0]
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), (await row(t.id)).settings_revision])
const open = (options = {}) => fixture(ctx, { status: 'registration_open', isPublic: true, count: 0, ...options })
const manual = (t, args = {}, actor = 'owner') => asActor(ctx, actor,
  'select add_manual_entry($1,$2,$3,$4,$5,$6::registration_status) r',
  [t.id, args.one ?? 'Player', args.two ?? null, args.display ?? null, args.contact ?? null, args.status ?? 'approved']).then(r => r.rows[0].r)
const register = (t, { phone = null, email = null, contact = null, name = 'Player', type = 'singles', partner = null } = {}) =>
  asActor(ctx, 'anon', 'select register_entry($1,$2,$3,$4,$5,null,null,$6,$7) r', [t.id, type, contact, name, partner, phone, email]).then(r => r.rows[0].r)

// C1 ------------------------------------------------------------------------

test('a completed tournament cannot be moved back to another status; other settings still save', async () => {
  const t = await fixture(ctx, { status: 'in_progress' })
  await settings(t, { status: 'completed' })
  for (const status of ['draft', 'registration_open', 'registration_closed', 'in_progress']) {
    const before = await snapshot(ctx)
    await assert.rejects(settings(t, { status }), /lifecycle\.completedLocked/, status)
    assert.deepEqual(await snapshot(ctx), before)
  }
  await settings(t, { name: 'Renamed after the final', status: 'completed' })
  assert.deepEqual([(await row(t.id)).name, (await row(t.id)).status], ['Renamed after the final', 'completed'])
  // Every earlier status can still move forward, and back while not completed.
  const running = await fixture(ctx, { status: 'in_progress' })
  await settings(running, { status: 'registration_closed' })
  await settings(running, { status: 'in_progress' })
  assert.equal((await row(running.id)).status, 'in_progress')
})

// C4 ------------------------------------------------------------------------

test('adding someone already on the team is refused with their role instead of changing it silently', async () => {
  const t = await fixture(ctx)
  const roleOf = async actor => (await ctx.db.query('select role from tournament_admins where tournament_id=$1 and user_id=$2', [t.id, ctx.actors[actor]])).rows[0]?.role
  const before = await snapshot(ctx)
  const refused = await asActor(ctx, 'owner', 'select add_tournament_admin_by_email($1,$2,$3,true)', [t.id, 'Editor@Example.test', 'counter'])
    .then(() => null, error => error)
  assert.match(refused?.message || '', /access\.alreadyMember/)
  assert.equal(refused.detail, 'editor')
  assert.deepEqual(await snapshot(ctx), before)
  assert.equal(await roleOf('editor'), 'editor')
  // The role selector (and an older client) changes a role deliberately, without the flag.
  const changed = (await asActor(ctx, 'owner', 'select add_tournament_admin_by_email($1,$2,$3) r', [t.id, 'editor@example.test', 'counter'])).rows[0].r
  assert.deepEqual([changed.role, changed.previous_role], ['counter', 'editor'])
  // A new person is added with the flag.
  const added = (await asActor(ctx, 'owner', 'select add_tournament_admin_by_email($1,$2,$3,true) r', [t.id, 'outsider@example.test', 'editor'])).rows[0].r
  assert.deepEqual([added.role, added.previous_role], ['editor', null])
})

test('an unknown email gets a neutral code that does not echo the address', async () => {
  const t = await fixture(ctx)
  for (const flag of [false, true]) {
    const error = await asActor(ctx, 'owner', 'select add_tournament_admin_by_email($1,$2,$3,$4)', [t.id, 'nobody@example.test', 'editor', flag])
      .then(() => null, e => e)
    assert.equal(error?.message, 'access.userNotFound')
  }
  await assertDeniedUnchanged(ctx, 'counter', 'select add_tournament_admin_by_email($1,$2,$3,true)', [t.id, 'outsider@example.test', 'editor'])
  await assert.rejects(asActor(ctx, 'anon', 'select add_tournament_admin_by_email($1,$2,$3,true)', [t.id, 'outsider@example.test', 'editor']), /permission denied|Not authorized/)
  const signatures = (await ctx.db.query("select p.oid::regprocedure::text s from pg_proc p where p.proname='add_tournament_admin_by_email'")).rows.map(r => r.s)
  assert.deepEqual(signatures, ['add_tournament_admin_by_email(uuid,text,text,boolean)'])
})

// C5 ------------------------------------------------------------------------

test('owners and editors read applicants’ contacts; a counter, outsiders and the public do not', async () => {
  const t = await open()
  const entry = await register(t, { phone: '+370 600 12345', email: 'Applicant@Example.test', name: 'Applicant' })
  await manual(t, { one: 'No contact' })
  for (const actor of ['owner', 'editor']) {
    const rows = (await asActor(ctx, actor, 'select * from get_entry_contacts($1)', [t.id])).rows
    assert.deepEqual(rows, [{ entry_id: entry.id, contact_phone: '+370 600 12345', contact_email: 'applicant@example.test' }], actor)
  }
  for (const actor of ['counter', 'outsider', 'platform_admin']) {
    assert.deepEqual((await asActor(ctx, actor, 'select * from get_entry_contacts($1)', [t.id])).rows, [], actor)
  }
  await assert.rejects(asActor(ctx, 'anon', 'select * from get_entry_contacts($1)', [t.id]), /permission denied/)
  // The columns themselves stay closed.
  await assert.rejects(asActor(ctx, 'owner', 'select contact_email from entries where tournament_id=$1', [t.id]), /permission denied/)
})

// C6 ------------------------------------------------------------------------

test('an organizer’s entry is checked for duplicates exactly like a public registration', async () => {
  const t = await open()
  await register(t, { phone: '+370 600 12345', email: 'first@example.test', name: 'First' })
  const before = await snapshot(ctx)
  for (const contact of ['FIRST@example.test', ' first@EXAMPLE.test ', '+370-600-12345', '370 600 12345']) {
    await assert.rejects(manual(t, { one: 'Twin', contact }), /Registration already exists for this contact/, contact)
  }
  assert.deepEqual(await snapshot(ctx), before)
  const added = await manual(t, { one: 'Walk-in', contact: 'Walk.In@Example.test', status: 'pending' })
  assert.equal(added.status, 'pending')
  const stored = (await ctx.db.query('select * from entries where id=$1', [added.id])).rows[0]
  assert.deepEqual([stored.phone_or_email, stored.contact_email, stored.contact_phone], ['walk.in@example.test', 'walk.in@example.test', null])
  // The public form now sees the organizer's entry as taken, too.
  await assert.rejects(register(t, { phone: '+37069999999', email: 'walk.in@example.test', name: 'Late' }), /already exists/)
  // Without a contact any number of entries can be added.
  const a = await manual(t, { one: 'Anonymous A' })
  const b = await manual(t, { one: 'Anonymous B' })
  assert.notEqual(a.id, b.id)
  const members = (await ctx.db.query('select member_name from entry_members where entry_id=$1', [a.id])).rows
  assert.deepEqual(members, [{ member_name: 'Anonymous A' }])
  await assert.rejects(manual(t, { one: 'Bad', contact: 'not a contact' }), /Invalid phone number or email/)
})

test('manual entries are limited to organizers, open stages and a known status', async () => {
  const t = await open()
  for (const actor of ['counter', 'outsider', 'platform_admin']) {
    await assertDeniedUnchanged(ctx, actor, "select add_manual_entry($1,'X')", [t.id], /Not allowed/)
  }
  await assert.rejects(asActor(ctx, 'anon', "select add_manual_entry($1,'X')", [t.id]), /permission denied/)
  await assert.rejects(manual(t, { one: 'X', status: 'waitlisted' }), /Invalid entry status/)
  await assert.rejects(manual(t, { one: '  ' }), /Single entry requires one participant/)
  const started = await fixture(ctx, { status: 'in_progress', count: 2 })
  await assert.rejects(manual(started, { one: 'Too late' }), /drafts\.rulesLocked/)
  const doubles = await open({ category: 'doubles', pairing: 'pre_agreed' })
  await assert.rejects(manual(doubles, { one: 'Solo' }), /Double entry requires two participants/)
  const pair = await manual(doubles, { one: 'Ann', two: 'Bea' })
  assert.equal((await ctx.db.query('select display_name from entries where id=$1', [pair.id])).rows[0].display_name, 'Ann / Bea')
})

// C7 ------------------------------------------------------------------------

test('names have a length limit and a pair needs two different players, in both entry paths', async () => {
  const t = await open()
  const long = 'x'.repeat(101)
  await assert.rejects(register(t, { contact: 'long@example.test', name: long }), /registration\.nameTooLong/)
  await assert.rejects(manual(t, { one: long }), /registration\.nameTooLong/)
  await assert.rejects(manual(t, { one: 'Fine', display: 'y'.repeat(161) }), /registration\.nameTooLong/)
  assert.ok((await register(t, { contact: 'hundred@example.test', name: 'z'.repeat(100) })).id)
  const doubles = await open({ category: 'doubles', pairing: 'pre_agreed' })
  const before = await snapshot(ctx)
  await assert.rejects(register(doubles, { type: 'doubles', contact: 'pair@example.test', name: 'Анна Петрова', partner: ' анна   петрова ' }), /registration\.samePlayer/)
  await assert.rejects(manual(doubles, { one: 'Анна Петрова', two: 'АННА ПЕТРОВА' }), /registration\.samePlayer/)
  assert.deepEqual(await snapshot(ctx), before)
  assert.ok((await register(doubles, { type: 'doubles', contact: 'pair@example.test', name: 'Анна Петрова', partner: 'Анна Иванова' })).id)
})

test('organizer contacts, waitlist and fee are validated when they change', async () => {
  const t = await open({ count: 2 })
  const before = await snapshot(ctx)
  await assert.rejects(settings(t, { contact_phone: 'abc' }), /registration\.invalidPhone/)
  await assert.rejects(settings(t, { contact_email: 'not-an-email' }), /registration\.invalidEmail/)
  await assert.rejects(settings(t, { waitlist_enabled: true }), /registration\.waitlistNeedsCapacity/)
  await assert.rejects(settings(t, { entry_fee_mode: 'paid', entry_fee_minor: 0, entry_fee_currency: 'EUR', entry_fee_unit: 'player' }), /registration\.zeroFee/)
  for (const unit of ['pair', 'team']) {
    await assert.rejects(settings(t, { entry_fee_mode: 'paid', entry_fee_minor: 500, entry_fee_currency: 'EUR', entry_fee_unit: unit }), /registration\.feeUnitMismatch/, unit)
  }
  assert.deepEqual(await snapshot(ctx), before)
  await settings(t, { contact_phone: '+370 600 00000', contact_email: 'org@example.test', registration_capacity: 4, waitlist_enabled: true,
    entry_fee_mode: 'paid', entry_fee_minor: 500, entry_fee_currency: 'EUR', entry_fee_unit: 'player' })
  const doubles = await open({ category: 'doubles', pairing: 'pre_agreed' })
  await settings(doubles, { entry_fee_mode: 'paid', entry_fee_minor: 500, entry_fee_currency: 'EUR', entry_fee_unit: 'pair' })
  const football = await open({ sport: 'football' })
  await settings(football, { entry_fee_mode: 'paid', entry_fee_minor: 500, entry_fee_currency: 'EUR', entry_fee_unit: 'team' })
  // Rows saved before these rules keep saving unrelated settings.
  await ctx.db.query("update tournaments set contact_phone='abc', waitlist_enabled=true, registration_capacity=null, entry_fee_mode='paid', entry_fee_minor=0, entry_fee_currency='EUR', entry_fee_unit='pair' where id=$1", [t.id])
  await settings(t, { name: 'Legacy row' })
  assert.equal((await row(t.id)).name, 'Legacy row')
})

test('the forward chain replays cleanly with the lifecycle fixes', async () => {
  const t = await open()
  await manual(t, { one: 'Replay', contact: 'replay@example.test' })
  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
  const helpers = ['entry_name_key(text)', 'validate_entry_names(tournament_category,text,text,text)', 'entry_contact_taken(uuid,text,text,text)', 'request_client_ip()']
  for (const fn of helpers) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await ctx.db.query('select has_function_privilege($1,$2,\'execute\') ok', [role, fn])).rows[0].ok, false, `${role} ${fn}`)
    }
  }
})
