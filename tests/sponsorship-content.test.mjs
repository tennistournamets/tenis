import assert from 'node:assert/strict'
import test from 'node:test'
import { asActor, createDatabase, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

const FLAG = 'feature.sponsorship'

async function setFlag(ctx, on) {
  await ctx.db.query('insert into feature_flags(key,enabled) values ($1,$2) on conflict (key) do update set enabled=excluded.enabled', [FLAG, on])
}

// An approved tournament with the platform feature on.
async function approvedTournament(ctx, options = {}) {
  const t = await fixture(ctx, options)
  const req = (await asActor(ctx, 'owner', 'select * from request_sponsorship($1)', [t.id])).rows[0]
  await asActor(ctx, 'platform_admin', 'select * from decide_sponsorship_request($1,$2)', [req.id, 'approved'])
  await setFlag(ctx, true)
  return t
}

const config = (id, extra = {}) => ({
  sponsors: [{ id: 's1', name: 'BMW', url: 'https://www.bmw.com/', tier: 'title', logo: { path: `${id}/logo-1.webp`, width: 200, height: 200 }, logoDark: null }],
  slots: {
    hero: { enabled: true, sponsorId: 's1', label: '' },
    top: { enabled: true, banners: [{ id: 'b1', sponsorId: 's1', image: { url: '/sponsor-demo/bmw-banner-wide.svg' }, imageMobile: null, url: 'https://www.bmw.com/ix' }] },
  },
  ...extra,
})

const save = (ctx, actor, id, cfg, revision) =>
  asActor(ctx, actor, 'select * from save_sponsorship($1,$2,$3)', [id, JSON.stringify(cfg), revision])

test('only organizers of an approved tournament with the feature on save sponsorship, with a revision check', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await fixture(ctx)

  // Not approved yet.
  await setFlag(ctx, true)
  await assert.rejects(save(ctx, 'owner', id, config(id), 0), /Not allowed/)

  const req = (await asActor(ctx, 'owner', 'select * from request_sponsorship($1)', [id])).rows[0]
  await asActor(ctx, 'platform_admin', 'select * from decide_sponsorship_request($1,$2)', [req.id, 'approved'])

  for (const actor of ['anon', 'counter', 'outsider', 'platform_admin']) {
    await assert.rejects(save(ctx, actor, id, config(id), 0), /Not allowed|Authentication required|permission denied/, actor)
  }

  const first = (await save(ctx, 'owner', id, config(id), 0)).rows[0]
  assert.equal(first.revision, 1)
  assert.equal(first.updated_by, ctx.actors.owner)
  await assert.rejects(save(ctx, 'editor', id, config(id), 0), /Sponsorship changed/)
  assert.equal((await save(ctx, 'editor', id, config(id), 1)).rows[0].revision, 2)
  await assert.rejects(save(ctx, 'owner', id, config(id), 1), /Sponsorship changed/)

  // Feature switched off: nobody writes.
  await setFlag(ctx, false)
  await assert.rejects(save(ctx, 'owner', id, config(id), 2), /Not allowed/)
  await assert.rejects(asActor(ctx, 'owner', "update tournament_sponsorship set config='{}' where tournament_id=$1", [id]), /permission denied/)
})

test('links are http(s) only and images must be this tournament\'s files or the demo set', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await approvedTournament(ctx)
  const other = await fixture(ctx)

  const bad = [
    [{ sponsors: [{ id: 's', name: 'X', url: 'javascript:alert(1)' }], slots: {} }, /Invalid sponsor link/],
    [{ sponsors: [], slots: { top: { banners: [{ id: 'b', url: 'data:text/html,x', title: 'x' }] } } }, /Invalid sponsor link/],
    [{ sponsors: [{ id: 's', name: 'X', logo: { path: `${other.id}/logo.webp` } }], slots: {} }, /Invalid sponsor image/],
    [{ sponsors: [{ id: 's', name: 'X', logo: { path: `${id}/../x.webp` } }], slots: {} }, /Invalid sponsor image/],
    [{ sponsors: [{ id: 's', name: 'X', logo: { path: `${id}/logo.svg` } }], slots: {} }, /Invalid sponsor image/],
    [{ sponsors: [{ id: 's', name: 'X', logo: { url: 'https://evil.example/x.png' } }], slots: {} }, /Invalid sponsor image/],
    [{ sponsors: [{ id: 's', name: 'X', logo: {} }], slots: {} }, /Invalid sponsor image/],
    [{ sponsors: 'nope', slots: {} }, /Invalid sponsorship/],
    [{ sponsors: Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, name: 'X' })), slots: {} }, /too large/],
  ]
  for (const [cfg, error] of bad) await assert.rejects(save(ctx, 'owner', id, cfg, 0), error, JSON.stringify(cfg).slice(0, 80))

  assert.equal((await save(ctx, 'owner', id, config(id), 0)).rows[0].revision, 1)
})

test('spectators read the content only while approved, switched on and the tournament is visible to them', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await approvedTournament(ctx, { isPublic: true })
  await save(ctx, 'owner', id, config(id), 0)
  const read = actor => asActor(ctx, actor, 'select config from tournament_sponsorship where tournament_id=$1', [id])

  assert.equal((await read('anon')).rows.length, 1)
  assert.equal((await read('outsider')).rows[0].config.sponsors[0].name, 'BMW')

  await setFlag(ctx, false)
  assert.equal((await read('anon')).rows.length, 0)
  assert.equal((await read('owner')).rows.length, 1, 'organizers keep their own content')
  await setFlag(ctx, true)

  const req = (await ctx.db.query('select id from sponsorship_requests where tournament_id=$1', [id])).rows[0]
  await asActor(ctx, 'platform_admin', 'select * from decide_sponsorship_request($1,$2)', [req.id, 'rejected'])
  assert.equal((await read('anon')).rows.length, 0)
  await asActor(ctx, 'platform_admin', 'select * from decide_sponsorship_request($1,$2)', [req.id, 'approved'])

  await ctx.db.query("update tournaments set visibility='private' where id=$1", [id])
  assert.equal((await read('anon')).rows.length, 0, 'private tournament')
  assert.equal((await read('owner')).rows.length, 1)
})

test('the sponsor-assets bucket accepts files only from this tournament\'s organizers', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const bucket = (await ctx.db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id='sponsor-assets'")).rows[0]
  assert.equal(bucket.public, true)
  assert.equal(Number(bucket.file_size_limit), 2097152)
  assert.deepEqual(bucket.allowed_mime_types, ['image/webp', 'image/png', 'image/jpeg', 'image/gif'])

  const { id } = await approvedTournament(ctx)
  const other = await fixture(ctx)
  const upload = (actor, name) => asActor(ctx, actor, "insert into storage.objects(bucket_id,name) values ('sponsor-assets',$1) returning name", [name])

  assert.equal((await upload('owner', `${id}/a.webp`)).rows.length, 1)
  assert.equal((await upload('editor', `${id}/b.webp`)).rows.length, 1)
  for (const actor of ['counter', 'outsider', 'anon']) {
    await assert.rejects(upload(actor, `${id}/c.webp`), /row-level security|permission denied/, actor)
  }
  await assert.rejects(upload('owner', `${other.id}/c.webp`), /row-level security/, 'another tournament')
  await assert.rejects(upload('owner', 'not-a-tournament/c.webp'), /row-level security/)
  await assert.rejects(asActor(ctx, 'owner', "insert into storage.objects(bucket_id,name) values ('avatars',$1)", [`${id}/c.webp`]), /row-level security|foreign key/)

  // Deleting: organizers of the tournament only.
  assert.equal((await asActor(ctx, 'outsider', "delete from storage.objects where name=$1 returning name", [`${id}/a.webp`])).rows.length, 0)
  assert.equal((await asActor(ctx, 'owner', "delete from storage.objects where name=$1 returning name", [`${id}/a.webp`])).rows.length, 1)

  // Switched off: no uploads at all.
  await setFlag(ctx, false)
  await assert.rejects(upload('owner', `${id}/d.webp`), /row-level security/)
})

test('the content survives a replay of the forward migrations', async t => {
  const ctx = await createDatabase(); t.after(() => ctx.db.close())
  const { id } = await approvedTournament(ctx)
  await save(ctx, 'owner', id, config(id), 0)
  await reapplyForwardMigrations(ctx)
  const row = (await ctx.db.query('select revision, config from tournament_sponsorship where tournament_id=$1', [id])).rows[0]
  assert.equal(row.revision, 1)
  assert.equal(row.config.slots.hero.sponsorId, 's1')
  assert.equal((await ctx.db.query("select count(*)::int n from storage.buckets where id='sponsor-assets'")).rows[0].n, 1)
})
