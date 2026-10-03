import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const setStream = (actor, matchId, url) => asActor(ctx, actor, 'select set_match_stream($1,$2) r', [matchId, url])
const matchRow = async id => (await ctx.db.query('select * from matches where id=$1', [id])).rows[0]

async function bracket(options = {}) {
  const t = await fixture(ctx, { isPublic: true, ...options })
  await asActor(ctx, options.owner || 'owner', 'select generate_bracket($1)', [t.id])
  return { t, list: await matches(ctx, t.id) }
}

test('every scoring role sets a link; it reaches the public snapshot and keeps the score revision', async () => {
  const { t, list } = await bracket()
  const match = list[0]
  const revision = match.score_revision
  for (const [actor, url] of [
    ['owner', 'https://www.youtube.com/live/abcDEF12345'],
    ['editor', 'https://youtu.be/abcDEF12345?t=10'],
    ['counter', 'https://m.youtube.com/watch?v=abcDEF12345'],
  ]) {
    const { rows } = await setStream(actor, match.id, `  ${url}  `)
    assert.equal(rows[0].r.stream_url, url)
    assert.equal((await matchRow(match.id)).stream_url, url)
  }
  assert.equal((await matchRow(match.id)).score_revision, revision)

  const snap = (await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.equal(snap.matches.find(m => m.id === match.id).stream_url, 'https://m.youtube.com/watch?v=abcDEF12345')

  await setStream('owner', match.id, '')
  assert.equal((await matchRow(match.id)).stream_url, null)
  assert.equal((await matchRow(match.id)).score_revision, revision)
})

test('a result change still bumps the revision', async () => {
  const { list } = await bracket()
  const match = list[0]
  await setStream('owner', match.id, 'https://www.youtube.com/watch?v=abc')
  const revision = (await matchRow(match.id)).score_revision
  await ctx.db.query("update matches set status='pending', stream_url=null where id=$1", [match.id])
  assert.equal((await matchRow(match.id)).score_revision, revision + 1)
})

test('only YouTube https links are accepted', async () => {
  const { list } = await bracket()
  for (const url of [
    'http://www.youtube.com/live/abc',
    'https://vimeo.com/123',
    'https://youtube.com.evil.test/live/abc',
    'https://www.youtube.com/',
    'javascript:alert(1)',
    'https://www.youtube.com/watch?v=a b',
    `https://youtu.be/${'x'.repeat(500)}`,
  ]) {
    await assert.rejects(setStream('owner', list[0].id, url), /stream\.invalidUrl/, url)
  }
  assert.equal((await matchRow(list[0].id)).stream_url, null)
  await assert.rejects(ctx.db.query("update matches set stream_url='https://vimeo.com/1' where id=$1", [list[0].id]), /matches_stream_url_ck/)
})

test('outsiders, anonymous viewers and other tournaments cannot set a link', async () => {
  const { list } = await bracket()
  await assertDeniedUnchanged(ctx, 'outsider', 'select set_match_stream($1,$2)', [list[0].id, 'https://youtu.be/abc'])
  await assertDeniedUnchanged(ctx, 'anon', 'select set_match_stream($1,$2)', [list[0].id, 'https://youtu.be/abc'], /permission denied/)
  const foreign = await bracket({ owner: 'outsider' })
  await assertDeniedUnchanged(ctx, 'owner', 'select set_match_stream($1,$2)', [foreign.list[0].id, 'https://youtu.be/abc'])
})

test('the migration re-applies without losing links', async () => {
  const { list } = await bracket()
  await setStream('owner', list[0].id, 'https://youtu.be/keep')
  await reapplyForwardMigrations(ctx)
  assert.equal((await matchRow(list[0].id)).stream_url, 'https://youtu.be/keep')
})
