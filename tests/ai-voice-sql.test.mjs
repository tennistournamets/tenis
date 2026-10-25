import assert from 'node:assert/strict'
import test from 'node:test'
import { asActor, createDatabase, fixture } from './helpers/database.mjs'

async function setFlags(ctx, flags) {
  for (const [key, on] of Object.entries(flags)) {
    await ctx.db.query('insert into feature_flags(key,enabled) values ($1,$2) on conflict (key) do update set enabled=excluded.enabled', [key, on])
  }
}
const begin = (ctx, actor, tournamentId = null) =>
  asActor(ctx, actor, "select ai_begin_call('voice',$1) r", [tournamentId]).then(res => res.rows[0].r)

test('voice input has its own switch under the master switch', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  assert.equal((await ctx.db.query("select enabled from feature_flags where key='ai.voice'")).rows[0].enabled, false)
  await setFlags(ctx, { ai: true, 'ai.create': true })
  await assert.rejects(begin(ctx, 'owner'), /ai\.disabled/, 'create on does not open voice')
  await setFlags(ctx, { 'ai.voice': true })
  assert.ok((await begin(ctx, 'owner')).id)
  await setFlags(ctx, { ai: false })
  await assert.rejects(begin(ctx, 'owner'), /ai\.disabled/)
})

test('a recording in the wizard needs no tournament; inside one it needs the right to enter results', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  await setFlags(ctx, { ai: true, 'ai.voice': true })
  const { id } = await fixture(ctx)
  assert.ok((await begin(ctx, 'outsider')).id, 'any organizer may dictate a new tournament')
  assert.ok((await begin(ctx, 'counter', id)).id, 'score keepers dictate scores')
  await assert.rejects(begin(ctx, 'outsider', id), /ai\.forbidden/)
  await assert.rejects(begin(ctx, 'anon'), /permission denied/)
})

test('voice keeps its own daily limit and journal rows (seconds of audio in tokens_in)', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  await setFlags(ctx, { ai: true, 'ai.voice': true })
  for (let i = 0; i < 60; i++) await begin(ctx, 'owner')
  await assert.rejects(begin(ctx, 'owner'), /ai\.limit/)
  const { id } = await begin(ctx, 'platform_admin')
  await asActor(ctx, 'platform_admin', 'select ai_finish_call($1,true,14,null,null)', [id])
  const summary = (await asActor(ctx, 'platform_admin', 'select ai_usage_summary(7) s')).rows[0].s
  assert.deepEqual(summary.tasks.find(row => row.task === 'voice'), { task: 'voice', calls: 61, failed: 60, users: 2, tokens_in: 14, tokens_out: 0 })
})
