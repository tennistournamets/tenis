import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, snapshot, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])
const status = async t => (await ctx.db.query('select status from tournaments where id=$1', [t.id])).rows[0].status
const setEntry = (id, value) => ctx.db.query('update entries set status=$2 where id=$1', [id, value])
async function addEntry(t, name) {
  const r = (await asActor(ctx, 'owner', "select add_manual_entry($1,$2,null,null,null,'approved'::registration_status) r", [t.id, name])).rows[0].r
  return r.id
}

const GENERATORS = {
  single_elimination: { count: 4, sql: 'select generate_bracket($1)' },
  double_elimination: { count: 4, sql: 'select generate_bracket($1)' },
  round_robin: { count: 4, sql: 'select generate_round_robin($1)' },
  groups_playoff: { count: 4, sql: 'select generate_groups($1,2)' },
}

// R2-01 -----------------------------------------------------------------------

test('R2-01: the server refuses to start while the matches do not hold the approved field, in every format', async () => {
  for (const [format, { count, sql }] of Object.entries(GENERATORS)) {
    const t = await fixture(ctx, { status: 'registration_closed', format, count })
    await asActor(ctx, 'owner', sql, [t.id])
    assert.ok((await matches(ctx, t.id)).length > 0, format)

    // A participant rejected after the draw still plays.
    await setEntry(t.entries[1], 'rejected')
    let before = await snapshot(ctx)
    await assert.rejects(settings(t, { status: 'in_progress' }), /lifecycle\.rosterStale/, `${format}: rejected`)
    assert.deepEqual(await snapshot(ctx), before, `${format}: nothing changes`)

    // Back in the field: the structure matches again.
    await setEntry(t.entries[1], 'approved')
    // A new approved entry has no match yet.
    await ctx.db.query("update tournaments set status='registration_open' where id=$1", [t.id])
    const late = await addEntry(t, `Late ${format}`)
    before = await snapshot(ctx)
    await assert.rejects(settings(t, { status: 'in_progress' }), /lifecycle\.rosterStale/, `${format}: approved late`)
    assert.deepEqual(await snapshot(ctx), before)

    // Taking the late entry out again (or regenerating) makes the start possible.
    await setEntry(late, 'rejected')
    await settings(t, { status: 'registration_closed' })
    await settings(t, { status: 'in_progress' })
    assert.equal(await status(t), 'in_progress', format)
  }
})

test('R2-01: a regenerated structure starts; other settings and the stop/restart cycle are unaffected', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', format: 'round_robin', count: 3 })
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  await setEntry(t.entries[2], 'rejected')
  // Only the status transition is guarded: renaming a stale tournament still saves.
  await settings(t, { name: 'Renamed while stale' })
  await assert.rejects(settings(t, { status: 'in_progress' }), /lifecycle\.rosterStale/)
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  await settings(t, { status: 'in_progress' })
  // Stop and restart with the same field keeps working.
  await settings(t, { status: 'registration_closed' })
  await settings(t, { status: 'in_progress' })
  // A running tournament keeps saving other settings even if the field changes later.
  await setEntry(t.entries[1], 'rejected')
  await settings(t, { name: 'Still running', status: 'in_progress' })
  assert.equal(await status(t), 'in_progress')
  // Without any match there is no structure to compare (unchanged behaviour).
  const empty = await fixture(ctx, { status: 'registration_closed', count: 2 })
  await settings(empty, { status: 'in_progress' })
  assert.equal(await status(empty), 'in_progress')
})

test('R2-01: the roster helper is internal', async () => {
  const t = await fixture(ctx, { status: 'registration_closed' })
  for (const actor of ['anon', 'owner']) {
    await assert.rejects(asActor(ctx, actor, 'select tournament_roster_stale($1)', [t.id]), /permission denied/, actor)
  }
})

// R2-05 -----------------------------------------------------------------------

test('R2-05: scheduling a finished or live match names the reason', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', isPublic: true })
  await asActor(ctx, 'owner', 'select generate_bracket($1)', [t.id])
  const semis = (await matches(ctx, t.id)).filter(m => m.round_number === 1)
  const [court] = (await asActor(ctx, 'owner', 'select save_courts($1,$2,$3) c', [t.id, JSON.stringify([{ name: 'Court 1' }]), await revision(t.id)])).rows[0].c
  const schedule = m => asActor(ctx, 'owner', 'select set_match_schedule($1,$2,null,null,null,false)', [m.id, court.id])
  const queue = m => asActor(ctx, 'owner', 'select place_match_in_court_queue($1,$2,$3,true)', [m.id, court.id, [m.id]])
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  await ctx.db.query("update matches set status='finished' where id=$1", [semis[0].id])
  await assert.rejects(schedule(semis[0]), /schedule\.matchFinished/)
  await assert.rejects(queue(semis[0]), /schedule\.matchFinished/)
  await asActor(ctx, 'counter', 'select start_live_match($1,$2)', [semis[1].id, semis[1].score_revision])
  await assert.rejects(schedule(semis[1]), /schedule\.matchLive/)
  await assert.rejects(queue(semis[1]), /schedule\.matchLive/)
})

// R2-18 -----------------------------------------------------------------------

test('R2-18: before the first result standings follow the seeding, then the name', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', format: 'round_robin', count: 4, isPublic: true })
  // Names sort opposite to the seeding; seed 3 is left unseeded.
  const names = ['Zed', 'Yan', 'Xavier', 'Walt']
  for (const [i, id] of t.entries.entries()) await ctx.db.query('update entries set display_name=$2, seed_order=$3 where id=$1', [id, names[i], i === 2 ? null : i + 1])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  const ranked = async () => (await asActor(ctx, 'anon', 'select display_name, rank from get_standings($1) order by rank', [t.id])).rows.map(r => r.display_name)
  assert.deepEqual(await ranked(), ['Zed', 'Yan', 'Walt', 'Xavier'])
  // Nobody seeded: alphabetical, as before.
  await ctx.db.query('update entries set seed_order=null where tournament_id=$1', [t.id])
  assert.deepEqual(await ranked(), ['Walt', 'Xavier', 'Yan', 'Zed'])
  // The public contract keeps its columns.
  const columns = (await asActor(ctx, 'anon', 'select * from get_standings($1) limit 1', [t.id])).fields.map(f => f.name)
  assert.deepEqual(columns, ['entry_id', 'display_name', 'played', 'won', 'drawn', 'lost', 'score_for', 'score_against', 'diff', 'points', 'rank'])
})

test('R2: the migration can be applied again without changing data', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', format: 'round_robin', count: 3 })
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
  await setEntry(t.entries[0], 'rejected')
  await assert.rejects(settings(t, { status: 'in_progress' }), /lifecycle\.rosterStale/)
})

// R2-19 -----------------------------------------------------------------------

test('R2-19: the padel tie-break target is saved through the settings before the start', async () => {
  const t = await fixture(ctx, { status: 'registration_open', sport: 'padel', category: 'doubles', count: 0, scoringConfig: { tiebreak_to: 7, gender: 'mixed' } })
  await settings(t, { scoring_config: { tiebreak_to: 10, gender: 'mixed' } })
  const config = (await ctx.db.query('select scoring_config from tournaments where id=$1', [t.id])).rows[0].scoring_config
  assert.equal(config.tiebreak_to, 10)
})
