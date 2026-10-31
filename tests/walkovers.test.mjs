import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, assertDeniedUnchanged, winningSets, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const rules = async (config = {}) => (await ctx.db.query('select tennis_scoring_rules($1) r', [JSON.stringify(config)])).rows[0].r
const complete = async (config, played, winner = 'a', required = 2) =>
  (await ctx.db.query('select special_result_sets($1,$2,$3,$4) s', [await rules(config), required, JSON.stringify(played), winner])).rows[0].s
const set = (i, a, b, ta, tb) => ({ set_index: i, side_a_games: a, side_b_games: b, ...(ta == null ? {} : { side_a_tiebreak: ta, side_b_tiebreak: tb }) })
const special = (actor, m, type, winner, sets = null) => asActor(ctx, actor,
  'select record_special_result($1,$2,$3,$4,(select score_revision from matches where id=$1)) r', [m.id, type, winner, sets && JSON.stringify(sets)])
const withdraw = (actor, entry, on = true) => asActor(ctx, actor, 'select set_entry_withdrawn($1,$2) n', [entry, on]).then(r => r.rows[0].n)
const sets = async m => (await ctx.db.query('select set_index,side_a_games,side_b_games,side_a_tiebreak,side_b_tiebreak from match_sets where match_id=$1 order by set_index', [m.id])).rows
const games = rows => rows.map(s => `${s.side_a_games}:${s.side_b_games}${s.side_a_tiebreak == null ? '' : `(${s.side_a_tiebreak}:${s.side_b_tiebreak})`}`).join(' ')
const fresh = async m => (await ctx.db.query('select * from matches where id=$1', [m.id])).rows[0]
async function started(opts) {
  const t = await fixture(ctx, { status: 'registration_closed', ...opts })
  if ((opts.format || 'single_elimination') === 'round_robin') await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  else await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  return t
}
const round = async (t, n, stage = 'main') => (await matches(ctx, t.id)).filter(m => m.stage === stage && m.round_number === n)
  .sort((a, b) => a.match_number - b.match_number)

test('W.O. and RET sets follow the set rules (ITF: the rest goes to the winner)', async () => {
  assert.equal(games(await complete({}, [])), '6:0 6:0')
  assert.equal(games(await complete({}, [], 'b', 3)), '0:6 0:6 0:6')
  assert.equal(games(await complete({ tennis: { set_rule: 'short' } }, [])), '4:0 4:0')
  assert.equal(games(await complete({}, [set(1, 6, 3), set(2, 2, 1)])), '6:3 6:1')
  assert.equal(games(await complete({}, [set(1, 6, 3), set(2, 2, 4)])), '6:3 6:4')
  assert.equal(games(await complete({}, [set(1, 6, 3), set(2, 3, 5)])), '6:3 7:5')
  assert.equal(games(await complete({}, [set(1, 6, 3), set(2, 5, 6)])), '6:3 7:6(7:0)')
  assert.equal(games(await complete({}, [set(1, 6, 3), set(2, 6, 6, 3, 5)])), '6:3 7:6(7:5)')
  assert.equal(games(await complete({}, [set(1, 3, 6)])), '3:6 6:0 6:0')
  // Deciding match tie-break to 10.
  const mtb = { tennis: { final_set_rule: 'match_tiebreak_10' } }
  assert.equal(games(await complete(mtb, [set(1, 6, 3), set(2, 2, 6), set(3, 0, 0, 5, 7)])), '6:3 2:6 0:0(10:7)')
  assert.equal(games(await complete(mtb, [set(1, 3, 6), set(2, 6, 2)], 'b')), '3:6 6:2 0:0(0:10)')
  // Played sets must be reachable and only the last one may be open.
  await assert.rejects(complete({}, [set(1, 2, 1), set(2, 6, 0)]), /walkover\.invalidSets/)
  await assert.rejects(complete({}, [set(1, 9, 1)]), /walkover\.invalidSets/)
  await assert.rejects(complete({}, [set(1, 0, 6), set(2, 0, 6), set(3, 1, 1)]), /walkover\.invalidSets/)
})

test('a walkover finishes the match, advances the winner and is labelled; counters may record it', async () => {
  const t = await started({ count: 4 })
  const [m1, m2] = await round(t, 1)
  await special('counter', m1, 'walkover', m1.side_b_entry_id)
  const done = await fresh(m1)
  assert.equal(done.status, 'finished')
  assert.equal(done.result_type, 'walkover')
  assert.equal(done.winner_entry_id, m1.side_b_entry_id)
  assert.deepEqual([done.side_a_score, done.side_b_score], [0, 2])
  assert.equal(games(await sets(m1)), '0:6 0:6')
  const [final] = await round(t, 2)
  assert.ok([final.side_a_entry_id, final.side_b_entry_id].includes(m1.side_b_entry_id))

  await assert.rejects(special('owner', m1, 'walkover', m1.side_a_entry_id), /walkover\.finished/)
  // The winner must be one of the two sides.
  await assert.rejects(special('owner', m2, 'walkover', m1.side_a_entry_id), /walkover\.invalidWinner/)
  for (const actor of ['outsider', 'anon']) {
    await assertDeniedUnchanged(ctx, actor, 'select record_special_result($1,$2,$3,null,(select score_revision from matches where id=$1))', [m2.id, 'walkover', m2.side_a_entry_id])
  }
  await assert.rejects(asActor(ctx, 'owner', 'select record_special_result($1,$2,$3,null,0)', [m2.id, 'walkover', m2.side_a_entry_id]), /scoringFlow\.conflict/)

  // The snapshot shows the label to everyone.
  const state = (await asActor(ctx, 'owner', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.equal(state.matches.find(m => m.id === m1.id).result_type, 'walkover')
})

test('a retirement keeps the stored sets (live scoring) and stops the live session', async () => {
  const t = await started({ count: 2 })
  const [m] = await round(t, 1)
  await ctx.db.query(`insert into match_sets(match_id,set_index,side_a_games,side_b_games,score_kind) values ($1,1,6,4,'set'),($1,2,1,3,'set')`, [m.id])
  await ctx.db.query(`insert into live_scores(match_id,tournament_id,state,history,status,revision) values ($1,$2,'{}','[]','active',1)`, [m.id, t.id])
  await special('owner', m, 'retired', m.side_b_entry_id)
  assert.equal(games(await sets(m)), '6:4 1:6 0:6')
  const done = await fresh(m)
  assert.deepEqual([done.result_type, done.winner_entry_id, done.side_a_score, done.side_b_score], ['retired', m.side_b_entry_id, 1, 2])
  assert.notEqual((await ctx.db.query('select status from live_scores where match_id=$1', [m.id])).rows[0].status, 'active')
})

test('an ordinary write clears the label: reset, new sets', async () => {
  const t = await started({ count: 4 })
  const [m1, m2] = await round(t, 1)
  await special('owner', m1, 'walkover', m1.side_a_entry_id)
  await special('owner', m2, 'walkover', m2.side_a_entry_id)
  await ctx.db.query("update match_sets set side_b_games=1 where match_id=$1 and set_index=1", [m1.id])
  assert.equal((await fresh(m1)).result_type, null)
  await ctx.db.query("update matches set winner_entry_id=null, status='ready' where id=$1", [m2.id])
  assert.equal((await fresh(m2)).result_type, null)
})

test('football walkover is 3:0; a retirement is refused; points formats are refused', async () => {
  const t = await started({ count: 2, sport: 'football' })
  const [m] = await round(t, 1)
  await assert.rejects(special('owner', m, 'retired', m.side_a_entry_id), /walkover\.footballRetired/)
  await special('owner', m, 'walkover', m.side_a_entry_id)
  const done = await fresh(m)
  assert.deepEqual([done.side_a_score, done.side_b_score, done.result_type], [3, 0, 'walkover'])
})

test('withdrawing in round robin: unplayed matches become walkovers, played ones stay', async () => {
  const t = await started({ count: 4, format: 'round_robin' })
  const [x] = t.entries
  const all = await matches(ctx, t.id)
  const mine = all.filter(m => [m.side_a_entry_id, m.side_b_entry_id].includes(x))
  assert.equal(mine.length, 3)
  await asActor(ctx, 'owner', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [mine[0].id, winningSets])
  await assertDeniedUnchanged(ctx, 'counter', 'select set_entry_withdrawn($1,true)', [x])
  assert.equal(await withdraw('editor', x), 2)
  const after = await Promise.all(mine.map(fresh))
  assert.equal(after[0].result_type, null)
  for (const m of after.slice(1)) {
    assert.equal(m.result_type, 'walkover')
    assert.notEqual(m.winner_entry_id, x)
  }
  const state = (await asActor(ctx, 'owner', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.ok(state.entries.find(e => e.id === x).withdrawn_at)
  const row = state.standings.find(s => s.entry_id === x)
  assert.deepEqual([row.played, row.won, row.lost], [3, 1, 2])
  // Taking it back keeps the walkovers.
  assert.equal(await withdraw('owner', x, false), 0)
  assert.equal((await ctx.db.query('select withdrawn_at from entries where id=$1', [x])).rows[0].withdrawn_at, null)
  assert.equal((await fresh(mine[1])).result_type, 'walkover')
})

test('knockout: a withdrawn player waiting in the next round loses it by walkover when the opponent arrives', async () => {
  const t = await started({ count: 4 })
  const [m1, m2] = await round(t, 1)
  await asActor(ctx, 'owner', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [m1.id, winningSets])
  const waiting = m1.side_a_entry_id
  assert.equal(await withdraw('owner', waiting), 0)
  await asActor(ctx, 'counter', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [m2.id, winningSets])
  const [final] = await round(t, 2)
  assert.equal(final.result_type, 'walkover')
  assert.equal(final.winner_entry_id, m2.side_a_entry_id)
  assert.equal(final.status, 'finished')
})

test('withdrawing in knockout: the current match is a walkover; double elimination drops through the losers bracket', async () => {
  const t = await started({ count: 4 })
  const [m1] = await round(t, 1)
  assert.equal(await withdraw('owner', m1.side_b_entry_id), 1)
  assert.equal((await fresh(m1)).winner_entry_id, m1.side_a_entry_id)

  const de = await started({ count: 4, format: 'double_elimination' })
  const [d1, d2] = await round(de, 1, 'winners')
  const gone = d1.side_b_entry_id
  assert.equal(await withdraw('owner', gone), 1)
  await asActor(ctx, 'owner', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [d2.id, winningSets])
  const losers = (await matches(ctx, de.id)).filter(m => m.stage === 'losers' && [m.side_a_entry_id, m.side_b_entry_id].includes(gone))
  assert.ok(losers.length >= 1)
  for (const m of losers) {
    assert.equal(m.result_type, 'walkover')
    assert.notEqual(m.winner_entry_id, gone)
  }
})

test('withdrawal rules: started tournaments only, live match first, fixed-field padel formats replace instead', async () => {
  const before = await fixture(ctx, { status: 'registration_open' })
  await assert.rejects(withdraw('owner', before.entries[0]), /walkover\.notStarted/)

  const t = await started({ count: 2 })
  const [m] = await round(t, 1)
  await ctx.db.query(`insert into live_scores(match_id,tournament_id,state,history,status,revision) values ($1,$2,'{}','[]','active',1)`, [m.id, t.id])
  await assert.rejects(withdraw('owner', m.side_a_entry_id), /walkover\.liveMatch/)

  const am = await fixture(ctx, { format: 'americano', count: 8, sport: 'padel', category: 'doubles', status: 'registration_closed' })
  await asActor(ctx, 'owner', 'select generate_points_format($1,null,null,null)', [am.id])
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [am.id])
  await assert.rejects(withdraw('owner', am.entries[0]), /walkover\.replaceInstead/)
  const [pm] = await matches(ctx, am.id)
  await assert.rejects(special('owner', pm, 'walkover', pm.side_a_entry_id), /walkover\.pointsFormat/)
})

test('mexicano: a withdrawn player sits out the next rounds and earns no rest points after leaving', async () => {
  const t = await fixture(ctx, { format: 'mexicano', count: 8, sport: 'padel', category: 'doubles', status: 'registration_closed' })
  await asActor(ctx, 'owner', "select generate_points_format($1,null,null,'seeded')", [t.id])
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  const score = (m, a, b) => asActor(ctx, 'owner', 'select update_match_points($1,$2,$3,(select score_revision from matches where id=$1))', [m.id, a, b])
  for (const m of await matches(ctx, t.id)) await score(m, 13, 11)
  const gone = t.entries[0]
  await withdraw('owner', gone)
  await ctx.db.query("update matches set created_at = now() - interval '1 hour' where tournament_id=$1", [t.id])
  await asActor(ctx, 'owner', 'select generate_next_round($1)', [t.id])
  const r2 = (await matches(ctx, t.id)).filter(m => m.round_number === 2)
  assert.equal(r2.length, 1, '7 players fill one court')
  assert.ok(!r2.flatMap(m => [m.side_a_entry_id, m.side_a2_entry_id, m.side_b_entry_id, m.side_b2_entry_id]).includes(gone))
  for (const m of r2) await score(m, 13, 11)
  const rows = (await asActor(ctx, 'owner', 'select * from get_points_standings($1)', [t.id])).rows
  const row = rows.find(r => r.entry_id === gone)
  assert.equal(row.rests, 0)
  assert.equal(rows.filter(r => r.rests === 1).length, 3, 'the three who sat out without leaving get rest points')
  await reapplyForwardMigrations(ctx)
})
