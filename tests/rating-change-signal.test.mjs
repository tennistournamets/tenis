import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

// xmin changes with every new row version: a reliable "was updated" check
// (two timestamps can land on the same millisecond).
const entryRow = async id => (await ctx.db.query('select xmin::text as version, status from entries where id=$1', [id])).rows[0]
const outbox = async id => Number((await ctx.db.query('select count(*) from notification_outbox where entry_id=$1', [id])).rows[0].count)

// Realtime cannot carry the closed ratings table, so a rating change touches
// its entry: organizer pages get the entries event and re-read the ratings.
test('setting, changing and clearing a rating touches the entry and nothing else', async () => {
  const t = await fixture(ctx, { status: 'registration_open', count: 1 })
  await ctx.db.query("update tournaments set player_rating='optional' where id=$1", [t.id])
  const entry = t.entries[0]
  const member = (await ctx.db.query('select id from entry_members where entry_id=$1', [entry])).rows[0].id
  const steps = [
    ['set', 'select set_member_rating($1,$2,$3)', [member, 'tnl', 4.5]],
    ['change', 'select set_member_rating($1,$2,$3)', [member, 'tnl', 4.8]],
    ['clear', 'select set_member_rating($1,$2,null)', [member, 'tnl']],
  ]
  for (const [name, sql, params] of steps) {
    const before = await entryRow(entry)
    const mails = await outbox(entry)
    await asActor(ctx, 'owner', sql, params)
    const after = await entryRow(entry)
    assert.notEqual(after.version, before.version, `${name} touches the entry`)
    assert.equal(after.status, before.status)
    assert.equal(await outbox(entry), mails, `${name} queues no email`)
  }
})

test('deleting an entry with ratings still works, and the chain replays', async () => {
  const t = await fixture(ctx, { status: 'registration_open', count: 1 })
  const member = (await ctx.db.query('select id from entry_members where entry_id=$1', [t.entries[0]])).rows[0].id
  await asActor(ctx, 'owner', 'select set_member_rating($1,$2,$3)', [member, 'tnl', 3])
  await ctx.db.query('delete from entries where id=$1', [t.entries[0]])
  assert.equal(Number((await ctx.db.query('select count(*) from entry_member_ratings where member_id=$1', [member])).rows[0].count), 0)
  await reapplyForwardMigrations(ctx)
})
