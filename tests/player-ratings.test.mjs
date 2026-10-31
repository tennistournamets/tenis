import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

let seq = 0
const open = async ({ rating = 'optional', ...options } = {}) => {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, count: 0, ...options })
  await ctx.db.query('update tournaments set player_rating=$2 where id=$1', [t.id, rating])
  return t
}
const register = (t, { name = 'Player', partner = null, type = 'singles', ratings = null } = {}) => {
  seq += 1
  return asActor(ctx, 'anon', "select register_entry($1,$2,null,$3,$4,null,null,$5,$6,$7) r",
    [t.id, type, name, partner, `+3706000${String(seq).padStart(4, '0')}`, `p${seq}@example.test`, ratings == null ? null : JSON.stringify(ratings)])
}
const ratingsOf = async (actor, t) => (await asActor(ctx, actor, 'select * from get_entry_ratings($1)', [t.id])).rows
  .map(r => [r.member_order, r.rating_type, Number(r.rating_value)])

test('tennis players give TNL and LTS ratings; organizers read them, others do not', async () => {
  const t = await open()
  await register(t, { name: 'Jonas', ratings: [[{ type: 'tnl', value: '4,25' }, { type: 'lts', value: 37 }]] })
  assert.deepEqual((await ratingsOf('owner', t)).sort(), [[1, 'lts', 37], [1, 'tnl', 4.25]])
  assert.equal((await ratingsOf('editor', t)).length, 2)
  assert.deepEqual(await ratingsOf('outsider', t), [])
  await assert.rejects(asActor(ctx, 'anon', 'select * from get_entry_ratings($1)', [t.id]), /permission denied/)
  await assert.rejects(asActor(ctx, 'owner', 'select * from entry_member_ratings'), /permission denied/)
  await assert.rejects(asActor(ctx, 'anon', 'select * from entry_member_ratings'), /permission denied/)
})

test('values outside the scale, kinds of another sport and repeated kinds are refused with nothing saved', async () => {
  const t = await open()
  const padel = await open({ sport: 'padel', category: 'doubles', pairing: 'pre_agreed' })
  const before = await snapshot(ctx)
  await assert.rejects(register(t, { ratings: [[{ type: 'tnl', value: 9 }]] }), /rating\.invalid/)
  await assert.rejects(register(t, { ratings: [[{ type: 'tnl', value: 4.255 }]] }), /rating\.invalid/)
  await assert.rejects(register(t, { ratings: [[{ type: 'lts', value: 2.5 }]] }), /rating\.invalid/)
  await assert.rejects(register(t, { ratings: [[{ type: 'padel_level', value: 4 }]] }), /rating\.invalid/)
  await assert.rejects(register(t, { ratings: [[{ type: 'tnl', value: 'abc' }]] }), /rating\.invalid/)
  await assert.rejects(register(t, { ratings: [[{ type: 'tnl', value: 3 }, { type: 'tnl', value: 4 }]] }), /rating\.duplicate/)
  await assert.rejects(register(padel, { type: 'doubles', name: 'A', partner: 'B', ratings: [[{ type: 'padel_level', value: 4.2 }]] }), /rating\.invalid/)
  await assert.rejects(register(padel, { type: 'doubles', name: 'A', partner: 'B', ratings: [[{ type: 'lts', value: 4 }]] }), /rating\.invalid/)
  assert.deepEqual(await snapshot(ctx), before)
})

test('padel pairs give a rating for each player', async () => {
  const t = await open({ sport: 'padel', category: 'doubles', pairing: 'pre_agreed' })
  await register(t, { type: 'doubles', name: 'Ona', partner: 'Rasa', ratings: [[{ type: 'padel_level', value: 4.5 }, { type: 'padelution', value: 2092 }], [{ type: 'tnl', value: 3.1 }]] })
  const rows = await ratingsOf('owner', t)
  assert.deepEqual(rows.filter(r => r[0] === 1).map(r => r[1]).sort(), ['padel_level', 'padelution'])
  assert.deepEqual(rows.filter(r => r[0] === 2), [[2, 'tnl', 3.1]])
})

test('"required" needs a rating for every player; "off" ignores sent ratings', async () => {
  const required = await open({ rating: 'required', category: 'doubles', pairing: 'pre_agreed' })
  await assert.rejects(register(required, { type: 'doubles', name: 'A', partner: 'B' }), /rating\.required/)
  await assert.rejects(register(required, { type: 'doubles', name: 'A', partner: 'B', ratings: [[{ type: 'tnl', value: 3 }]] }), /rating\.required/)
  await register(required, { type: 'doubles', name: 'A', partner: 'B', ratings: [[{ type: 'tnl', value: 3 }], [{ type: 'lts', value: 120 }]] })
  assert.equal((await ratingsOf('owner', required)).length, 2)

  const off = await open({ rating: 'off' })
  const result = (await register(off, { ratings: [[{ type: 'tnl', value: 99 }]] })).rows[0].r
  assert.equal(result.status, 'pending')
  assert.deepEqual(await ratingsOf('owner', off), [])

  const optional = await open()
  await register(optional, { name: 'No rating' })
  assert.deepEqual(await ratingsOf('owner', optional), [])
})

test('random pairing keeps each player\'s ratings through forming and splitting pairs', async () => {
  const t = await open({ sport: 'padel', category: 'doubles', pairing: 'pick_random' })
  const ids = []
  for (const [name, value] of [['Aistė', 4], ['Birutė', 3.5]]) {
    ids.push((await register(t, { type: 'doubles', name, ratings: [[{ type: 'padel_level', value }]] })).rows[0].r.id)
  }
  await ctx.db.query("update entries set status='approved' where tournament_id=$1", [t.id])
  await asActor(ctx, 'owner', 'select form_manual_pairs($1,$2)', [t.id, JSON.stringify([ids])])
  let rows = (await asActor(ctx, 'owner', 'select * from get_entry_ratings($1)', [t.id])).rows
  assert.deepEqual(rows.map(r => [r.entry_id, r.member_order, Number(r.rating_value)]), [[ids[0], 1, 4], [ids[0], 2, 3.5]])

  await asActor(ctx, 'owner', 'select split_pairs($1)', [t.id])
  rows = (await asActor(ctx, 'owner', 'select * from get_entry_ratings($1)', [t.id])).rows
  assert.equal(new Set(rows.map(r => r.entry_id)).size, 2)
  assert.deepEqual(rows.map(r => [r.member_order, Number(r.rating_value)]).sort(), [[1, 3.5], [1, 4]])

  await asActor(ctx, 'owner', 'select form_random_pairs($1)', [t.id])
  rows = (await asActor(ctx, 'owner', 'select * from get_entry_ratings($1)', [t.id])).rows
  assert.equal(new Set(rows.map(r => r.entry_id)).size, 1)
  assert.deepEqual(rows.map(r => r.member_order).sort(), [1, 2])
})

test('the setting is saved through settings, shown in the snapshot, and the chain replays', async () => {
  const t = await open({ rating: 'off' })
  const rev = (await ctx.db.query('select settings_revision from tournaments where id=$1', [t.id])).rows[0].settings_revision
  await asActor(ctx, 'owner', 'select update_tournament_settings($1,$2,$3)', [t.id, JSON.stringify({ player_rating: 'required' }), rev])
  await assert.rejects(asActor(ctx, 'owner', 'select update_tournament_settings($1,$2,$3)', [t.id, JSON.stringify({ player_rating: 'maybe' }), rev + 1]), /rating\.invalidSetting/)
  const state = (await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.equal(state.tournament.player_rating, 'required')
  await reapplyForwardMigrations(ctx)
  assert.equal((await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s.tournament.player_rating, 'required')
})

test('an organizer value wins over the player\'s, which is kept; counters and outsiders cannot set one', async () => {
  const t = await open()
  const entry = (await register(t, { name: 'Lukas', ratings: [[{ type: 'tnl', value: 3.5 }]] })).rows[0].r.id
  const member = (await ctx.db.query('select id from entry_members where entry_id=$1', [entry])).rows[0].id
  const rows = async () => (await asActor(ctx, 'owner', 'select rating_type, rating_value, organizer_value from get_entry_ratings($1)', [t.id])).rows
    .map(r => [r.rating_type, r.rating_value == null ? null : Number(r.rating_value), r.organizer_value == null ? null : Number(r.organizer_value)]).sort()

  await asActor(ctx, 'owner', 'select set_member_rating($1,$2,$3)', [member, 'tnl', 4.1])
  await asActor(ctx, 'editor', 'select set_member_rating($1,$2,$3)', [member, 'lts', 12])
  assert.deepEqual(await rows(), [['lts', null, 12], ['tnl', 3.5, 4.1]])

  await assert.rejects(asActor(ctx, 'owner', 'select set_member_rating($1,$2,$3)', [member, 'tnl', 8.5]), /rating\.invalid/)
  await assert.rejects(asActor(ctx, 'owner', 'select set_member_rating($1,$2,$3)', [member, 'padel_level', 4]), /rating\.invalid/)
  for (const actor of ['counter', 'outsider']) {
    await assert.rejects(asActor(ctx, actor, 'select set_member_rating($1,$2,$3)', [member, 'tnl', 5]), /Not allowed/)
  }
  await assert.rejects(asActor(ctx, 'anon', 'select set_member_rating($1,$2,$3)', [member, 'tnl', 5]), /permission denied/)

  // Clearing: the organizer-only kind disappears, the player's value stays.
  await asActor(ctx, 'owner', 'select set_member_rating($1,$2,null)', [member, 'lts'])
  await asActor(ctx, 'owner', 'select set_member_rating($1,$2,null)', [member, 'tnl'])
  assert.deepEqual(await rows(), [['tnl', 3.5, null]])
})
