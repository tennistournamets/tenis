import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])
const drop = t => ctx.db.query('delete from tournaments where id=$1', [t.id])
const padel = (format, count, extra = {}) => fixture(ctx, { format, count, sport: 'padel', category: 'doubles', status: 'registration_closed', isPublic: true, ...extra })
const generate = (t, rounds = null, courts = null, firstRound = null) =>
  asActor(ctx, 'owner', 'select generate_points_format($1,$2,$3,$4) r', [t.id, rounds, courts, firstRound]).then(r => r.rows[0].r)
// Americano default: the full partner cycle, floor(n(n-1)/2 / (2 * courts)) rounds.
const fullCycle = (n, courts = Math.floor(n / 4)) => Math.floor((n * (n - 1)) / 2 / (2 * courts))
const start = t => settings(t, { status: 'in_progress' })
const tournament = async t => (await ctx.db.query('select * from tournaments where id=$1', [t.id])).rows[0]
const score = (m, a, b, actor = 'owner') =>
  asActor(ctx, actor, 'select update_match_points($1,$2,$3,(select score_revision from matches where id=$1))', [m.id, a, b])
const standings = async t => (await asActor(ctx, 'anon', 'select * from get_points_standings($1) order by rank', [t.id])).rows
const players = m => [m.side_a_entry_id, m.side_a2_entry_id, m.side_b_entry_id, m.side_b2_entry_id]
const key = (x, y) => [x, y].sort().join(':')
const byRound = ms => ms.reduce((acc, m) => ((acc[m.round_number] ??= []).push(m), acc), {})
async function playRound(t, round, fn = () => [13, 11]) {
  for (const m of (await matches(ctx, t.id)).filter(x => x.round_number === round)) await score(m, ...fn(m))
}

test('americano with 8 players: 7 rounds on 2 courts, every player partners every other exactly once', async () => {
  const t = await padel('americano', 8)
  assert.equal((await tournament(t)).doubles_pairing_mode, 'pick_random')
  assert.equal((await tournament(t)).scoring_config.points_per_match, 24)
  assert.equal(await generate(t), 7)
  const ms = await matches(ctx, t.id)
  assert.equal(ms.length, 14)
  const partners = new Map()
  for (const [round, list] of Object.entries(byRound(ms))) {
    assert.equal(list.length, 2, `round ${round}`)
    assert.equal(new Set(list.flatMap(players)).size, 8, `everyone plays in round ${round}`)
    for (const m of list) for (const k of [key(m.side_a_entry_id, m.side_a2_entry_id), key(m.side_b_entry_id, m.side_b2_entry_id)]) partners.set(k, (partners.get(k) || 0) + 1)
  }
  assert.equal(partners.size, 28)
  assert.ok([...partners.values()].every(n => n === 1))
  // A whist design: every player faces every other exactly twice.
  const opponents = new Map()
  for (const m of ms) for (const x of [m.side_a_entry_id, m.side_a2_entry_id]) for (const y of [m.side_b_entry_id, m.side_b2_entry_id]) opponents.set(key(x, y), (opponents.get(key(x, y)) || 0) + 1)
  assert.equal(opponents.size, 28)
  assert.ok([...opponents.values()].every(n => n === 2))
  const cfg = (await tournament(t)).format_config
  assert.deepEqual([...cfg.roster].sort(), [...t.entries].sort())
  assert.equal(cfg.courts, 2)
  assert.equal(cfg.rounds, 7)
  await drop(t)
})

test('americano with 9 and 10 players: within one circle cycle rests rotate fairly and partners never repeat', async () => {
  for (const n of [9, 10]) {
    const t = await padel('americano', n)
    assert.equal(await generate(t, 9), 9)
    const ms = await matches(ctx, t.id)
    const rests = Object.fromEntries(t.entries.map(e => [e, 0]))
    const partners = new Set()
    for (const list of Object.values(byRound(ms))) {
      assert.equal(list.length, 2)
      const playing = new Set(list.flatMap(players))
      assert.equal(playing.size, 8)
      for (const e of t.entries) if (!playing.has(e)) rests[e]++
      for (const m of list) for (const k of [key(m.side_a_entry_id, m.side_a2_entry_id), key(m.side_b_entry_id, m.side_b2_entry_id)]) {
        assert.ok(!partners.has(k), `repeated partners with ${n} players`)
        partners.add(k)
      }
    }
    const counts = Object.values(rests)
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `rests ${counts} with ${n} players`)
    await drop(t)
  }
})

test('americano for every field from 4 to 20 players, all courts or one: rests stay within one', async () => {
  for (let n = 4; n <= 20; n++) for (const courts of [null, 1]) {
    const t = await padel('americano', n)
    const rounds = await generate(t, null, courts)
    assert.equal(rounds, fullCycle(n, courts ?? Math.floor(n / 4)))
    const rests = Object.fromEntries(t.entries.map(e => [e, 0]))
    for (const list of Object.values(byRound(await matches(ctx, t.id)))) {
      const playing = new Set(list.flatMap(players))
      assert.equal(playing.size, 4 * list.length)
      for (const e of t.entries) if (!playing.has(e)) rests[e]++
    }
    const counts = Object.values(rests)
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `n=${n} courts=${courts}: ${counts}`)
    await drop(t)
  }
})

test('americano plays a full partner cycle by default: nearly every pair partners, rests stay within one', async () => {
  for (const [n, courts] of [[6, 1], [10, 2], [13, 2], [14, 3]]) {
    const t = await padel('americano', n)
    assert.equal(await generate(t, null, courts), fullCycle(n, courts))
    const ms = await matches(ctx, t.id)
    const partners = new Set(ms.flatMap(m => [key(m.side_a_entry_id, m.side_a2_entry_id), key(m.side_b_entry_id, m.side_b2_entry_id)]))
    const pairs = (n * (n - 1)) / 2
    assert.ok(partners.size >= 0.85 * pairs, `n=${n}: ${partners.size} of ${pairs} pairs partnered`)
    const counts = t.entries.map(e => ms.filter(m => players(m).includes(e)).length)
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `n=${n}: matches ${counts}`)
    await drop(t)
  }
})

test('americano rounds and courts are validated; fewer courts means more rests', async () => {
  const t = await padel('americano', 8)
  await assert.rejects(generate(t, 0), /pointsFormat\.invalidRounds/)
  await assert.rejects(generate(t, 22), /pointsFormat\.invalidRounds/)
  await assert.rejects(generate(t, null, 3), /pointsFormat\.invalidCourts/)
  assert.equal(await generate(t, 14, 1), 14)
  const ms = await matches(ctx, t.id)
  assert.equal(ms.length, 14)
  assert.ok(ms.every(m => m.match_number === 1))
  await drop(t)
  const few = await padel('americano', 3)
  await assert.rejects(generate(few), /pointsFormat\.minPlayers/)
  await drop(few)
})

test('points scoring: the total must equal N, draws are allowed, sets are refused, standings sum player points', async () => {
  const t = await padel('americano', 4, { scoringConfig: { points_per_match: 16 } })
  await generate(t)
  const [m] = await matches(ctx, t.id)
  await assert.rejects(score(m, 9, 7), /Scores can be entered only after the tournament starts/)
  await start(t)
  await assert.rejects(score(m, 9, 8), /pointsFormat\.invalidScore/)
  await assert.rejects(score(m, 9, 7, 'outsider'), /Not allowed/)
  await assert.rejects(asActor(ctx, 'owner', `select update_match_sets($1,'[{"set_index":1,"side_a_games":6,"side_b_games":0},{"set_index":2,"side_a_games":6,"side_b_games":0}]'::jsonb,(select score_revision from matches where id=$1))`, [m.id]), /pointsFormat\.pointsOnly|Invalid set/)
  await score(m, 10, 6)
  let row = (await matches(ctx, t.id)).find(x => x.id === m.id)
  assert.equal(row.status, 'finished')
  assert.equal(row.winner_entry_id, m.side_a_entry_id)
  const s = await standings(t)
  const of = id => s.find(r => r.entry_id === id)
  assert.equal(of(m.side_a_entry_id).total, 10)
  assert.equal(of(m.side_a2_entry_id).total, 10)
  assert.equal(of(m.side_b_entry_id).total, 6)
  assert.equal(of(m.side_a_entry_id).won, 1)
  // A correction replaces the result; an even total may end level.
  await score(m, 8, 8)
  row = (await matches(ctx, t.id)).find(x => x.id === m.id)
  assert.equal(row.winner_entry_id, null)
  assert.equal((await standings(t)).find(r => r.entry_id === m.side_b_entry_id).drawn, 1)
  await assert.rejects(settings(t, { scoring_config: { points_per_match: 20 } }), /locked/)
  await drop(t)
})

test('a completed round of rest earns half a match: floor(N / 2), from the first round on', async () => {
  const t = await padel('americano', 5)
  assert.equal(await generate(t), 5)
  await start(t)
  // Round 1: winners score 15, losers 9 (N = 24).
  await playRound(t, 1, () => [15, 9])
  const [m] = (await matches(ctx, t.id)).filter(x => x.round_number === 1)
  const rester = t.entries.find(e => !players(m).includes(e))
  let s = await standings(t)
  assert.equal(s.find(r => r.entry_id === rester).rests, 1)
  assert.equal(s.find(r => r.entry_id === rester).compensation, 12, 'half of 24 before any match of their own')
  const round2 = (await matches(ctx, t.id)).find(x => x.round_number === 2)
  const onA = [round2.side_a_entry_id, round2.side_a2_entry_id].includes(rester)
  await score(round2, onA ? 14 : 10, onA ? 10 : 14)
  s = await standings(t)
  const r = s.find(x => x.entry_id === rester)
  assert.equal(r.points_for, 14)
  assert.equal(r.compensation, 12)
  assert.equal(r.total, 26)
  await drop(t)
  // An odd N rounds the half down.
  const odd = await padel('americano', 5, { scoringConfig: { points_per_match: 21 } })
  await generate(odd)
  await start(odd)
  await playRound(odd, 1, () => [11, 10])
  assert.deepEqual((await standings(odd)).filter(x => x.rests).map(x => x.compensation), [10])
  await drop(odd)
})

test('ties on points go to wins, then draws, then the point difference', async () => {
  const t = await padel('americano', 8)
  const [p1, p2, p3, p4, p5, p6, p7, p8] = t.entries
  // p5 is seeded first: only the draws rule can put p1 above it.
  await ctx.db.query('update entries set seed_order = null where tournament_id = $1', [t.id])
  await ctx.db.query('update entries set seed_order = 1 where id = $1', [p5])
  await ctx.db.query('update entries set seed_order = 2 where id = $1', [p1])
  const add = (round, court, [a, a2, b, b2], sa, sb) => ctx.db.query(
    `insert into matches(tournament_id,stage,round_number,match_number,side_a_entry_id,side_a2_entry_id,side_b_entry_id,side_b2_entry_id,side_a_score,side_b_score,status)
     values ($1,'main',$2,$3,$4,$5,$6,$7,$8,$9,'finished')`, [t.id, round, court, a, a2, b, b2, sa, sb])
  await add(1, 1, [p1, p2, p3, p4], 12, 12)
  await add(1, 2, [p5, p6, p7, p8], 16, 8)
  await add(2, 1, [p1, p7, p5, p8], 14, 10)
  await add(2, 2, [p2, p3, p4, p6], 12, 12)
  const s = await standings(t)
  const row = id => s.find(r => r.entry_id === id)
  // Both 26 points, one win, difference +4; p1 has a draw.
  assert.deepEqual([row(p1).total, row(p1).won, row(p1).diff, row(p1).drawn], [26, 1, 4, 1])
  assert.deepEqual([row(p5).total, row(p5).won, row(p5).diff, row(p5).drawn], [26, 1, 4, 0])
  assert.ok(row(p1).rank < row(p5).rank)
  await drop(t)
})

test('mexicano and king of the court: round 1 is a random draw unless the seeding is asked for', async () => {
  for (const format of ['mexicano', 'king_of_court']) {
    const t = await padel(format, 8)
    await assert.rejects(generate(t, null, null, 'rating'), /pointsFormat\.invalidFirstRound/)
    let shuffled = false
    for (let attempt = 0; attempt < 10 && !shuffled; attempt++) {
      await generate(t)
      const ms = await matches(ctx, t.id)
      shuffled = JSON.stringify(ms.flatMap(players)) !== JSON.stringify([0, 3, 1, 2, 4, 7, 5, 6].map(i => t.entries[i]))
    }
    assert.ok(shuffled, `${format}: round 1 never left the seeding`)
    assert.equal((await tournament(t)).format_config.first_round, 'random')
    await generate(t, null, null, 'seeded')
    assert.equal((await tournament(t)).format_config.first_round, 'seeded')
    await drop(t)
  }
})

test('mexicano: round 1 by seed (1+4 v 2+3), the next round follows the table, later rounds lock earlier results', async () => {
  const t = await padel('mexicano', 8)
  assert.equal(await generate(t, null, null, 'seeded'), 1)
  let ms = await matches(ctx, t.id)
  assert.equal(ms.length, 2)
  const [c1, c2] = ms
  assert.deepEqual(players(c1), [t.entries[0], t.entries[3], t.entries[1], t.entries[2]])
  assert.deepEqual(players(c2), [t.entries[4], t.entries[7], t.entries[5], t.entries[6]])
  await start(t)
  await assert.rejects(asActor(ctx, 'owner', 'select generate_next_round($1)', [t.id]), /pointsFormat\.roundUnfinished/)
  // Court 2 side B wins big: its two players top the table.
  await score(c1, 13, 11)
  await score(c2, 2, 22)
  assert.equal((await asActor(ctx, 'owner', 'select generate_next_round($1) r', [t.id])).rows[0].r, 2)
  const ranked = (await standings(t)).map(r => r.entry_id)
  const next = (await matches(ctx, t.id)).filter(m => m.round_number === 2)
  assert.deepEqual(players(next[0]), [ranked[0], ranked[3], ranked[1], ranked[2]])
  assert.deepEqual(players(next[1]), [ranked[4], ranked[7], ranked[5], ranked[6]])
  await assert.rejects(score(c1, 12, 12), /pointsFormat\.laterRoundExists/)
  // Undo removes an unplayed round; round 1 cannot be undone.
  assert.equal((await asActor(ctx, 'owner', 'select undo_last_round($1) r', [t.id])).rows[0].r, 1)
  await assert.rejects(asActor(ctx, 'owner', 'select undo_last_round($1)', [t.id]), /pointsFormat\.noRoundToUndo/)
  await score(c1, 12, 12)
  await asActor(ctx, 'owner', 'select generate_next_round($1)', [t.id])
  const r2 = (await matches(ctx, t.id)).find(m => m.round_number === 2)
  await score(r2, 20, 4)
  await assert.rejects(asActor(ctx, 'owner', 'select undo_last_round($1)', [t.id]), /pointsFormat\.roundHasResults/)
  await assert.rejects(asActor(ctx, 'editor', 'select generate_next_round($1)', [t.id]), /pointsFormat\.roundUnfinished/)
  await assert.rejects(asActor(ctx, 'counter', 'select generate_next_round($1)', [t.id]), /Not allowed/)
  await drop(t)
})

test('mexicano with 10 players: two rest per round, those who rested least rest next', async () => {
  const t = await padel('mexicano', 10)
  await generate(t)
  await start(t)
  const rests = Object.fromEntries(t.entries.map(e => [e, 0]))
  for (let round = 1; round <= 5; round++) {
    const list = (await matches(ctx, t.id)).filter(m => m.round_number === round)
    assert.equal(list.length, 2)
    const playing = new Set(list.flatMap(players))
    assert.equal(playing.size, 8)
    for (const e of t.entries) if (!playing.has(e)) rests[e]++
    await playRound(t, round)
    if (round < 5) await asActor(ctx, 'owner', 'select generate_next_round($1)', [t.id])
  }
  assert.ok(Object.values(rests).every(n => n === 1), JSON.stringify(rests))
  await drop(t)
})

test('king of the court: odd N, a multiple of 4 players, winners move up and partners split', async () => {
  const bad = await padel('king_of_court', 9)
  await assert.rejects(generate(bad), /pointsFormat\.kotcPlayers/)
  await drop(bad)
  await assert.rejects(padel('king_of_court', 8, { scoringConfig: { points_per_match: 24 } }), /pointsFormat\.oddTarget/)
  const t = await padel('king_of_court', 12)
  assert.equal((await tournament(t)).scoring_config.points_per_match, 21)
  await generate(t)
  await start(t)
  const r1 = (await matches(ctx, t.id)).filter(m => m.round_number === 1)
  assert.equal(r1.length, 3)
  // Side A wins everywhere.
  await playRound(t, 1, () => [11, 10])
  await asActor(ctx, 'owner', 'select generate_next_round($1)', [t.id])
  const r2 = (await matches(ctx, t.id)).filter(m => m.round_number === 2)
  const win = m => [m.side_a_entry_id, m.side_a2_entry_id]
  const lose = m => [m.side_b_entry_id, m.side_b2_entry_id]
  assert.deepEqual(new Set(players(r2[0])), new Set([...win(r1[0]), ...win(r1[1])]))
  assert.deepEqual(new Set(players(r2[1])), new Set([...lose(r1[0]), ...win(r1[2])]))
  assert.deepEqual(new Set(players(r2[2])), new Set([...lose(r1[1]), ...lose(r1[2])]))
  // Last round's court 1 winners top the table.
  await playRound(t, 2, () => [10, 11])
  const top = (await standings(t)).slice(0, 2).map(r => r.entry_id)
  assert.deepEqual(new Set(top), new Set([r2[0].side_b_entry_id, r2[0].side_b2_entry_id]))
  assert.equal((await standings(t))[0].court, 1)
  await drop(t)
})

test('king of the court plays the rounds set before the start: courts + 3 and at least 5 by default', async () => {
  const t = await padel('king_of_court', 8)
  await generate(t)
  assert.equal((await tournament(t)).format_config.rounds, 5)
  await assert.rejects(generate(t, 1), /pointsFormat\.invalidRounds/)
  await assert.rejects(generate(t, 31), /pointsFormat\.invalidRounds/)
  assert.equal(await generate(t, 2), 1)
  assert.equal((await tournament(t)).format_config.rounds, 2)
  await start(t)
  await playRound(t, 1, () => [11, 10])
  await asActor(ctx, 'owner', 'select generate_next_round($1)', [t.id])
  await playRound(t, 2, () => [11, 10])
  await assert.rejects(asActor(ctx, 'owner', 'select generate_next_round($1)', [t.id]), /pointsFormat\.lastRoundPlayed/)
  await drop(t)
  const big = await padel('king_of_court', 16)
  await generate(big)
  assert.equal((await tournament(big)).format_config.rounds, 7)
  await drop(big)
})

test('team americano: fixed pairs play all-play-all on points; pairs must be complete', async () => {
  const t = await padel('team_americano', 4, { pairing: 'pre_agreed' })
  assert.equal((await tournament(t)).doubles_pairing_mode, 'pre_agreed')
  await assert.rejects(generate(t), /pointsFormat\.pairsIncomplete/)
  for (const e of t.entries) await ctx.db.query('insert into entry_members(entry_id,member_name,member_order) values ($1,$2,2)', [e, `Partner ${e.slice(0, 4)}`])
  assert.equal(await generate(t), 3)
  const ms = await matches(ctx, t.id)
  assert.equal(ms.length, 6)
  assert.ok(ms.every(m => m.side_a2_entry_id === null && m.side_b2_entry_id === null))
  await start(t)
  await score(ms[0], 15, 9)
  const s = await standings(t)
  assert.equal(s[0].total, 15)
  await drop(t)
})

test('live points: each rally counts, undo steps back, the total N finishes the match', async () => {
  const t = await padel('americano', 4, { scoringConfig: { points_per_match: 4 } })
  await generate(t)
  await start(t)
  const [m] = await matches(ctx, t.id)
  const rev = async () => (await ctx.db.query('select score_revision from matches where id=$1', [m.id])).rows[0].score_revision
  const live = async () => (await ctx.db.query('select * from live_scores where match_id=$1', [m.id])).rows[0]
  await asActor(ctx, 'counter', 'select start_live_match($1,$2)', [m.id, await rev()])
  assert.deepEqual((await live()).state, { family: 'points', points: { a: 0, b: 0 }, target: 4, winner: null })
  await assert.rejects(score(m, 3, 1), /scoringFlow\.liveBlocked/)
  const point = async side => asActor(ctx, 'counter', 'select record_point($1,$2,$3)', [m.id, side, (await live()).revision])
  await point('a'); await point('a'); await point('undo'); await point('b'); await point('a')
  assert.deepEqual((await live()).state.points, { a: 2, b: 1 })
  await point('a')
  const done = await live()
  assert.equal(done.status, 'finished')
  assert.equal(done.state.winner, 'a')
  const row = (await matches(ctx, t.id)).find(x => x.id === m.id)
  assert.equal(row.status, 'finished')
  assert.deepEqual([row.side_a_score, row.side_b_score], [3, 1])
  await assert.rejects(point('a'), /Match already finished/)
  await drop(t)
})

test('individual formats: padel only, one player per entry, roster changes block the start', async () => {
  await assert.rejects(fixture(ctx, { format: 'americano', sport: 'tennis', status: 'registration_closed' }), /pointsFormat\.padelOnly/)
  const t = await padel('americano', 8)
  await assert.rejects(ctx.db.query('insert into entry_members(entry_id,member_name,member_order) values ($1,$2,2)', [t.entries[0], 'Partner']), /pointsFormat\.individualEntries/)
  await settings(t, { doubles_pairing_mode: 'pre_agreed' })
  assert.equal((await tournament(t)).doubles_pairing_mode, 'pick_random')
  await generate(t)
  await ctx.db.query("update entries set status='rejected' where id=$1", [t.entries[7]])
  await assert.rejects(start(t), /lifecycle\.rosterStale/)
  await ctx.db.query("update entries set status='approved' where id=$1", [t.entries[7]])
  await start(t)
  await drop(t)
})

test('mexicano with rests is not stale at the start: resting players are in the roster', async () => {
  const t = await padel('mexicano', 9)
  await generate(t)
  await start(t)
  assert.equal((await tournament(t)).status, 'in_progress')
  await drop(t)
})

test('snapshot carries points standings; schedule, reminders and opponents see all four players', async () => {
  const t = await padel('americano', 4)
  await generate(t)
  const s = (await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.equal(s.points_standings.length, 4)
  assert.ok(s.matches[0].side_a2_entry_id)
  const [m] = await matches(ctx, t.id)
  const court = (await ctx.db.query("insert into courts(tournament_id,name,sort_order) values ($1,'C1',1) returning id", [t.id])).rows[0].id
  const other = (await ctx.db.query('insert into matches(tournament_id,stage,round_number,match_number,side_a_entry_id,side_b_entry_id,status) values ($1,$2,9,9,$3,$4,$5) returning id',
    [t.id, 'main', m.side_a2_entry_id, m.side_b2_entry_id, 'ready'])).rows[0].id
  await ctx.db.query("insert into match_schedule(tournament_id,match_id,court_id,scheduled_at,time_kind,state) values ($1,$2,$3,'2030-01-01T10:00:00Z','fixed','draft')", [t.id, other, court])
  const conflicts = (await ctx.db.query("select match_schedule_conflicts($1,null,'2030-01-01T10:00:00Z','fixed',null) c", [m.id])).rows[0].c
  assert.ok(conflicts.some(c => c.kind === 'participant_busy'))
  await drop(t)
})

test('points formats refuse the knockout, round-robin and group generators; matches stay after the start', async () => {
  for (const format of ['americano', 'team_americano']) {
    const t = format === 'americano' ? await padel(format, 8) : await padel(format, 4, { pairing: 'pre_agreed' })
    if (format === 'team_americano') for (const e of t.entries) await ctx.db.query('insert into entry_members(entry_id,member_name,member_order) values ($1,$2,2)', [e, `Partner ${e.slice(0, 4)}`])
    await generate(t)
    const count = (await matches(ctx, t.id)).length
    for (const sql of [
      "select generate_bracket($1,'auto-random',null)",
      "select rebuild_bracket($1,'auto-random',null)",
      'select generate_round_robin($1)',
      'select generate_groups($1,2,null)',
    ]) await assert.rejects(asActor(ctx, 'owner', sql, [t.id]), /pointsFormat\.useRounds/, `${format}: ${sql}`)
    const [m] = await matches(ctx, t.id)
    await assert.rejects(asActor(ctx, 'owner', "insert into matches(tournament_id,stage,round_number,match_number,side_a_entry_id,side_b_entry_id,status) values ($1,'main',9,9,$2,$3,'ready')",
      [t.id, m.side_a_entry_id, m.side_b_entry_id]), /permission denied|pointsFormat\.useRounds/)
    assert.equal((await matches(ctx, t.id)).length, count)
    // The UI "reset bracket" is a direct delete: refused once the tournament runs or is over.
    await start(t)
    await asActor(ctx, 'owner', 'delete from matches where tournament_id=$1', [t.id])
    assert.equal((await matches(ctx, t.id)).length, count)
    await ctx.db.query("update tournaments set status='completed' where id=$1", [t.id])
    await asActor(ctx, 'editor', 'delete from matches where tournament_id=$1', [t.id])
    assert.equal((await matches(ctx, t.id)).length, count)
    await drop(t)
  }
})

test('the padel formats migration replays cleanly', async () => {
  await reapplyForwardMigrations(ctx)
  const t = await padel('americano', 8)
  assert.equal(await generate(t), 7)
  await drop(t)
})
