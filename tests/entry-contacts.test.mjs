import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const open = (options = {}) => fixture(ctx, { status: 'registration_open', isPublic: true, count: 0, ...options })

// The public form sends both fields; older callers still send one combined contact.
const register = (t, { phone = null, email = null, contact = null, name = 'Player', type = 'singles', partner = null, actor = 'anon' } = {}) =>
  asActor(ctx, actor, "select register_entry($1,$2,$3,$4,$5,null,null,$6,$7) r", [t.id, type, contact, name, partner, phone, email])

const entryOf = async id => (await ctx.db.query('select * from entries where id=$1', [id])).rows[0]

test('a registration with both fields stores the phone and the email separately', async () => {
  const t = await open()
  const result = (await register(t, { phone: '+370 600 12345', email: ' Player@Example.TEST ', name: 'Ann' })).rows[0].r
  assert.equal(result.status, 'pending')

  const entry = await entryOf(result.id)
  assert.equal(entry.contact_phone, '+370 600 12345')
  assert.equal(entry.contact_email, 'player@example.test')
  // The legacy column keeps one value so old readers and its unique index still work.
  assert.equal(entry.phone_or_email, 'player@example.test')
})

test('both fields are required and validated once either one is sent', async () => {
  const t = await open()
  const before = await snapshot(ctx)
  await assert.rejects(register(t, { phone: '+37060012345' }), /registration\.emailRequired/)
  await assert.rejects(register(t, { email: 'only@example.test' }), /registration\.phoneRequired/)
  await assert.rejects(register(t, { phone: 'not-a-phone', email: 'ok@example.test' }), /registration\.invalidPhone/)
  await assert.rejects(register(t, { phone: '+37060012345', email: 'not-an-email' }), /registration\.invalidEmail/)
  assert.deepEqual(await snapshot(ctx), before)
})

test('a repeated phone or email is refused even when the other field differs', async () => {
  const t = await open()
  await register(t, { phone: '+370 600 12345', email: 'first@example.test', name: 'First' })
  const before = await snapshot(ctx)

  await assert.rejects(register(t, { phone: '+370 600 99999', email: 'FIRST@example.test', name: 'Same mail' }), /already exists/)
  // Spacing and punctuation do not make a phone a different one.
  await assert.rejects(register(t, { phone: '+370-600-12345', email: 'second@example.test', name: 'Same phone' }), /already exists/)
  assert.deepEqual(await snapshot(ctx), before)

  const other = await open()
  const accepted = (await register(other, { phone: '+370 600 12345', email: 'first@example.test', name: 'Other event' })).rows[0].r
  assert.equal(accepted.status, 'pending')
})

test('a rejected application frees its phone and email for a new one', async () => {
  const t = await open()
  const first = (await register(t, { phone: '+37061111111', email: 'again@example.test', name: 'Again' })).rows[0].r
  await asActor(ctx, 'owner', "update entries set status='rejected' where id=$1", [first.id])
  const second = (await register(t, { phone: '+37061111111', email: 'again@example.test', name: 'Again' })).rows[0].r
  assert.notEqual(second.id, first.id)
})

test('a caller that still sends one combined contact keeps working and fills the matching column', async () => {
  const t = await open()
  const mail = (await register(t, { contact: 'legacy@example.test', name: 'Legacy mail' })).rows[0].r
  const phone = (await register(t, { contact: '+370 600 55555', name: 'Legacy phone' })).rows[0].r

  const mailEntry = await entryOf(mail.id)
  assert.deepEqual([mailEntry.contact_email, mailEntry.contact_phone], ['legacy@example.test', null])
  const phoneEntry = await entryOf(phone.id)
  assert.deepEqual([phoneEntry.contact_email, phoneEntry.contact_phone], [null, '+370 600 55555'])

  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles','nonsense','X')", [t.id], /Invalid phone number or email/)
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles',null,'X')", [t.id], /Contact info is required/)
})

test('entries written directly get the same columns, and the forward chain replays cleanly', async () => {
  const t = await open()
  await asActor(ctx, 'owner', `insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
    values ($1,'singles','Manual','Manual@Example.test','approved')`, [t.id])
  await asActor(ctx, 'owner', `insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
    values ($1,'singles','By phone','+370 600 77777','approved')`, [t.id])
  // The admin form's placeholder contact is not a real address and stays out of the columns.
  await asActor(ctx, 'owner', `insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
    values ($1,'singles','No contact','admin-entry-0000@local.tenis','approved')`, [t.id])

  const rows = (await ctx.db.query('select display_name,contact_phone,contact_email from entries where tournament_id=$1 order by display_name', [t.id])).rows
  assert.deepEqual(rows, [
    { display_name: 'By phone', contact_phone: '+370 600 77777', contact_email: null },
    { display_name: 'Manual', contact_phone: null, contact_email: 'manual@example.test' },
    { display_name: 'No contact', contact_phone: null, contact_email: null },
  ])

  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
})
