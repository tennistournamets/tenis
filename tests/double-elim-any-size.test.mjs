import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const matchesOf = async id => (await ctx.db.query(
  `select id, stage, round_number, match_number, side_a_entry_id a, side_b_entry_id b, winner_entry_id w, status,
     next_match_id, loser_next_match_id, side_a_score
   from matches where tournament_id=$1 order by stage, round_number, match_number`, [id])).rows

// Plays every ready match until nothing is left: `pick` chooses the winner.
async function playOut(t, pick) {
  for (let guard = 0; guard < 500; guard++) {
    const ready = (await matchesOf(t.id)).filter(m => m.status !== 'finished' && m.a && m.b)
    if (!ready.length) return
    const m = ready[0]
    const w = pick(m)
    await ctx.db.query("update matches set winner_entry_id=$2, status='finished', side_a_score=$3, side_b_score=$4 where id=$1",
      [m.id, w, w === m.a ? 1 : 0, w === m.a ? 0 : 1])
    await ctx.db.query('select propagate_winner($1,$2)', [m.id, w])
  }
  throw new Error('bracket did not finish')
}

const strongerWins = t => m => (t.entries.indexOf(m.a) < t.entries.indexOf(m.b) ? m.a : m.b)
const weakerWins = t => m => (t.entries.indexOf(m.a) > t.entries.indexOf(m.b) ? m.a : m.b)

for (const mode of ['seeded', 'manual', 'auto-random']) {
  for (const n of [3, 5, 6, 7, 9, 10, 12, 13, 20]) {
    test(`${mode}, ${n} entries: everyone placed, nothing stuck, 2n-2 games, two losses out`, async () => {
      const t = await fixture(ctx, { status: 'registration_closed', count: n, format: 'double_elimination' })
      await asActor(ctx, 'owner', 'select generate_bracket($1,$2)', [t.id, mode])
      const first = (await matchesOf(t.id)).filter(m => m.stage === 'winners' && m.round_number === 1)
      const placed = first.flatMap(m => [m.a, m.b]).filter(Boolean)
      assert.equal(placed.length, n)
      assert.equal(new Set(placed).size, n)
      for (const m of first) assert.ok(m.a || m.b, 'no empty first-round match')

      await asActor(ctx, 'owner', "update tournaments set status='in_progress' where id=$1", [t.id]).catch(() =>
        ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id]))
      await playOut(t, mode === 'auto-random' ? weakerWins(t) : strongerWins(t))

      const all = await matchesOf(t.id)
      const stuck = all.filter(m => m.status !== 'finished')
      assert.deepEqual(stuck.map(m => `${m.stage} ${m.round_number}.${m.match_number} ${m.a ? 'A' : '-'}${m.b ? 'B' : '-'}`), [], 'no match left waiting')
      const gf = all.find(m => m.stage === 'grand_final')
      assert.ok(gf.w, 'the grand final has a winner')
      const games = all.filter(m => m.a && m.b)
      assert.equal(games.length, 2 * n - 2, 'a double-elimination field plays 2n-2 games')
      const losses = new Map(t.entries.map(id => [id, 0]))
      for (const g of games) losses.set(g.w === g.a ? g.b : g.a, losses.get(g.w === g.a ? g.b : g.a) + 1)
      assert.ok(losses.get(gf.w) <= 1, 'the champion lost at most once')
      const runnerUp = gf.w === gf.a ? gf.b : gf.a
      for (const [id, count] of losses) {
        if (id === gf.w || id === runnerUp) continue
        assert.equal(count, 2, 'everyone else is out after two losses')
      }
    })
  }
}

test('the seeded draw keeps seed 1 on top and seed 2 at the bottom with BYEs', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', count: 6, format: 'double_elimination' })
  await asActor(ctx, 'owner', "select generate_bracket($1,'seeded')", [t.id])
  const first = (await matchesOf(t.id)).filter(m => m.stage === 'winners' && m.round_number === 1)
  const slots = first.flatMap(m => [m.a, m.b])
  assert.equal(slots[0], t.entries[0])
  assert.equal(slots[slots.length - 1], t.entries[1])
  assert.equal(slots[1], null)
  assert.equal(slots[slots.length - 2], null)
  // BYE matches are decided and have no losers-bracket link.
  for (const m of first.filter(x => !x.a || !x.b)) {
    assert.equal(m.status, 'finished')
    assert.equal(m.loser_next_match_id, null)
  }
})

test('powers of two behave as before, and a BYE cannot be moved by rearranging', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', count: 8, format: 'double_elimination' })
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
  const all = await matchesOf(t.id)
  assert.equal(all.filter(m => m.stage === 'winners').length, 7)
  assert.equal(all.filter(m => m.stage === 'losers').length, 6)
  assert.ok(all.filter(m => m.stage === 'winners' && m.round_number === 1).every(m => m.a && m.b && m.status === 'ready'))

  const odd = await fixture(ctx, { status: 'registration_closed', count: 5, format: 'double_elimination' })
  await asActor(ctx, 'owner', "select generate_bracket($1,'seeded')", [odd.id])
  const first = (await matchesOf(odd.id)).filter(m => m.stage === 'winners' && m.round_number === 1)
  const bye = first.find(m => !m.a || !m.b)
  const full = first.find(m => m.a && m.b)
  const layout = [
    { match_id: bye.id, side_a_entry_id: full.a, side_b_entry_id: bye.a || bye.b },
    { match_id: full.id, side_a_entry_id: null, side_b_entry_id: full.b },
  ]
  await assert.rejects(asActor(ctx, 'owner', 'select apply_bracket_layout($1,$2)', [odd.id, JSON.stringify(layout)]), /byeFixedDoubleElim/)
  // Swapping two players keeps the BYEs where they are and is allowed.
  const swap = [
    { match_id: bye.id, side_a_entry_id: bye.a ? full.a : null, side_b_entry_id: bye.b ? full.a : null },
    { match_id: full.id, side_a_entry_id: bye.a || bye.b, side_b_entry_id: full.b },
  ]
  await asActor(ctx, 'owner', 'select apply_bracket_layout($1,$2)', [odd.id, JSON.stringify(swap)])
  await reapplyForwardMigrations(ctx)
})

test('correcting an upper result replays a losers-bracket BYE with the new loser', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', count: 6, format: 'double_elimination' })
  await asActor(ctx, 'owner', "select generate_bracket($1,'seeded')", [t.id])
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  const sets = a => JSON.stringify(a ? [{ set_index: 1, side_a_games: 6, side_b_games: 2 }, { set_index: 2, side_a_games: 6, side_b_games: 3 }]
    : [{ set_index: 1, side_a_games: 2, side_b_games: 6 }, { set_index: 2, side_a_games: 3, side_b_games: 6 }])
  const all = await matchesOf(t.id)
  // The real first-round match next to seed 1's BYE feeds a losers-bracket BYE.
  const real = all.find(m => m.stage === 'winners' && m.round_number === 1 && m.a && m.b && m.loser_next_match_id)
  const lbBye = all.find(m => m.id === real.loser_next_match_id)
  await asActor(ctx, 'owner', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [real.id, sets(true)])
  let lb = (await matchesOf(t.id)).find(m => m.id === lbBye.id)
  assert.equal(lb.status, 'finished')
  assert.equal(lb.w, real.b, 'the loser passes the losers-bracket BYE at once')

  const revision = (await ctx.db.query('select score_revision from matches where id=$1', [real.id])).rows[0].score_revision
  const result = { sets: JSON.parse(sets(false)) }
  const p = (await asActor(ctx, 'owner', 'select get_match_correction_preview($1,$2,$3) p', [real.id, JSON.stringify(result), revision])).rows[0].p
  await asActor(ctx, 'owner', 'select apply_match_correction($1,$2,$3,$4)', [real.id, JSON.stringify(result), revision, p.token])
  lb = (await matchesOf(t.id)).find(m => m.id === lbBye.id)
  assert.equal(lb.status, 'finished')
  assert.equal(lb.w, real.a, 'after the correction the new loser passes the BYE')
  const w2 = (await matchesOf(t.id)).filter(m => m.stage === 'winners' && m.round_number === 2)
  assert.ok(w2.some(m => m.a === real.b || m.b === real.b), 'the corrected winner moved up')
  assert.ok(!w2.some(m => m.a === real.a || m.b === real.a), 'the old winner left the upper bracket')
})
