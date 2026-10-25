import assert from 'node:assert/strict'
import test from 'node:test'
import { asActor, createDatabase, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

async function setFlags(ctx, flags) {
  for (const [key, on] of Object.entries(flags)) {
    await ctx.db.query('insert into feature_flags(key,enabled) values ($1,$2) on conflict (key) do update set enabled=excluded.enabled', [key, on])
  }
}

const begin = (ctx, actor, task, tournamentId = null) =>
  asActor(ctx, actor, 'select ai_begin_call($1,$2) r', [task, tournamentId]).then(res => res.rows[0].r)

test('AI switches start off; a feature needs both the master and its own switch', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const rows = (await ctx.db.query("select key, enabled from feature_flags where key = 'ai' or key like 'ai.%' order by key")).rows
  assert.deepEqual(rows.map(r => r.key), ['ai', 'ai.create', 'ai.import', 'ai.posts', 'ai.score', 'ai.voice'])
  assert.ok(rows.every(r => r.enabled === false))

  const enabled = async feature => (await asActor(ctx, 'anon', 'select is_ai_feature_enabled($1) enabled', [feature])).rows[0].enabled
  assert.equal(await enabled('import'), false)
  await setFlags(ctx, { 'ai.import': true })
  assert.equal(await enabled('import'), false, 'feature on, master off')
  await setFlags(ctx, { ai: true })
  assert.equal(await enabled('import'), true)
  assert.equal(await enabled('create'), false, 'master on, feature off')
  assert.equal(await enabled('unknown'), false)
  assert.equal(await enabled(null), false)

  // The seed never overwrites a decision made in /admin/platform.
  await reapplyForwardMigrations(ctx)
  assert.equal(await enabled('import'), true)
})

test('begin checks the switches, the task and the caller\'s rights on the tournament', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await fixture(ctx, { status: 'registration_open' })

  await assert.rejects(begin(ctx, 'owner', 'import', id), /ai\.disabled/)
  await setFlags(ctx, { ai: true, 'ai.import': true, 'ai.create': true, 'ai.score': true, 'ai.posts': true })

  await assert.rejects(begin(ctx, 'anon', 'import', id), /permission denied/)
  await assert.rejects(begin(ctx, 'owner', 'translate', id), /ai\.badTask/)
  await assert.rejects(begin(ctx, 'owner', 'create', id), /ai\.badTask/, 'create has no tournament yet')
  await assert.rejects(begin(ctx, 'owner', 'import'), /ai\.forbidden/)
  await assert.rejects(begin(ctx, 'outsider', 'import', id), /ai\.forbidden/)
  await assert.rejects(begin(ctx, 'counter', 'import', id), /ai\.forbidden/, 'results-only role cannot import')
  await assert.rejects(begin(ctx, 'outsider', 'score', id), /ai\.forbidden/)

  const call = await begin(ctx, 'editor', 'import', id)
  assert.equal(call.remaining, 19)
  assert.ok((await begin(ctx, 'counter', 'score', id)).id)
  assert.ok((await begin(ctx, 'outsider', 'create')).id, 'any signed-in organizer may describe a new tournament')

  await setFlags(ctx, { ai: false })
  await assert.rejects(begin(ctx, 'owner', 'import', id), /ai\.disabled/, 'master switch stops every feature')
})

test('the daily limit counts the caller\'s calls per feature; platform admins have none', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  await setFlags(ctx, { ai: true, 'ai.create': true })
  for (let i = 0; i < 30; i++) await begin(ctx, 'owner', 'create')
  await assert.rejects(begin(ctx, 'owner', 'create'), /ai\.limit/)
  assert.ok((await begin(ctx, 'editor', 'create')).id, 'another user has their own limit')

  // Calls older than 24 hours no longer count.
  await ctx.db.query("update ai_usage set created_at = now() - interval '25 hours' where user_id = $1", [ctx.actors.owner])
  assert.equal((await begin(ctx, 'owner', 'create')).remaining, 29)

  for (let i = 0; i < 12; i++) await begin(ctx, 'platform_admin', 'create')
  assert.equal((await begin(ctx, 'platform_admin', 'create')).remaining, null)
})

test('finish closes only the caller\'s open row; the journal is readable by platform admins only', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  await setFlags(ctx, { ai: true, 'ai.create': true })
  const { id } = await begin(ctx, 'owner', 'create')

  await asActor(ctx, 'editor', 'select ai_finish_call($1,true,1,1,null)', [id])
  assert.equal((await ctx.db.query('select finished_at from ai_usage where id=$1', [id])).rows[0].finished_at, null, 'not the editor\'s row')

  await asActor(ctx, 'owner', 'select ai_finish_call($1,true,1200,350,null)', [id])
  await asActor(ctx, 'owner', "select ai_finish_call($1,false,9,9,'late')", [id])
  const row = (await ctx.db.query('select * from ai_usage where id=$1', [id])).rows[0]
  assert.equal(row.ok, true)
  assert.equal(row.tokens_in, 1200)
  assert.equal(row.tokens_out, 350)
  assert.equal(row.error_code, null, 'a closed row stays as it was')

  const failed = await begin(ctx, 'owner', 'create')
  await asActor(ctx, 'owner', "select ai_finish_call($1,false,null,null,'ai.timeout')", [failed.id])

  assert.equal((await asActor(ctx, 'owner', 'select count(*)::int n from ai_usage')).rows[0].n, 0)
  assert.equal((await asActor(ctx, 'platform_admin', 'select count(*)::int n from ai_usage')).rows[0].n, 2)
  await assert.rejects(asActor(ctx, 'owner', "insert into ai_usage(user_id,task) values ($1,'create')", [ctx.actors.owner]), /permission denied/)
  await assert.rejects(asActor(ctx, 'owner', 'update ai_usage set ok = true'), /permission denied/)

  await assert.rejects(asActor(ctx, 'owner', 'select ai_usage_summary(7)'), /Platform admin required/)
  const summary = (await asActor(ctx, 'platform_admin', 'select ai_usage_summary(7) s')).rows[0].s
  assert.deepEqual(summary, { days: 7, tasks: [{ task: 'create', calls: 2, failed: 1, users: 1, tokens_in: 1200, tokens_out: 350 }] })
})
