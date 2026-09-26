import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])
const row = async id => (await ctx.db.query('select * from matches where id=$1', [id])).rows[0]
const drop = t => ctx.db.query('delete from tournaments where id=$1', [t.id])
const stage = async (t, name) => (await matches(ctx, t.id)).filter(m => m.stage === name)
const setStatus = (t, status) => ctx.db.query('update tournaments set status=$2 where id=$1', [t.id, status])
const sets = (side, [w, l] = [6, 0]) => [1, 2].map(i => ({ set_index: i, side_a_games: side === 'a' ? w : l, side_b_games: side === 'a' ? l : w }))
const saveSets = async (m, side, games) => asActor(ctx, 'owner',
  'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [m.id, JSON.stringify(sets(side, games))])
/** The entry with the better (lower) fixture index wins every group match. */
const favouriteSide = (t, m) => (t.entries.indexOf(m.side_a_entry_id) < t.entries.indexOf(m.side_b_entry_id) ? 'a' : 'b')
async function playGroups(t, games = () => [6, 0]) {
  for (const m of await stage(t, 'group')) await saveSets(m, favouriteSide(t, m), games(m))
}
const groupOf = async t => Object.fromEntries((await ctx.db.query(
  'select ge.entry_id, g.name from group_entries ge join groups g on g.id=ge.group_id where g.tournament_id=$1', [t.id])).rows.map(r => [r.entry_id, r.name]))
const preview = async t => (await asActor(ctx, 'owner', 'select get_group_playoff_preview($1) p', [t.id])).rows[0].p
async function correctionPreview(m, result, actor = 'owner') {
  const rev = (await row(m.id)).score_revision
  const p = (await asActor(ctx, actor, 'select get_match_correction_preview($1,$2,$3) p', [m.id, JSON.stringify(result), rev])).rows[0].p
  return { ...p, id: m.id, result, rev }
}
const applyCorrection = p => asActor(ctx, 'owner', 'select apply_match_correction($1,$2,$3,$4)', [p.id, JSON.stringify(p.result), p.rev, p.token])
async function finishStage(t, name) {
  for (let i = 0; i < 128; i++) {
    const m = (await stage(t, name)).find(x => x.status === 'ready')
    if (!m) return
    await saveSets(m, 'a')
  }
  throw new Error('stage did not finish')
}

test('B7: a password page with a valid token reads round-robin and group standings', async () => {
  for (const format of ['round_robin', 'groups_playoff']) {
    const t = await fixture(ctx, { status: 'registration_open', isPublic: true, format, count: 4 })
    await asActor(ctx, 'owner', 'select set_tournament_password($1,$2,$3)', [t.id, 'court-2026', await revision(t.id)])
    await settings(t, { visibility: 'password' })
    await asActor(ctx, 'owner', format === 'round_robin' ? 'select generate_round_robin($1)' : 'select generate_groups($1,2)', [t.id])
    const unlock = (await asActor(ctx, 'anon', 'select unlock_tournament($1,$2) r', [t.id, 'court-2026'])).rows[0].r
    assert.equal(unlock.ok, true)
    const s = (await asActor(ctx, 'anon', 'select get_tournament_sync_state_with_token($1,$2) s', [t.id, unlock.token])).rows[0].s
    if (format === 'round_robin') assert.equal(s.standings.length, 4)
    else assert.deepEqual(Object.values(s.group_standings).map(rows => rows.length), [2, 2])
    // The grant is scoped to the snapshot call: without a token standings stay closed.
    await assert.rejects(asActor(ctx, 'anon', 'select * from get_standings($1)', [t.id]), /Not allowed/)
    await assert.rejects(asActor(ctx, 'anon', 'select get_tournament_sync_state_with_token($1,$2) s', [t.id, 'wrong']), /access\.tokenExpired/)
    await drop(t)
  }
})

test('B6: a circular tie on points and sets is broken by game difference, not by name', async () => {
  const t = await fixture(ctx, { format: 'round_robin', count: 4, isPublic: true })
  const [anna, boris, cora, dan] = t.entries
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  const result = { [`${cora}:${anna}`]: [6, 0], [`${anna}:${boris}`]: [6, 4], [`${boris}:${cora}`]: [7, 5] }
  for (const m of await matches(ctx, t.id)) {
    const [a, b] = [m.side_a_entry_id, m.side_b_entry_id]
    let winner = [a, b].includes(dan) ? (a === dan ? b : a) : null
    let games = [6, 0]
    for (const [key, g] of Object.entries(result)) {
      const [w, l] = key.split(':')
      if ((a === w && b === l) || (a === l && b === w)) { winner = w; games = g }
    }
    await saveSets(m, winner === a ? 'a' : 'b', games)
  }
  const rows = (await asActor(ctx, 'anon', 'select * from get_standings($1)', [t.id])).rows
  assert.deepEqual(rows.map(r => r.entry_id), [cora, boris, anna, dan])
  assert.ok(rows.slice(0, 3).every(r => r.points === 2 && r.diff === 2))
  const internal = (await ctx.db.query('select entry_id, games_diff from standings_rows($1)', [t.id])).rows
  assert.deepEqual(internal.slice(0, 3).map(r => r.games_diff), [20, 12, 4])
  await drop(t)
})

test('B4: generators keep the results of a running or completed tournament', async () => {
  const rr = await fixture(ctx, { format: 'round_robin', count: 3 })
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [rr.id])
  // No result yet: a running tournament may still be regenerated.
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [rr.id])
  await saveSets((await matches(ctx, rr.id))[0], 'a')
  await assertDeniedUnchanged(ctx, 'owner', 'select generate_round_robin($1)', [rr.id], /groupsFlow\.regenerateLocked/)
  await setStatus(rr, 'completed')
  await assertDeniedUnchanged(ctx, 'editor', 'select generate_round_robin($1)', [rr.id], /groupsFlow\.regenerateLocked/)
  await setStatus(rr, 'registration_closed')
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [rr.id])
  assert.ok((await matches(ctx, rr.id)).every(m => m.status === 'ready'))

  const gp = await fixture(ctx, { format: 'groups_playoff', count: 4 })
  await asActor(ctx, 'owner', 'select generate_groups($1,2)', [gp.id])
  await playGroups(gp)
  await assertDeniedUnchanged(ctx, 'owner', 'select generate_groups($1,2)', [gp.id], /groupsFlow\.regenerateLocked/)
  await asActor(ctx, 'owner', 'select generate_group_playoff($1)', [gp.id])
  await finishStage(gp, 'winners')
  await assertDeniedUnchanged(ctx, 'owner', 'select generate_group_playoff($1)', [gp.id], /groupsFlow\.playoffStarted/)
  await setStatus(gp, 'completed')
  for (const sql of ['select generate_groups($1,2)', 'select generate_group_playoff($1)']) {
    await assertDeniedUnchanged(ctx, 'owner', sql, [gp.id], /groupsFlow\.regenerateLocked/)
  }
  // Permission is still checked first.
  await assertDeniedUnchanged(ctx, 'counter', 'select generate_group_playoff($1)', [gp.id])
  await drop(rr); await drop(gp)
})

test('B2: advance_per_group is stored by generate_groups and must fit the smallest group', async () => {
  const t = await fixture(ctx, { format: 'groups_playoff', count: 9, status: 'registration_closed' })
  await assertDeniedUnchanged(ctx, 'owner', 'select generate_groups($1,3,4)', [t.id], /groupsFlow\.invalidAdvance/)
  await assertDeniedUnchanged(ctx, 'owner', 'select generate_groups($1,3,0)', [t.id], /groupsFlow\.invalidAdvance/)
  await asActor(ctx, 'owner', 'select generate_groups($1,3,3)', [t.id])
  assert.equal((await ctx.db.query('select format_config from tournaments where id=$1', [t.id])).rows[0].format_config.advance_per_group, 3)
  // Four groups of two cannot send three each; the stored value is validated too.
  await assertDeniedUnchanged(ctx, 'owner', 'select generate_groups($1,4)', [t.id], /groupsFlow\.invalidAdvance/)
  await drop(t)
})

test('B2: with three groups the BYEs go to the strongest winners and no group meets itself in round one', async () => {
  const t = await fixture(ctx, { format: 'groups_playoff', count: 9 })
  await asActor(ctx, 'owner', 'select generate_groups($1,3,2)', [t.id])
  const groups = await groupOf(t)
  // Group C's winner wins 6:0 6:0, the others 6:4 6:4: C1 is the strongest winner.
  await playGroups(t, m => (groups[m.side_a_entry_id] === 'C' ? [6, 0] : [6, 4]))
  const p = await preview(t)
  assert.equal(p.bracket_size, 8); assert.equal(p.qualifiers, 6)
  // Runners-up all have a zero game difference, so group order decides among them.
  const seeds = p.pairs.flatMap(x => [x.a, x.b]).filter(Boolean).sort((a, b) => a.seed - b.seed)
  assert.deepEqual(seeds.map(s => `${s.group_name}${s.group_rank}`), ['C1', 'A1', 'B1', 'A2', 'B2', 'C2'])
  const byes = p.pairs.filter(x => !x.a || !x.b).map(x => (x.a || x.b))
  assert.deepEqual(byes.map(s => s.seed).sort(), [1, 2])
  assert.deepEqual(byes.map(s => s.group_rank), [1, 1])
  await asActor(ctx, 'owner', 'select generate_group_playoff($1)', [t.id])
  const first = (await stage(t, 'winners')).filter(m => m.round_number === 1).sort((a, b) => a.match_number - b.match_number)
  assert.deepEqual(first.map(m => [m.side_a_entry_id, m.side_b_entry_id]), p.pairs.map(x => [x.a?.entry_id ?? null, x.b?.entry_id ?? null]))
  for (const m of first) if (m.side_a_entry_id && m.side_b_entry_id) assert.notEqual(groups[m.side_a_entry_id], groups[m.side_b_entry_id])
  await drop(t)
})

test('B2: every groups × advance combination seeds by place, gives BYEs to top seeds and avoids same-group openers', async () => {
  for (let g = 2; g <= 5; g++) {
    for (let advance = 1; advance <= 3; advance++) {
      const label = `${g} groups, ${advance} advance`
      const t = await fixture(ctx, { format: 'groups_playoff', count: g * (advance + 1), sport: 'tennis' })
      await asActor(ctx, 'owner', 'select generate_groups($1,$2,$3)', [t.id, g, advance])
      await playGroups(t)
      const groups = await groupOf(t)
      const p = await preview(t)
      const seeded = p.pairs.flatMap(x => [x.a, x.b]).filter(Boolean)
      assert.equal(seeded.length, g * advance, label)
      const bySeed = [...seeded].sort((a, b) => a.seed - b.seed)
      assert.deepEqual(bySeed.map(s => s.group_rank), [...bySeed.map(s => s.group_rank)].sort((a, b) => a - b), `${label}: place order`)
      const byes = p.pairs.filter(x => !x.a || !x.b).map(x => x.a || x.b)
      assert.deepEqual(byes.map(s => s.seed).sort((a, b) => a - b), byes.map((_, i) => i + 1), `${label}: BYEs to top seeds`)
      for (const x of p.pairs) if (x.a && x.b && advance > 1) assert.notEqual(groups[x.a.entry_id], groups[x.b.entry_id], `${label}: same group`)
      await asActor(ctx, 'owner', 'select generate_group_playoff($1)', [t.id])
      await finishStage(t, 'winners')
      const final = (await stage(t, 'winners')).find(m => !m.next_match_id)
      assert.ok(final.winner_entry_id, `${label}: champion`)
      await drop(t)
    }
  }
})

async function playedPlayoff() {
  const t = await fixture(ctx, { format: 'groups_playoff', count: 8, isPublic: true })
  await asActor(ctx, 'owner', 'select generate_groups($1,2,2)', [t.id])
  await playGroups(t)
  await asActor(ctx, 'owner', 'select generate_group_playoff($1)', [t.id])
  const courts = (await asActor(ctx, 'owner', 'select save_courts($1,$2,$3) c', [t.id, JSON.stringify([{ name: 'Court 1' }]), await revision(t.id)])).rows[0].c
  const semis = (await stage(t, 'winners')).filter(m => m.round_number === 1).sort((a, b) => a.match_number - b.match_number)
  await asActor(ctx, 'owner', 'select set_match_schedule($1,$2,$3,$4,$5,$6)', [semis[1].id, courts[0].id, '2026-10-01T10:00:00.000Z', 'fixed', null, true])
  await asActor(ctx, 'owner', 'select publish_schedule($1)', [t.id])
  await saveSets(semis[0], 'a')
  return { t, semis }
}
const scheduleByPosition = async t => (await ctx.db.query(`select m.round_number, m.match_number, s.state, s.court_id, s.scheduled_at
  from match_schedule s join matches m on m.id=s.match_id where m.tournament_id=$1 order by 1,2,3`, [t.id])).rows

test('B3: a group correction that keeps the qualifiers and their places leaves the playoff untouched', async () => {
  const { t } = await playedPlayoff()
  const playoff = await stage(t, 'winners')
  const schedule = await scheduleByPosition(t)
  // Group A is fixture entries 0, 3, 4, 7: reverse 4 vs 7, a match between non-qualifiers.
  const m = (await stage(t, 'group')).find(x => [x.side_a_entry_id, x.side_b_entry_id].sort().join() === [t.entries[4], t.entries[7]].sort().join())
  const p = await correctionPreview(m, { sets: sets(favouriteSide(t, m) === 'a' ? 'b' : 'a') })
  assert.equal(p.group_stage, true); assert.equal(p.reseed_playoff, false)
  assert.deepEqual(p.matches, []); assert.equal(p.blocked_live, false)
  await applyCorrection(p)
  assert.notEqual((await row(m.id)).winner_entry_id, m.winner_entry_id)
  assert.deepEqual(await stage(t, 'winners'), playoff)
  assert.deepEqual(await scheduleByPosition(t), schedule)
  await drop(t)
})

test('B3: a correction that changes the qualifiers rebuilds the playoff, reports and keeps its schedule slots', async () => {
  const { t } = await playedPlayoff()
  const oldIds = (await stage(t, 'winners')).map(m => m.id)
  const schedule = await scheduleByPosition(t)
  // Reverse the match between group A's first and second place.
  const m = (await stage(t, 'group')).find(x => [x.side_a_entry_id, x.side_b_entry_id].sort().join() === [t.entries[0], t.entries[3]].sort().join())
  const before = await snapshot(ctx)
  const p = await correctionPreview(m, { sets: sets(favouriteSide(t, m) === 'a' ? 'b' : 'a') })
  assert.deepEqual(await snapshot(ctx), before, 'the dry run is rolled back')
  assert.equal(p.reseed_playoff, true)
  assert.equal(p.matches.length, oldIds.length)
  assert.ok(p.matches.some(x => x.has_result))
  assert.equal(p.schedule_matches, 1); assert.equal(p.schedule_published, 1)
  await applyCorrection(p)
  const rebuilt = await stage(t, 'winners')
  assert.ok(rebuilt.every(x => !oldIds.includes(x.id)))
  assert.ok(rebuilt.every(x => x.status !== 'finished' || !x.side_a_entry_id || !x.side_b_entry_id))
  assert.deepEqual(await scheduleByPosition(t), schedule)
  const winnerA = (await ctx.db.query('select entry_id from standings_rows($1,$2) where rank=1', [t.id, m.group_id])).rows[0].entry_id
  assert.equal(winnerA, t.entries[3])
  assert.ok(rebuilt.filter(x => x.round_number === 1).some(x => [x.side_a_entry_id, x.side_b_entry_id].includes(winnerA)))
  await drop(t)
})

test('B1: the playoff preview requires finished groups and is reserved to organizers', async () => {
  const t = await fixture(ctx, { format: 'groups_playoff', count: 4 })
  await asActor(ctx, 'owner', 'select generate_groups($1,2)', [t.id])
  await assert.rejects(preview(t), /All group matches must be finished first/)
  await playGroups(t)
  for (const actor of ['counter', 'outsider', 'anon']) {
    await assert.rejects(asActor(ctx, actor, 'select get_group_playoff_preview($1)', [t.id]), /Not allowed|permission denied/)
  }
  const p = await preview(t)
  assert.equal(p.pairs.length, 2)
  assert.ok(p.pairs.every(x => x.a.group_name !== x.b.group_name))
  await drop(t)
})

test('internal stream B helpers are not callable by API roles', async () => {
  const t = await fixture(ctx, { format: 'groups_playoff', count: 4 })
  for (const actor of ['owner', 'anon']) {
    for (const sql of ['select * from standings_rows($1)', 'select group_playoff_slots($1)', 'select build_group_playoff($1)',
      'select tournament_has_results($1)', 'select assert_structure_regenerable($1)']) {
      await assert.rejects(asActor(ctx, actor, sql, [t.id]), /permission denied/, `${actor}: ${sql}`)
    }
  }
  await drop(t)
})

test('the stream B migration replays cleanly over itself', async () => {
  const { t } = await playedPlayoff()
  const snap = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), snap)
  await drop(t)
})
