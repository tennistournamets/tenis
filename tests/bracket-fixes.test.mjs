import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, snapshot, assertDeniedUnchanged, winningSets, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const drop = id => ctx.db.query('delete from tournaments where id=$1', [id])
const firstRound = async (id, stage = 'main') => (await matches(ctx, id))
  .filter(m => m.stage === stage && m.round_number === 1).sort((a, b) => a.match_number - b.match_number)
const pairs = rows => rows.map(m => [m.side_a_entry_id, m.side_b_entry_id])
// Standard seeded bracket: slot i holds seed positions[i]; seeds past the field are BYEs.
function seededPairs(seeds) {
  let p = [1]
  while (p.length < seeds.length) p = p.flatMap(s => [s, 2 * p.length + 1 - s])
  const slots = p.map(s => seeds[s - 1] ?? null)
  return slots.flatMap((s, i) => i % 2 ? [] : [[s, slots[i + 1]]])
}
const item = (m, a, b) => ({ match_id: m.id, side_a_entry_id: a, side_b_entry_id: b })
const layout = (actor, id, data) => asActor(ctx, actor, 'select apply_bracket_layout($1,$2::jsonb)', [id, JSON.stringify(data)])
async function win(m, side = 'a') {
  const sets = side === 'a' ? winningSets : JSON.stringify(JSON.parse(winningSets).map(s => ({ ...s, side_a_games: 0, side_b_games: 6 })))
  await asActor(ctx, 'owner', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [m.id, sets])
}
// Seed order is a permutation unrelated to the order the entries were created in.
async function seed(t, order) {
  for (const [i, id] of order.entries()) await ctx.db.query('update entries set seed_order=$2 where id=$1', [id, i + 1])
}
const shuffled = entries => entries.map((id, i) => [id, (i * 7 + 3) % entries.length]).sort((a, b) => a[1] - b[1]).map(([id]) => id)

test('manual single-elimination draw follows seed_order in standard seeded positions for 2–33 players', async () => {
  for (let n = 2; n <= 33; n++) {
    const t = await fixture(ctx, { count: n, status: 'registration_closed' })
    const seeds = shuffled(t.entries)
    await seed(t, seeds)
    await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
    const rows = await firstRound(t.id)
    assert.deepEqual(pairs(rows), seededPairs(seeds), `n=${n}`)
    if (n > 2) {
      // Seeds 1 and 2 sit in opposite halves; the BYEs go to the top seeds.
      const half = rows.length / 2
      assert.ok(rows.slice(0, half).some(m => m.side_a_entry_id === seeds[0]), `n=${n}: seed 1 in the top half`)
      assert.ok(rows.slice(half).some(m => m.side_a_entry_id === seeds[1]), `n=${n}: seed 2 in the bottom half`)
    }
    const byes = rows.filter(m => !m.side_b_entry_id).map(m => m.side_a_entry_id).sort()
    assert.deepEqual(byes, seeds.slice(0, rows.length * 2 - n).sort(), `n=${n}: BYEs belong to the top seeds`)
    await drop(t.id)
  }
})

test('unseeded entries follow the seeded ones by entry time', async () => {
  const t = await fixture(ctx, { count: 4, status: 'registration_closed' })
  await ctx.db.query('update entries set seed_order=null where tournament_id=$1', [t.id])
  await ctx.db.query('update entries set seed_order=1 where id=$1', [t.entries[3]])
  for (const [i, id] of t.entries.entries()) await ctx.db.query("update entries set created_at=now()+$2*interval '1 minute' where id=$1", [id, i])
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
  assert.deepEqual(pairs(await firstRound(t.id)), [[t.entries[3], t.entries[2]], [t.entries[0], t.entries[1]]])
  await drop(t.id)
})

test('manual double-elimination draw is seeded and losers still drop into the right lower-bracket slots', async () => {
  const t = await fixture(ctx, { count: 8, format: 'double_elimination', status: 'registration_closed' })
  const seeds = shuffled(t.entries)
  await seed(t, seeds)
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
  let rows = await firstRound(t.id, 'winners')
  const s = i => seeds[i - 1]
  assert.deepEqual(pairs(rows), [[s(1), s(8)], [s(4), s(5)], [s(2), s(7)], [s(3), s(6)]])

  // Rearrange before the start: swap seed 8 and seed 5 between the first two matches.
  const s0 = await snapshot(ctx)
  await asActor(ctx, 'owner', "select swap_bracket_slots($1,$2,'B',$3,'B')", [t.id, rows[0].id, rows[1].id])
  assert.notDeepEqual(await snapshot(ctx), s0)
  rows = await firstRound(t.id, 'winners')
  assert.deepEqual(pairs(rows).slice(0, 2), [[s(1), s(5)], [s(4), s(8)]])

  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  for (const m of rows) await win(m, 'b')
  const all = await matches(ctx, t.id)
  for (const m of rows) {
    const lb = all.find(x => x.id === m.loser_next_match_id)
    assert.equal(lb.stage, 'losers')
    assert.equal(m.loser_next_slot === 'A' ? lb.side_a_entry_id : lb.side_b_entry_id, m.side_a_entry_id, `loser of W1-${m.match_number}`)
    const next = all.find(x => x.id === m.next_match_id)
    assert.equal(m.next_slot === 'A' ? next.side_a_entry_id : next.side_b_entry_id, m.side_b_entry_id, `winner of W1-${m.match_number}`)
  }
  // The rest of the bracket still reaches a single grand final.
  let played = rows.length
  while (true) {
    const ready = (await matches(ctx, t.id)).find(m => m.status === 'ready')
    if (!ready) break
    await win(ready, played % 2 ? 'a' : 'b')
    assert.ok(++played <= 14)
  }
  assert.equal(played, 14)
  assert.ok((await matches(ctx, t.id)).every(m => m.status === 'finished'))
  await drop(t.id)
})

test('layouts are limited to first-round slots no match feeds, and keep every player exactly once', async () => {
  const de = await fixture(ctx, { count: 8, format: 'double_elimination', status: 'registration_closed' })
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [de.id])
  const rows = await matches(ctx, de.id)
  const w1 = rows.filter(m => m.stage === 'winners' && m.round_number === 1).sort((a, b) => a.match_number - b.match_number)
  const w2 = rows.find(m => m.stage === 'winners' && m.round_number === 2)
  const l1 = rows.find(m => m.stage === 'losers' && m.round_number === 1)
  const gf = rows.find(m => m.stage === 'grand_final')
  const [p1, p2] = [w1[0].side_a_entry_id, w1[0].side_b_entry_id]
  const versions = (await ctx.db.query('select tournament_match_versions($1) v', [de.id])).rows[0].v
  for (const target of [w2, l1, gf]) {
    // The UI path (save_bracket_layout) and both direct RPCs refuse fed matches.
    await assertDeniedUnchanged(ctx, 'owner', 'select save_bracket_layout($1,$2::jsonb,$3::jsonb)', [de.id, JSON.stringify([item(target, p1, p2), item(w1[0], null, null)]), JSON.stringify(versions)], /bracketSlotLocked/)
    await assertDeniedUnchanged(ctx, 'owner', 'select apply_bracket_layout($1,$2::jsonb)', [de.id, JSON.stringify([item(target, p1, p2)])], /bracketSlotLocked/)
    await assertDeniedUnchanged(ctx, 'owner', "select swap_bracket_slots($1,$2,'A',$3,'A')", [de.id, w1[0].id, target.id], /bracketSlotLocked/)
  }
  const [a, b] = w1
  for (const data of [
    [item(a, a.side_a_entry_id, a.side_b_entry_id), item(b, a.side_a_entry_id, b.side_b_entry_id)], // one player in two matches
    [item(a, a.side_a_entry_id, b.side_a_entry_id)], // copied from a match outside the layout
    [item(a, a.side_a_entry_id, null)], // player dropped
  ]) await assertDeniedUnchanged(ctx, 'editor', 'select apply_bracket_layout($1,$2::jsonb)', [de.id, JSON.stringify(data)], /bracketLayoutInvalid/)

  // Active live scoring blocks a rearrangement even when the tournament was stopped.
  await ctx.db.query("insert into live_scores(match_id,tournament_id,status,state) values($1,$2,'active','{}')", [a.id, de.id])
  await assertDeniedUnchanged(ctx, 'owner', "select swap_bracket_slots($1,$2,'A',$3,'A')", [de.id, a.id, b.id], /live/)
  await ctx.db.query('delete from live_scores where match_id=$1', [a.id])

  // After the start nothing moves, through either RPC.
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [de.id])
  await assertDeniedUnchanged(ctx, 'owner', "select swap_bracket_slots($1,$2,'A',$3,'A')", [de.id, a.id, b.id], /rulesLocked/)
  await assertDeniedUnchanged(ctx, 'owner', 'select apply_bracket_layout($1,$2::jsonb)', [de.id, JSON.stringify([item(a, a.side_b_entry_id, a.side_a_entry_id)])], /rulesLocked/)
  await drop(de.id)
})

test('a BYE can be rearranged before the start: the free pass follows the player', async () => {
  const t = await fixture(ctx, { count: 5, status: 'registration_closed' })
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
  const [s1, s2, s3, s4, s5] = t.entries
  let rows = await firstRound(t.id)
  assert.deepEqual(pairs(rows), [[s1, null], [s4, s5], [s2, null], [s3, null]])
  const r2 = async () => (await matches(ctx, t.id)).filter(m => m.round_number === 2).sort((a, b) => a.match_number - b.match_number)
  assert.deepEqual(pairs(await r2()), [[s1, null], [s2, s3]])

  // Seed 5 takes seed 1's BYE; seed 1 plays seed 4.
  await asActor(ctx, 'owner', "select swap_bracket_slots($1,$2,'A',$3,'B')", [t.id, rows[0].id, rows[1].id])
  rows = await firstRound(t.id)
  assert.deepEqual(pairs(rows).slice(0, 2), [[s5, null], [s4, s1]])
  assert.equal(rows[0].status, 'finished'); assert.equal(rows[0].winner_entry_id, s5)
  assert.equal(rows[1].status, 'ready'); assert.equal(rows[1].winner_entry_id, null)
  assert.deepEqual(pairs(await r2()), [[s5, null], [s2, s3]])
  assert.equal((await r2())[0].status, 'pending')

  // Two BYEs feeding the same match swap players; the waiting match follows.
  await asActor(ctx, 'owner', "select swap_bracket_slots($1,$2,'A',$3,'A')", [t.id, rows[2].id, rows[3].id])
  assert.deepEqual(pairs(await r2()), [[s5, null], [s3, s2]])
  assert.equal((await r2())[1].status, 'ready')

  // Moving a BYE to the other slot of its own match keeps the free pass.
  await asActor(ctx, 'owner', "select swap_bracket_slots($1,$2,'A',$2,'B')", [t.id, rows[0].id])
  assert.deepEqual(pairs(await firstRound(t.id))[0], [null, s5])
  assert.deepEqual(pairs(await r2())[0], [s5, null])

  // Emptying a match would leave its branch without a player.
  rows = await firstRound(t.id)
  await assertDeniedUnchanged(ctx, 'owner', "select swap_bracket_slots($1,$2,'B',$3,'B')", [t.id, rows[0].id, rows[2].id], /bracketLayoutInvalid/)

  // The rearranged bracket still plays to a champion.
  await ctx.db.query("update tournaments set status='in_progress' where id=$1", [t.id])
  let played = 0
  while (true) {
    const ready = (await matches(ctx, t.id)).find(m => m.status === 'ready')
    if (!ready) break
    await win(ready)
    assert.ok(++played <= 4)
  }
  assert.equal(played, 4)
  assert.ok((await matches(ctx, t.id)).every(m => m.status === 'finished'))
  await drop(t.id)
})

test('a BYE whose next match is played cannot be moved', async () => {
  const t = await fixture(ctx, { count: 3, status: 'in_progress' })
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
  const rows = await firstRound(t.id)
  await win(rows[1])
  const final = (await matches(ctx, t.id)).find(m => m.round_number === 2)
  await win(final)
  // Stopped afterwards: status allows layouts, the played final does not.
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await assertDeniedUnchanged(ctx, 'owner', "select swap_bracket_slots($1,$2,'A',$2,'B')", [t.id, rows[0].id], /rulesLocked/)
  await drop(t.id)
})

test('a started or completed tournament with results cannot be redrawn; BYEs alone are not results', async () => {
  for (const format of ['single_elimination', 'double_elimination']) {
    const t = await fixture(ctx, { count: format === 'double_elimination' ? 4 : 3, format, status: 'in_progress' })
    await asActor(ctx, 'owner', 'select generate_bracket($1)', [t.id])
    // Only BYEs so far: still allowed, both fresh and as a rebuild.
    await asActor(ctx, 'editor', "select rebuild_bracket($1,'manual')", [t.id])
    const ready = (await matches(ctx, t.id)).find(m => m.status === 'ready')
    await win(ready)
    for (const status of ['in_progress', 'completed']) {
      await ctx.db.query('update tournaments set status=$2 where id=$1', [t.id, status])
      for (const sql of ['select generate_bracket($1)', "select rebuild_bracket($1,'manual')"]) {
        await assertDeniedUnchanged(ctx, 'owner', sql, [t.id], /bracketResultsLocked/)
      }
    }
    // A stopped tournament may be redrawn; the UI warns that results are erased.
    await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
    await asActor(ctx, 'owner', 'select rebuild_bracket($1)', [t.id])
    assert.ok((await matches(ctx, t.id)).every(m => m.side_a_score === null))
    await drop(t.id)
  }
})

test('an active live match also blocks redrawing a started tournament', async () => {
  const t = await fixture(ctx, { count: 4, status: 'in_progress' })
  await asActor(ctx, 'owner', 'select generate_bracket($1)', [t.id])
  const m = (await matches(ctx, t.id)).find(r => r.status === 'ready')
  await asActor(ctx, 'counter', 'select start_live_match($1,(select score_revision from matches where id=$1))', [m.id])
  await assertDeniedUnchanged(ctx, 'owner', 'select rebuild_bracket($1)', [t.id], /bracketResultsLocked/)
  await drop(t.id)
})

test('repeated draws in one transaction reuse the scratch table', async () => {
  const t = await fixture(ctx, { count: 6, status: 'registration_closed' })
  await ctx.db.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role','authenticated',false)", [ctx.actors.owner])
  await ctx.db.exec('set role authenticated')
  try {
    await ctx.db.exec('begin')
    await ctx.db.query("select generate_bracket($1,'manual')", [t.id])
    await ctx.db.query('select rebuild_bracket($1)', [t.id])
    await ctx.db.exec('commit')
  } catch (error) {
    await ctx.db.exec('rollback')
    throw error
  } finally {
    await ctx.db.exec('reset role')
    await ctx.db.exec("select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','',false)")
  }
  assert.equal((await matches(ctx, t.id)).length, 7)
  await drop(t.id)
})

test('the seeding helper is internal and the bracket_fixes migration is replayable', async () => {
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await ctx.db.query("select has_function_privilege($1,'public.knockout_seeded_slots(uuid[])','EXECUTE') ok", [role])).rows[0].ok, false)
  }
  const t = await fixture(ctx, { count: 6, status: 'registration_closed' })
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
  const before = await snapshot(ctx)
  const definitions = async () => (await ctx.db.query("select oid::regprocedure::text as signature,pg_get_functiondef(oid) as body,proacl::text from pg_proc where pronamespace='public'::regnamespace order by 1")).rows
  const functions = await definitions()
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
  assert.deepEqual(await definitions(), functions)
  await drop(t.id)
})
