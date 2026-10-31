import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const edit = (actor, id, members, { replace = null, display = null, phone = null, email = null } = {}) =>
  asActor(ctx, actor, 'select update_entry($1,$2,$3,$4,$5,$6) r', [id, members, replace, display, phone, email])
const entry = async id => (await ctx.db.query('select * from entries where id=$1', [id])).rows[0]
const members = async id => (await ctx.db.query('select * from entry_members where entry_id=$1 order by member_order', [id])).rows

async function pair(t) {
  const [a, b] = t.entries
  await ctx.db.query("update entries set entry_type='doubles', display_name='Ann / Bea' where id=$1", [a])
  await ctx.db.query("update entry_members set member_name='Ann' where entry_id=$1", [a])
  await ctx.db.query("update entry_members set entry_id=$1, member_order=2, member_name='Bea' where entry_id=$2", [a, b])
  await ctx.db.query('delete from entries where id=$1', [b])
  return a
}

test('owner and editor fix names in any tournament state; the bracket name follows', async () => {
  const t = await fixture(ctx, { status: 'in_progress' })
  const id = t.entries[0]
  const r = (await edit('owner', id, ['  Jonas   Petraitis '])).rows[0].r
  assert.equal(r.display_name, 'Jonas Petraitis')
  assert.equal((await members(id))[0].member_name, 'Jonas Petraitis')
  assert.equal((await entry(id)).display_name, 'Jonas Petraitis')

  await ctx.db.query("update tournaments set status='completed' where id=$1", [t.id])
  await edit('editor', id, ['Jonas Petraitis'], { display: 'JP' })
  assert.equal((await entry(id)).display_name, 'JP')
})

test('counter, outsider and anon cannot edit', async () => {
  const t = await fixture(ctx)
  const sql = 'select update_entry($1,$2)'
  for (const actor of ['counter', 'outsider']) await assertDeniedUnchanged(ctx, actor, sql, [t.entries[0], ['X']])
  await assertDeniedUnchanged(ctx, 'anon', sql, [t.entries[0], ['X']])
})

test('names are checked: same count, not empty, not the same player twice', async () => {
  const t = await fixture(ctx, { category: 'doubles', pairing: 'pick_random', status: 'registration_closed', count: 2 })
  const id = await pair(t)
  await assert.rejects(edit('owner', id, ['Ann']), /entryEdit\.memberCount/)
  await assert.rejects(edit('owner', id, ['Ann', '  ']), /entryEdit\.nameRequired/)
  await assert.rejects(edit('owner', id, ['Ann', 'ann']), /registration\.samePlayer/)
  await assert.rejects(edit('owner', id, ['Ann', 'B'.repeat(101)]), /registration\.nameTooLong/)
  await edit('owner', id, ['Ann', 'Rūta'])
  assert.deepEqual((await members(id)).map(m => m.member_name), ['Ann', 'Rūta'])
  assert.equal((await entry(id)).display_name, 'Ann / Rūta')
})

test('a replaced partner loses the previous player\'s ratings and profile; a renamed one keeps them', async () => {
  const t = await fixture(ctx, { category: 'doubles', pairing: 'pick_random', status: 'registration_closed', count: 2 })
  const id = await pair(t)
  const [one, two] = await members(id)
  await asActor(ctx, 'owner', 'select set_member_rating($1,$2,$3)', [one.id, 'tnl', 4.5])
  await asActor(ctx, 'owner', 'select set_member_rating($1,$2,$3)', [two.id, 'tnl', 5])
  await edit('owner', id, ['Anna', 'Greta'], { replace: [false, true] })
  const ratings = (await ctx.db.query('select member_id from entry_member_ratings where member_id = any($1)', [[one.id, two.id]])).rows
  assert.deepEqual(ratings.map(r => r.member_id), [one.id])
  assert.deepEqual((await members(id)).map(m => m.id), [one.id, two.id])
})

test('contacts: set, changed, cleared; duplicates and bad values refused', async () => {
  const t = await fixture(ctx, { status: 'registration_open' })
  const [id, other] = t.entries
  await edit('owner', id, ['Player 0'], { email: ' Jonas@Mail.LT ', phone: '+370 600 00000' })
  let e = await entry(id)
  assert.equal(e.contact_email, 'jonas@mail.lt')
  assert.equal(e.contact_phone, '+370 600 00000')
  assert.equal(e.phone_or_email, 'jonas@mail.lt')

  const contacts = (await asActor(ctx, 'owner', 'select * from get_entry_contacts($1)', [t.id])).rows
  assert.ok(contacts.some(c => c.entry_id === id && c.contact_email === 'jonas@mail.lt'))

  await assert.rejects(edit('owner', other, ['Player 1'], { email: 'JONAS@mail.lt' }), /Registration already exists for this contact/)
  await assert.rejects(edit('owner', other, ['Player 1'], { phone: '+37060000000' }), /Registration already exists for this contact/)
  await assert.rejects(edit('owner', other, ['Player 1'], { email: 'nope' }), /entryEdit\.invalidEmail/)
  await assert.rejects(edit('owner', other, ['Player 1'], { phone: '12' }), /entryEdit\.invalidPhone/)

  // Unchanged contact is not re-checked or rewritten.
  await edit('owner', id, ['Player Zero'], { email: 'jonas@mail.lt', phone: '+370 600 00000' })
  assert.equal((await entry(id)).phone_or_email, 'jonas@mail.lt')

  await edit('owner', id, ['Player Zero'])
  e = await entry(id)
  assert.equal(e.contact_email, null)
  assert.equal(e.contact_phone, null)
  assert.match(e.phone_or_email, /^admin-entry-.*@local\.tenis$/)
  const placeholder = e.phone_or_email
  await edit('owner', id, ['Player Zero'], { phone: '+37061111111' })
  await edit('owner', id, ['Player Zero'])
  assert.match((await entry(id)).phone_or_email, /^admin-entry-.*@local\.tenis$/)
  assert.notEqual(placeholder, null)
})

test('the entry row is touched so Realtime signals the change; unknown entry is reported', async () => {
  const t = await fixture(ctx)
  const id = t.entries[0]
  await ctx.db.exec('alter table entries disable trigger trg_entries_updated_at')
  await ctx.db.query("update entries set updated_at = now() - interval '1 day' where id=$1", [id])
  await ctx.db.exec('alter table entries enable trigger trg_entries_updated_at')
  const before = (await entry(id)).updated_at
  await edit('owner', id, ['Player 0'])
  assert.ok((await entry(id)).updated_at > before)
  await assert.rejects(edit('owner', '00000000-0000-0000-0000-000000000000', ['X']), /entryEdit\.notFound/)
  await reapplyForwardMigrations(ctx)
})
