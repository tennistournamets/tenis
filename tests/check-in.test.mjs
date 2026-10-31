import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const check = (actor, entry, on = true) => asActor(ctx, actor, 'select set_entry_checked_in($1,$2) v', [entry, on]).then(r => r.rows[0].v)
const removeAbsent = (actor, t) => asActor(ctx, actor, 'select remove_absent_entries($1) n', [t.id]).then(r => r.rows[0].n)
const entry = async id => (await ctx.db.query('select * from entries where id=$1', [id])).rows[0]
const outbox = async () => Number((await ctx.db.query('select count(*) n from notification_outbox')).rows[0].n)

test('owners and editors mark who came; the mark keeps its first time; counters and outsiders cannot', async () => {
  const t = await fixture(ctx, { status: 'registration_closed' })
  const [a, b] = t.entries
  const first = await check('owner', a)
  assert.ok(first)
  assert.equal((await check('editor', a)).getTime(), first.getTime())
  assert.equal(await check('owner', a, false), null)
  await check('editor', b)
  for (const actor of ['counter', 'outsider']) await assertDeniedUnchanged(ctx, actor, 'select set_entry_checked_in($1,true)', [a])
  await ctx.db.query("update entries set status='pending' where id=$1", [a])
  await assert.rejects(check('owner', a), /checkIn\.notApproved/)
  const state = (await asActor(ctx, 'owner', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.ok(state.entries.find(e => e.id === b).checked_in_at)
})

test('before the start the absent are rejected without an email', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', count: 4 })
  await assert.rejects(removeAbsent('owner', t), /checkIn\.noneChecked/)
  await check('owner', t.entries[0])
  await check('owner', t.entries[1])
  const mails = await outbox()
  assert.equal(await removeAbsent('editor', t), 2)
  assert.deepEqual(await Promise.all(t.entries.map(async id => (await entry(id)).status)), ['approved', 'approved', 'rejected', 'rejected'])
  assert.equal(await outbox(), mails)
  await assertDeniedUnchanged(ctx, 'counter', 'select remove_absent_entries($1)', [t.id])
})

test('while the tournament runs the absent withdraw: their matches become walkovers', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', count: 4, format: 'round_robin' })
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  for (const id of t.entries.slice(0, 3)) await check('owner', id)
  const gone = t.entries[3]
  assert.equal(await removeAbsent('owner', t), 1)
  assert.ok((await entry(gone)).withdrawn_at)
  const mine = (await matches(ctx, t.id)).filter(m => [m.side_a_entry_id, m.side_b_entry_id].includes(gone))
  assert.equal(mine.length, 3)
  assert.ok(mine.every(m => m.result_type === 'walkover' && m.winner_entry_id !== gone))
  // Running it again finds nobody new.
  assert.equal(await removeAbsent('owner', t), 0)

  await ctx.db.query("update tournaments set status='completed' where id=$1", [t.id])
  await assert.rejects(check('owner', t.entries[0], false), /checkIn\.completed/)
  await reapplyForwardMigrations(ctx)
})
