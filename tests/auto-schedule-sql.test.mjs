import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'
import { planSchedule } from '../src/lib/autoSchedule.js'
import { indexSchedule } from '../src/lib/schedule.js'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const START = '2026-10-10T10:00:00.000Z'
const CONFIG = { match_minutes: 90, start_at: START }
const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const saveCourts = async (t, courts) =>
  (await asActor(ctx, 'owner', 'select save_courts($1,$2,$3) c', [t.id, JSON.stringify(courts), await revision(t.id)])).rows[0].c
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])
const apply = async (t, rows, config = CONFIG, actor = 'owner') =>
  (await asActor(ctx, actor, 'select apply_auto_schedule($1,$2,$3) r', [t.id, JSON.stringify(rows), JSON.stringify(config)])).rows[0].r
const draftRows = async t => (await ctx.db.query(
  "select match_id, court_id, scheduled_at, time_kind, queue_order from match_schedule where tournament_id=$1 and state='draft' order by match_id", [t.id])).rows
const configOf = async t => (await ctx.db.query('select schedule_config from tournaments where id=$1', [t.id])).rows[0].schedule_config

async function setup({ count = 8, format = 'single_elimination' } = {}) {
  const t = await fixture(ctx, { status: 'registration_closed', isPublic: true, format, count })
  await asActor(ctx, 'owner', format === 'round_robin' ? 'select generate_round_robin($1)' : 'select generate_bracket($1)', [t.id])
  const courts = await saveCourts(t, [{ name: 'Court 1' }, { name: 'Court 2' }])
  return { t, courts }
}
async function plan(t, courts, input = {}) {
  const draft = indexSchedule((await ctx.db.query('select * from match_schedule where tournament_id=$1', [t.id])).rows).draft
  const live = (await ctx.db.query('select * from live_scores where tournament_id=$1', [t.id])).rows
  const result = planSchedule({ tournament: { format: 'single_elimination' }, matches: await matches(ctx, t.id), courts, draft, live,
    startAt: START, matchMinutes: 90, now: START, ...input })
  assert.equal(result.ok, true)
  return result
}
const iso = v => new Date(v).toISOString()

test('only organizers write the plan; it becomes the draft, the settings remember it and it publishes', async () => {
  const { t, courts } = await setup()
  await settings(t, { schedule_config: { min_rest_minutes: 15, timezone: 'Europe/Vilnius' } })
  const { rows } = await plan(t, courts)
  for (const actor of ['anon', 'outsider', 'counter', 'platform_admin']) {
    await assertDeniedUnchanged(ctx, actor, 'select apply_auto_schedule($1,$2,$3)', [t.id, JSON.stringify(rows), JSON.stringify(CONFIG)])
  }
  const result = await apply(t, rows, CONFIG, 'editor')
  assert.equal(result.scheduled, rows.length)
  assert.deepEqual(await configOf(t), { min_rest_minutes: 15, timezone: 'Europe/Vilnius', match_minutes: 90, start_at: START })
  const saved = await draftRows(t)
  assert.deepEqual(saved.map(r => [r.match_id, r.court_id, iso(r.scheduled_at), r.time_kind, r.queue_order]),
    [...rows].sort((a, b) => (a.match_id < b.match_id ? -1 : 1)).map(r => [r.match_id, r.court_id, r.scheduled_at, r.time_kind, r.queue_order]))
  const published = (await asActor(ctx, 'owner', 'select publish_schedule($1) p', [t.id])).rows[0].p
  assert.equal(published.published, rows.length)
  // Saving other settings afterwards keeps working with the new keys.
  await settings(t, { name: 'Renamed' })
  assert.equal((await configOf(t)).match_minutes, 90)
})

test('a recalculation replaces the draft of unplayed matches and keeps played and live ones', async () => {
  const { t, courts } = await setup()
  await apply(t, (await plan(t, courts)).rows)
  const ms = await matches(ctx, t.id)
  const r1 = ms.filter(m => m.round_number === 1)
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  await ctx.db.query("update matches set status='finished' where id=$1", [r1[0].id])
  await asActor(ctx, 'counter', 'select start_live_match($1,$2)', [r1[1].id, r1[1].score_revision])
  const before = Object.fromEntries((await draftRows(t)).map(r => [r.match_id, r]))
  const later = await plan(t, courts, { now: '2026-10-10T11:00:00.000Z' })
  // A stale plan may still carry the finished match: the server ignores that row.
  const stale = [...later.rows, { match_id: r1[0].id, court_id: courts[1].id, scheduled_at: '2026-10-10T18:00:00.000Z', time_kind: 'not_before', queue_order: 9 }]
  await apply(t, stale)
  const after = Object.fromEntries((await draftRows(t)).map(r => [r.match_id, r]))
  assert.deepEqual(after[r1[0].id], before[r1[0].id])
  assert.deepEqual(after[r1[1].id], before[r1[1].id])
  assert.equal(iso(after[r1[2].id].scheduled_at), later.rows.find(r => r.match_id === r1[2].id).scheduled_at)
  assert.equal(Object.keys(after).length, ms.length)
})

test('matches left out of the plan lose their draft row; manual rows are replaced', async () => {
  const { t, courts } = await setup({ count: 4 })
  const ms = await matches(ctx, t.id)
  await asActor(ctx, 'owner', 'select set_match_schedule($1,$2,$3,$4,$5,true)', [ms[0].id, courts[0].id, '2026-10-10T09:00:00Z', 'not_before', 1])
  await asActor(ctx, 'owner', 'select set_match_schedule($1,$2,$3,$4,$5,true)', [ms[1].id, courts[1].id, null, null, 1])
  await apply(t, [{ match_id: ms[1].id, court_id: courts[0].id, scheduled_at: START, time_kind: 'not_before', queue_order: 1 }])
  const left = await draftRows(t)
  assert.deepEqual(left.map(r => [r.match_id, r.court_id, r.queue_order]), [[ms[1].id, courts[0].id, 1]])
  assert.equal((await apply(t, [])).scheduled, 0)
  assert.equal((await draftRows(t)).length, 0)
})

test('bad settings, rows and courts are rejected without changes', async () => {
  const { t, courts } = await setup({ count: 4 })
  const other = await setup({ count: 4 })
  const [m1, m2] = await matches(ctx, t.id)
  const good = { match_id: m1.id, court_id: courts[0].id, scheduled_at: START, time_kind: 'not_before', queue_order: 1 }
  const cases = [
    [[good], {}, /schedule\.invalidConfig/],
    [[good], { match_minutes: 90 }, /schedule\.invalidConfig/],
    [[good], { ...CONFIG, match_minutes: 4 }, /schedule\.invalidConfig/],
    [[good], { ...CONFIG, match_minutes: 1.5 }, /schedule\.invalidConfig/],
    [[good], { ...CONFIG, match_minutes: '90' }, /schedule\.invalidConfig/],
    [[good], { ...CONFIG, start_at: 'soon' }, /schedule\.invalidConfig/],
    [[good], { ...CONFIG, start_at: 'tomorrow' }, /schedule\.invalidConfig/],
    [[good], { ...CONFIG, timezone: 'Europe/Vilnius' }, /schedule\.invalidConfig/],
    [{ rows: [] }, CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, match_id: 'nope' }], CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, scheduled_at: 'tomorrow' }], CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, scheduled_at: 1760090400000 }], CONFIG, /schedule\.invalidAssignment/],
    [[good, 'row'], CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, time_kind: 'sometime' }], CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, time_kind: null }], CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, court_id: null, scheduled_at: null, time_kind: null }], CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, court_id: null }], CONFIG, /schedule\.invalidAssignment/],
    [[good, { ...good, queue_order: 2 }], CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, match_id: (await matches(ctx, other.t.id))[0].id }], CONFIG, /schedule\.invalidAssignment/],
    [[{ ...good, court_id: other.courts[0].id }], CONFIG, /schedule\.invalidCourt/],
    [[good, { ...good, match_id: m2.id }], CONFIG, /schedule\.conflict/],
  ]
  for (const [rows, config, error] of cases) {
    const snap = await snapshot(ctx)
    await assert.rejects(apply(t, rows, config), error, JSON.stringify([rows, config]))
    assert.deepEqual(await snapshot(ctx), snap)
  }
})

test('the settings form accepts the duration and the start and validates them', async () => {
  const { t } = await setup({ count: 4 })
  for (const bad of [{ match_minutes: 0 }, { match_minutes: 601 }, { match_minutes: 60.5 }, { start_at: 'later' }, { start_at: 'now' }, { start_at: 5 }, { start_at: 'x'.repeat(41) }]) {
    const snap = await snapshot(ctx)
    await assert.rejects(settings(t, { schedule_config: bad }), /schedule\.invalidConfig/)
    assert.deepEqual(await snapshot(ctx), snap)
  }
  await settings(t, { schedule_config: { match_minutes: 45, start_at: START, min_rest_minutes: 0 } })
  assert.deepEqual(await configOf(t), { match_minutes: 45, start_at: START, min_rest_minutes: 0 })
  const snap = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), snap)
})
