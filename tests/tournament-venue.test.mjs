import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const row = async id => (await ctx.db.query('select * from tournaments where id=$1', [id])).rows[0]
const revision = async id => (await row(id)).settings_revision
const settings = (t, patch, actor = 'owner') =>
  revision(t.id).then(rev => asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), rev]))

test('a tournament can be created with an address and a point, and both reach the snapshot', async () => {
  const slug = `venue-${randomUUID()}`
  const { rows } = await asActor(ctx, 'owner', `select create_tournament('Venue cup', $1, null, 'tennis',
    'single_elimination', 'singles', 'best_of_3', true, null, '{}'::jsonb, '{}'::jsonb, null, null,
    '  Vilnius, Konstitucijos pr. 20  ', 54.6872, 25.2797) id`, [slug])
  const created = await row(rows[0].id)
  // The address is stored trimmed; the point is stored as given.
  assert.deepEqual(
    [created.venue_address, created.venue_lat, created.venue_lng],
    ['Vilnius, Konstitucijos pr. 20', 54.6872, 25.2797],
  )

  const snap = (await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [created.id])).rows[0].s
  assert.equal(snap.tournament.venue_address, 'Vilnius, Konstitucijos pr. 20')
  assert.equal(snap.tournament.venue_lat, 54.6872)
  assert.equal(snap.tournament.venue_lng, 25.2797)
})

test('creation refuses half a point and coordinates outside the world', async () => {
  const before = await snapshot(ctx)
  const attempts = [
    ['null, 54.6872, null', /venue\.invalidPoint/],
    ['null, null, 25.2797', /venue\.invalidPoint/],
    ['null, 91, 25', /venue\.invalidPoint/],
    ['null, 54, 181', /venue\.invalidPoint/],
  ]
  for (const [tail, expected] of attempts) {
    await assert.rejects(asActor(ctx, 'owner', `select create_tournament('Bad venue', $1, null, 'tennis',
      'single_elimination', 'singles', 'best_of_3', true, null, '{}'::jsonb, '{}'::jsonb, null, null, ${tail})`,
    [`bad-${randomUUID()}`]), expected, tail)
  }
  await assert.rejects(asActor(ctx, 'owner', `select create_tournament('Long address', $1, null, 'tennis',
    'single_elimination', 'singles', 'best_of_3', true, null, '{}'::jsonb, '{}'::jsonb, null, null, $2)`,
  [`long-${randomUUID()}`, 'x'.repeat(301)]), /venue\.invalidAddress/)
  assert.deepEqual(await snapshot(ctx), before)
})

test('the venue is a whitelisted setting and can be cleared again', async () => {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 0 })
  await settings(t, { venue_address: '  Court 1, Riga  ', venue_lat: 56.9496, venue_lng: 24.1052 })
  let current = await row(t.id)
  assert.deepEqual(
    [current.venue_address, current.venue_lat, current.venue_lng],
    ['Court 1, Riga', 56.9496, 24.1052],
  )

  await settings(t, { venue_address: '', venue_lat: null, venue_lng: null })
  current = await row(t.id)
  assert.deepEqual([current.venue_address, current.venue_lat, current.venue_lng], [null, null, null])
})

test('settings reject an incomplete point, a point off the globe and an overlong address', async () => {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 0 })
  await settings(t, { venue_address: 'Kept', venue_lat: 56.9496, venue_lng: 24.1052 })
  const before = await snapshot(ctx)
  await assert.rejects(settings(t, { venue_lat: 56.9496, venue_lng: null }), /venue\.invalidPoint/)
  await assert.rejects(settings(t, { venue_lat: -95, venue_lng: 24 }), /venue\.invalidPoint/)
  await assert.rejects(settings(t, { venue_address: 'y'.repeat(301) }), /venue\.invalidAddress/)
  assert.deepEqual(await snapshot(ctx), before)
})

test('a non-admin cannot set the venue, and the table constraint holds for direct writes', async () => {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 0 })
  await assertDeniedUnchanged(ctx, 'outsider', 'select update_tournament_settings($1,$2,$3)',
    [t.id, JSON.stringify({ venue_address: 'Hijacked' }), await revision(t.id)], /Not allowed/)
  await assert.rejects(ctx.db.query('update tournaments set venue_lat=10 where id=$1', [t.id]),
    /tournaments_venue_point_ck/)
})

test('the venue survives a replay of the forward chain', async () => {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 0 })
  await settings(t, { venue_address: 'Replay arena', venue_lat: 54.6872, venue_lng: 25.2797 })
  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
})
