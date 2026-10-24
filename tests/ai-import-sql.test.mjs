import assert from 'node:assert/strict'
import test from 'node:test'
import { asActor, createDatabase, fixture } from './helpers/database.mjs'

const add = (ctx, actor, id, rows, { status = 'approved', notify = false } = {}) =>
  asActor(ctx, actor, 'select add_manual_entries($1,$2,$3,$4) r', [id, JSON.stringify(rows), status, notify]).then(res => res.rows[0].r)

const outbox = async (ctx, id) => (await ctx.db.query('select kind from notification_outbox where tournament_id=$1 order by kind', [id])).rows.map(r => r.kind)

test('a list is added row by row; bad rows are reported and the rest stay', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await fixture(ctx, { count: 0, status: 'registration_open' })

  const results = await add(ctx, 'editor', id, [
    { member_one: 'Ona Kazlauskienė', contact: 'ona@example.test' },
    { member_one: '' },
    { member_one: 'Jonas', contact: 'not a contact' },
    'Rūta',
    { member_one: 'Žygimantas Šeškus', contact: '+370 600 00000' },
    { member_one: 'Ona again', contact: 'ONA@example.test' },
  ])
  assert.deepEqual(results.map(r => r.ok), [true, false, false, false, true, false])
  assert.deepEqual(results.map(r => r.index), [0, 1, 2, 3, 4, 5])
  assert.equal(results[1].error, 'Single entry requires one participant')
  assert.equal(results[2].error, 'Invalid phone number or email')
  assert.equal(results[3].error, 'serverErrors.importBadRow')
  assert.equal(results[5].error, 'Registration already exists for this contact')

  const entries = (await ctx.db.query("select display_name, status from entries where tournament_id=$1 order by display_name", [id])).rows
  assert.deepEqual(entries, [{ display_name: 'Ona Kazlauskienė', status: 'approved' }, { display_name: 'Žygimantas Šeškus', status: 'approved' }])
})

test('emails go out only when the organizer asks for them', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const quiet = (await fixture(ctx, { count: 0, status: 'registration_open' })).id
  await add(ctx, 'owner', quiet, [{ member_one: 'Ona', contact: 'ona@example.test' }])
  assert.deepEqual(await outbox(ctx, quiet), [], 'no email by default')

  // The quiet switch ends with the call: a later single manual entry emails as usual.
  await asActor(ctx, 'owner', "select add_manual_entry($1,'Rūta',null,null,'ruta@example.test','approved')", [quiet])
  assert.deepEqual(await outbox(ctx, quiet), ['registration_approved'])

  const loud = (await fixture(ctx, { count: 0, status: 'registration_open' })).id
  await add(ctx, 'owner', loud, [{ member_one: 'Ona', contact: 'ona@example.test' }, { member_one: 'Jonas' }], { notify: true })
  assert.deepEqual(await outbox(ctx, loud), ['registration_approved'], 'only the row with an email')
})

test('capacity, pairs, individual formats, locks and rights apply to every row', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())

  const capped = (await fixture(ctx, { count: 0, status: 'registration_open' })).id
  await ctx.db.query('update tournaments set registration_capacity = 2 where id = $1', [capped])
  const full = await add(ctx, 'owner', capped, [{ member_one: 'A' }, { member_one: 'B' }, { member_one: 'C' }])
  assert.deepEqual(full.map(r => r.ok), [true, true, false])
  assert.equal(full[2].error, 'registration.full')
  const pending = await add(ctx, 'owner', capped, [{ member_one: 'C' }], { status: 'pending' })
  assert.equal(pending[0].status, 'pending', 'over capacity the rest can wait as pending')

  const doubles = (await fixture(ctx, { count: 0, status: 'registration_open', category: 'doubles', pairing: 'pre_agreed' })).id
  const pairs = await add(ctx, 'owner', doubles, [{ member_one: 'Ona', member_two: 'Rūta' }, { member_one: 'Jonas' }])
  assert.deepEqual(pairs.map(r => r.ok), [true, false])
  assert.equal(pairs[1].error, 'Double entry requires two participants')
  const members = (await ctx.db.query('select member_name from entry_members m join entries e on e.id = m.entry_id where e.tournament_id = $1 order by member_order', [doubles])).rows
  assert.deepEqual(members.map(m => m.member_name), ['Ona', 'Rūta'])

  const americano = (await fixture(ctx, { count: 0, status: 'registration_open', sport: 'padel', category: 'doubles', pairing: 'pick_random', format: 'americano', scoringConfig: { points_per_match: 24 } })).id
  const players = await add(ctx, 'owner', americano, [{ member_one: 'Ona' }, { member_one: 'Jonas', member_two: 'Petras' }])
  assert.equal(players[0].ok, true)
  assert.equal(players[1].ok, false, 'one player per entry in Americano')

  const started = (await fixture(ctx, { count: 0, status: 'in_progress' })).id
  assert.equal((await add(ctx, 'owner', started, [{ member_one: 'Late' }]))[0].error, 'drafts.rulesLocked')

  await assert.rejects(add(ctx, 'counter', capped, [{ member_one: 'X' }]), /Not allowed/)
  await assert.rejects(add(ctx, 'outsider', capped, [{ member_one: 'X' }]), /Not allowed/)
  await assert.rejects(add(ctx, 'anon', capped, [{ member_one: 'X' }]), /permission denied/)
  await assert.rejects(add(ctx, 'owner', capped, []), /serverErrors\.importEmpty/)
  await assert.rejects(add(ctx, 'owner', capped, Array.from({ length: 129 }, (_, i) => ({ member_one: `P${i}` }))), /serverErrors\.importTooMany/)
})
