import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const T1 = '2026-10-01T10:00:00.000Z', T2 = '2026-10-01T10:30:00.000Z', T3 = '2026-10-01T12:00:00.000Z'
const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const saveCourts = async (t, courts, actor = 'owner', rev = null) =>
  (await asActor(ctx, actor, 'select save_courts($1,$2,$3) c', [t.id, JSON.stringify(courts), rev ?? await revision(t.id)])).rows[0].c
const setSchedule = async (m, { court = null, at = null, kind = null, queue = null, ignore = false } = {}, actor = 'owner') =>
  (await asActor(ctx, actor, 'select set_match_schedule($1,$2,$3,$4,$5,$6) r', [m.id, court, at, kind, queue, ignore])).rows[0].r
const check = async (m, { court = null, at = null, kind = null, queue = null } = {}, actor = 'owner') =>
  (await asActor(ctx, actor, 'select check_match_schedule($1,$2,$3,$4,$5) r', [m.id, court, at, kind, queue])).rows[0].r
const rows = async (t, state = null) => (await ctx.db.query('select * from match_schedule where tournament_id=$1 and ($2::text is null or state=$2) order by state,match_id', [t.id, state])).rows
const sync = async (t, actor) => (await asActor(ctx, actor, 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])

async function bracket() {
  const t = await fixture(ctx, { status: 'registration_closed', isPublic: true })
  await asActor(ctx, 'owner', 'select generate_bracket($1)', [t.id])
  const ms = await matches(ctx, t.id)
  const courts = await saveCourts(t, [{ name: 'Court 1' }, { name: 'Court 2' }])
  return { t, ms, semis: ms.filter(m => m.round_number === 1), final: ms.find(m => m.round_number === 2), courts }
}
async function roundRobin() {
  const t = await fixture(ctx, { status: 'registration_closed', isPublic: true, format: 'round_robin', count: 3 })
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  const courts = await saveCourts(t, [{ name: 'A' }, { name: 'B' }])
  return { t, ms: await matches(ctx, t.id), courts }
}
const sharing = (ms, entry) => ms.filter(m => m.side_a_entry_id === entry || m.side_b_entry_id === entry)

test('courts are managed by organizers with a settings revision; names must be unique and non-empty', async () => {
  const { t, courts } = await bracket()
  assert.deepEqual(courts.map(c => [c.name, c.sort_order]), [['Court 1', 1], ['Court 2', 2]])
  for (const actor of ['anon', 'outsider', 'counter', 'platform_admin']) {
    await assertDeniedUnchanged(ctx, actor, 'select save_courts($1,$2,$3)', [t.id, JSON.stringify([{ name: 'X' }]), await revision(t.id)])
  }
  for (const bad of [[{ name: '' }], [{ name: 'Dup' }, { name: 'Dup' }], [{ name: 'x'.repeat(61) }], { name: 'not an array' }]) {
    const before = await snapshot(ctx)
    await assert.rejects(saveCourts(t, bad), /schedule\.invalidCourts/)
    assert.deepEqual(await snapshot(ctx), before)
  }
  await assert.rejects(saveCourts(t, [{ name: 'Stale' }], 'owner', 0), /drafts\.conflict/)
  const renamed = await saveCourts(t, [{ id: courts[1].id, name: 'Centre court' }, { name: 'Court 3' }], 'editor')
  assert.deepEqual(renamed.map(c => c.name), ['Centre court', 'Court 3'])
  assert.equal(renamed[0].id, courts[1].id)
  assert.equal((await ctx.db.query('select count(*)::int n from courts where id=$1', [courts[0].id])).rows[0].n, 0)
})

test('assignments validate their shape and reject courts of another tournament', async () => {
  const { t, semis, courts } = await bracket()
  const other = await bracket()
  for (const bad of [{}, { at: T1 }, { kind: 'fixed' }, { court: courts[0].id, queue: 0 }, { queue: 2 }, { at: T1, kind: 'sometime' }]) {
    const before = await snapshot(ctx)
    await assert.rejects(setSchedule(semis[0], bad), /schedule\.invalidAssignment/)
    assert.deepEqual(await snapshot(ctx), before)
  }
  await assert.rejects(setSchedule(semis[0], { court: other.courts[0].id }), /schedule\.invalidCourt/)
  for (const actor of ['anon', 'outsider', 'counter', 'platform_admin']) {
    await assertDeniedUnchanged(ctx, actor, 'select set_match_schedule($1,$2,$3,$4,$5,false)', [semis[0].id, courts[0].id, T1, 'fixed', null])
    await assertDeniedUnchanged(ctx, actor, 'select check_match_schedule($1,$2,$3,$4,$5)', [semis[0].id, courts[0].id, T1, 'fixed', null])
  }
  const saved = await setSchedule(semis[0], { court: courts[0].id, at: T1, kind: 'fixed' }, 'editor')
  assert.equal(saved.schedule.state, 'draft')
  assert.deepEqual(saved.conflicts, [])
  const queued = await setSchedule(semis[1], { court: courts[1].id, queue: 1 })
  assert.equal(queued.schedule.queue_order, 1)
  assert.equal(queued.schedule.scheduled_at, null)
  await asActor(ctx, 'owner', 'select clear_match_schedule($1)', [semis[1].id])
  assert.equal((await rows(t, 'draft')).length, 1)
})

test('a court or a participant cannot be booked twice at the same fixed time; the rest gap only warns', async () => {
  const { t, ms, courts } = await roundRobin()
  const [a, b] = [ms[0].side_a_entry_id, ms[0].side_b_entry_id]
  const withA = sharing(ms, a)
  assert.equal(withA.length, 2)
  await setSchedule(withA[0], { court: courts[0].id, at: T1, kind: 'fixed' })
  let before = await snapshot(ctx)
  await assert.rejects(setSchedule(withA[1], { court: courts[0].id, at: T1, kind: 'fixed' }), /schedule\.conflict/)
  await assert.rejects(setSchedule(withA[1], { court: courts[1].id, at: T1, kind: 'fixed' }), /schedule\.conflict/)
  assert.deepEqual(await snapshot(ctx), before)
  const found = await check(withA[1], { court: courts[0].id, at: T1, kind: 'fixed' })
  assert.deepEqual(found.map(c => [c.kind, c.severity]).sort(), [['court_busy', 'hard'], ['participant_busy', 'hard']])
  // No rest configured: half an hour later is fine.
  const other = ms.find(m => !withA.includes(m))
  assert.ok(sharing([other], b).length === 1)
  const laterB = sharing(ms, b).find(m => m !== withA[0])
  await setSchedule(laterB, { court: courts[1].id, at: T2, kind: 'fixed' })
  await asActor(ctx, 'owner', 'select clear_match_schedule($1)', [laterB.id])
  await settings(t, { schedule_config: { min_rest_minutes: 60 } })
  before = await snapshot(ctx)
  await assert.rejects(setSchedule(laterB, { court: courts[1].id, at: T2, kind: 'fixed' }), /schedule\.warnings/)
  assert.deepEqual(await snapshot(ctx), before)
  const warned = await setSchedule(laterB, { court: courts[1].id, at: T2, kind: 'fixed', ignore: true })
  assert.deepEqual(warned.conflicts.map(c => [c.kind, c.severity, c.minutes]), [['rest_short', 'soft', 30]])
  const summary = (await asActor(ctx, 'owner', 'select schedule_draft_conflicts($1) r', [t.id])).rows[0].r
  assert.deepEqual(summary.map(x => x.match_id).sort(), [withA[0].id, laterB.id].sort())
  await assertDeniedUnchanged(ctx, 'counter', 'select schedule_draft_conflicts($1)', [t.id])
})

test('bracket order is a warning: a final before its semi-final, and queue places on one court are unique', async () => {
  const { semis, final, courts } = await bracket()
  await setSchedule(final, { court: courts[0].id, at: T1, kind: 'fixed' })
  const found = await check(semis[0], { court: courts[1].id, at: T3, kind: 'fixed' })
  assert.deepEqual(found, [{ kind: 'order_violation', severity: 'soft', match_id: final.id }])
  await assert.rejects(setSchedule(semis[0], { court: courts[1].id, at: T3, kind: 'fixed' }), /schedule\.warnings/)
  await setSchedule(semis[0], { court: courts[1].id, at: T3, kind: 'not_before', ignore: true })
  // The same feeder relation is reported from the final's side too.
  assert.deepEqual((await check(final, { court: courts[0].id, at: T2, kind: 'fixed' })).map(c => c.kind), ['order_violation'])
  await setSchedule(semis[1], { court: courts[0].id, queue: 1 })
  await assert.rejects(setSchedule(final, { court: courts[0].id, queue: 1 }), /schedule\.conflict/)
  await setSchedule(final, { court: courts[0].id, queue: 2, at: T3, kind: 'not_before', ignore: true })
})

test('finished and live matches cannot be moved; deleting matches removes their schedule', async () => {
  const { t, semis, courts } = await bracket()
  await setSchedule(semis[0], { court: courts[0].id, at: T1, kind: 'fixed' })
  await asActor(ctx, 'owner', "update tournaments set status='in_progress' where id=$1", [t.id])
  const live = (await asActor(ctx, 'counter', 'select (start_live_match($1,$2)).status s', [semis[0].id, semis[0].score_revision])).rows[0].s
  assert.equal(live, 'active')
  await assert.rejects(setSchedule(semis[0], { court: courts[1].id, at: T2, kind: 'fixed' }), /schedule\.conflict/)
  await ctx.db.query("update matches set status='finished' where id=$1", [semis[1].id])
  await assert.rejects(setSchedule(semis[1], { court: courts[1].id, at: T2, kind: 'fixed' }), /schedule\.conflict/)
  assert.equal((await rows(t)).length, 1)
  await asActor(ctx, 'owner', 'delete from matches where tournament_id=$1', [t.id])
  assert.equal((await rows(t)).length, 0)
})

test('drafts stay private; publishing copies them for everyone and reverting discards later edits', async () => {
  const { t, semis, final, courts } = await bracket()
  await setSchedule(semis[0], { court: courts[0].id, at: T1, kind: 'fixed' })
  await setSchedule(semis[1], { court: courts[1].id, at: T1, kind: 'fixed' })
  for (const actor of ['anon', 'outsider', 'counter']) {
    assert.deepEqual((await asActor(ctx, actor, 'select state from match_schedule where tournament_id=$1', [t.id])).rows, [])
    assert.deepEqual((await sync(t, actor)).schedule, [])
    assert.equal((await sync(t, actor)).courts.length, 2)
  }
  assert.equal((await sync(t, 'owner')).schedule.length, 2)
  for (const actor of ['anon', 'outsider', 'counter', 'platform_admin']) {
    await assertDeniedUnchanged(ctx, actor, 'select publish_schedule($1)', [t.id])
    await assertDeniedUnchanged(ctx, actor, 'select revert_schedule_draft($1)', [t.id])
  }
  assert.deepEqual((await asActor(ctx, 'editor', 'select publish_schedule($1) r', [t.id])).rows[0].r, { published: 2 })
  const publishedAt = (await ctx.db.query('select schedule_published_at from tournaments where id=$1', [t.id])).rows[0].schedule_published_at
  assert.ok(publishedAt)
  const anonSync = await sync(t, 'anon')
  assert.deepEqual(anonSync.schedule.map(s => s.state), ['published', 'published'])
  assert.equal(anonSync.tournament.schedule_published_at !== null, true)
  assert.ok(!('draft' in Object.fromEntries(anonSync.schedule.map(s => [s.state, true]))))
  // Edit the draft: the public still sees the published time until the next publish.
  await setSchedule(semis[0], { court: courts[0].id, at: T3, kind: 'fixed' })
  await setSchedule(final, { court: courts[0].id, queue: 1 })
  assert.equal(new Date((await sync(t, 'anon')).schedule.find(s => s.match_id === semis[0].id).scheduled_at).getTime(), new Date(T1).getTime())
  assert.equal((await sync(t, 'owner')).schedule.length, 5)
  assert.deepEqual((await asActor(ctx, 'owner', 'select revert_schedule_draft($1) r', [t.id])).rows[0].r, { restored: 2 })
  const drafts = await rows(t, 'draft'), published = await rows(t, 'published')
  assert.deepEqual(drafts.map(d => [d.match_id, d.court_id, d.scheduled_at?.toISOString?.() ?? d.scheduled_at, d.queue_order]),
    published.map(p => [p.match_id, p.court_id, p.scheduled_at?.toISOString?.() ?? p.scheduled_at, p.queue_order]))
  // Removing a court leaves its matches without a court but keeps the time.
  await saveCourts(t, [{ id: courts[1].id, name: 'Court 2' }])
  assert.deepEqual((await rows(t)).filter(r => r.match_id === semis[0].id).map(r => r.court_id), [null, null])
})

test('schedule settings are validated and the forward chain replays without data changes', async () => {
  const { t } = await bracket()
  for (const bad of [{ schedule_config: null }, { schedule_config: [] }, { schedule_config: { bogus: 1 } },
    { schedule_config: { min_rest_minutes: -5 } }, { schedule_config: { min_rest_minutes: 12.5 } }, { schedule_config: { min_rest_minutes: '30' } },
    { schedule_config: { timezone: 'not a zone!' } }, { schedule_config: { timezone: 42 } }]) {
    const before = await snapshot(ctx)
    await assert.rejects(settings(t, bad), /schedule\.invalidConfig/)
    assert.deepEqual(await snapshot(ctx), before)
  }
  await settings(t, { schedule_config: { min_rest_minutes: 45, timezone: 'Europe/Vilnius' } })
  assert.deepEqual((await sync(t, 'anon')).tournament.schedule_config, { min_rest_minutes: 45, timezone: 'Europe/Vilnius' })
  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
  const published = (await ctx.db.query("select relreplident from pg_class where relname in ('courts','match_schedule')")).rows.map(r => r.relreplident)
  assert.deepEqual(published, ['f', 'f'])
})
