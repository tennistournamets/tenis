import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import {
  asActor,
  assertDeniedUnchanged,
  createDatabase,
  fixture,
  matches,
  snapshot,
  winningSets,
} from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const reverseWinningSets = JSON.stringify(JSON.parse(winningSets).map(set => ({
  ...set,
  side_a_games: set.side_b_games,
  side_b_games: set.side_a_games,
})))

const scoringCalls = id => [
  ['select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [id, winningSets]],
  ['select update_football_result($1,2,0,null,null,(select score_revision from matches where id=$1))', [id]],
  ['select start_live_match($1,(select score_revision from matches where id=$1))', [id]],
  ["select record_point($1,'a',(select revision from live_scores where match_id=$1))", [id]],
  ['select stop_live_match($1,(select revision from live_scores where match_id=$1))', [id]],
  ['select set_live_sides($1, true, false)', [id]],
]

async function bracket(options = {}) {
  const tournament = await fixture(ctx, options)
  await asActor(ctx, options.owner ?? 'owner', 'select generate_bracket($1)', [tournament.id])
  const rows = await matches(ctx, tournament.id)
  return { ...tournament, rows, first: rows.find(row => row.status === 'ready') }
}

async function live(id) {
  return (await ctx.db.query('select * from live_scores where match_id = $1', [id])).rows[0]
}

async function row(id) {
  return (await ctx.db.query('select * from matches where id = $1', [id])).rows[0]
}

async function assertDirectWriteDenied(actor, sql, params) {
  const before = await snapshot(ctx)
  let result
  let rejection
  try {
    result = await asActor(ctx, actor, sql, params)
  } catch (error) {
    rejection = error
  }
  if (rejection) {
    assert.equal(rejection.code, '42501', `${actor}: ${sql}`)
  } else {
    // RLS USING can hide the target row instead of throwing. Every caller uses
    // RETURNING id so a successful write cannot be mistaken for a denial.
    assert.deepEqual(result.rows, [], `${actor}: ${sql}`)
  }
  assert.deepEqual(await snapshot(ctx), before, `${actor}: ${sql}`)
}

test('anon, outsider, and unassigned platform admin cannot use any scoring RPC', async () => {
  const tournament = await bracket()
  // Existing state makes stop/sides exercise authorization rather than merely
  // failing because there is no live session to operate on.
  await asActor(ctx, 'owner', 'select start_live_match($1,(select score_revision from matches where id=$1))', [tournament.first.id])
  await asActor(ctx, 'owner', "select record_point($1,'a',(select revision from live_scores where match_id=$1))", [tournament.first.id])
  for (const actor of ['anon', 'outsider', 'platform_admin']) {
    for (const [sql, params] of scoringCalls(tournament.first.id)) {
      await assertDeniedUnchanged(ctx, actor, sql, params)
    }
  }
})

test('owning or scoring one tournament does not grant access to a foreign match UUID', async () => {
  await bracket()
  const foreign = await bracket({ owner: 'outsider' })
  await asActor(ctx, 'outsider', 'select start_live_match($1,(select score_revision from matches where id=$1))', [foreign.first.id])
  for (const actor of ['anon', 'owner', 'editor', 'counter', 'platform_admin']) {
    for (const [sql, params] of scoringCalls(foreign.first.id)) {
      await assertDeniedUnchanged(ctx, actor, sql, params)
    }
  }
})

test('all scoring RPCs reject null and nonexistent match UUIDs without changing state', async () => {
  const tournament = await bracket()
  await asActor(ctx, 'counter', 'select start_live_match($1,(select score_revision from matches where id=$1))', [tournament.first.id])
  await asActor(ctx, 'counter', "select record_point($1,'a',(select revision from live_scores where match_id=$1))", [tournament.first.id])
  for (const id of [null, randomUUID()]) {
    for (const [sql, params] of scoringCalls(id)) {
      await assertDeniedUnchanged(ctx, 'owner', sql, params, /Match not found/)
    }
  }
})

test('counter cannot submit either manual result RPC', async () => {
  const tennis = await bracket()
  const football = await bracket({ sport: 'football' })
  await assertDeniedUnchanged(ctx, 'counter', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [tennis.first.id, winningSets])
  await assertDeniedUnchanged(ctx, 'counter', 'select update_football_result($1,2,0,null,null,(select score_revision from matches where id=$1))', [football.first.id])
})

test('owner and editor retain tennis and football result submission and correction', async () => {
  for (const actor of ['owner', 'editor']) {
    const tennis = await bracket()
    await asActor(ctx, actor, 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [tennis.first.id, winningSets])
    assert.equal((await row(tennis.first.id)).winner_entry_id, tennis.first.side_a_entry_id)
    const slot = tennis.first.next_slot === 'A' ? 'side_a_entry_id' : 'side_b_entry_id'
    assert.equal((await row(tennis.first.next_match_id))[slot], tennis.first.side_a_entry_id)
    await asActor(ctx, actor, 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [tennis.first.id, reverseWinningSets])
    assert.equal((await row(tennis.first.next_match_id))[slot], tennis.first.side_b_entry_id)

    const football = await bracket({ sport: 'football' })
    await asActor(ctx, actor, 'select update_football_result($1,2,0,null,null,(select score_revision from matches where id=$1))', [football.first.id])
    assert.equal((await row(football.first.id)).winner_entry_id, football.first.side_a_entry_id)
    await asActor(ctx, actor, 'select update_football_result($1,0,2,null,null,(select score_revision from matches where id=$1))', [football.first.id])
    assert.equal((await row(football.first.id)).winner_entry_id, football.first.side_b_entry_id)
  }
})

test('all scoring roles retain live points and undo; only managers can stop', async () => {
  for (const actor of ['owner', 'editor', 'counter']) {
    const tournament = await bracket()
    const id = tournament.first.id
    await asActor(ctx, actor, 'select start_live_match($1,(select score_revision from matches where id=$1))', [id])
    assert.equal((await live(id)).status, 'active')
    assert.equal((await live(id)).counter_user_id, ctx.actors[actor])
    await asActor(ctx, actor, "select record_point($1, 'a', 0)", [id])
    assert.equal((await live(id)).state.points.a, 1)
    assert.equal((await live(id)).revision, 1)
    await asActor(ctx, actor, 'select set_live_sides($1, true, false)', [id])
    assert.equal((await live(id)).sides_swapped, true)
    assert.equal((await live(id)).sides_auto, false)
    assert.equal((await live(id)).revision, 1)
    await asActor(ctx, actor, "select record_point($1, 'undo', 1)", [id])
    assert.equal((await live(id)).state.points.a, 0)
    await asActor(ctx, actor === 'counter' ? 'owner' : actor, 'select stop_live_match($1,(select revision from live_scores where match_id=$1))', [id])
    assert.equal((await live(id)).status, 'stopped')
    await asActor(ctx, actor, 'select start_live_match($1,(select score_revision from matches where id=$1))', [id])
    assert.equal((await live(id)).status, 'active')
  }
})

test('clients cannot create or rewire match graph rows to attack another tournament', async () => {
  const own = await bracket()
  const foreign = await bracket({ owner: 'outsider' })
  const groupId = randomUUID()
  await ctx.db.query("insert into groups(id, tournament_id, name, group_index) values ($1, $2, 'Foreign group', 0)", [groupId, foreign.id])
  const attacks = [
    ['next_match_id', foreign.first.id],
    ['loser_next_match_id', foreign.first.id],
    ['side_a_entry_id', foreign.entries[0]],
    ['side_b_entry_id', foreign.entries[1]],
    ['winner_entry_id', foreign.entries[0]],
    ['group_id', groupId],
    ['tournament_id', foreign.id],
  ]
  for (const actor of ['owner', 'editor', 'counter', 'outsider', 'platform_admin', 'anon']) {
    for (const [column, value] of attacks) {
      const sql = `update matches set ${column} = $1 where id = $2 returning id`
      if (column === 'winner_entry_id' && ['owner', 'editor'].includes(actor)) {
        // The reset grant must still reject assigning any non-null winner.
        await assertDeniedUnchanged(ctx, actor, sql, [value, own.first.id],
          error => error.code === '42501' && /permission denied|row-level security/.test(error.message))
      } else {
        await assertDirectWriteDenied(actor, sql, [value, own.first.id])
      }
    }
    await assertDirectWriteDenied(actor, `insert into matches(tournament_id, round_number, match_number,
      side_a_entry_id, side_b_entry_id, next_match_id, next_slot)
      values ($1, 1, 99, $2, $3, $4, 'A') returning id`, [own.id, own.entries[0], own.entries[1], foreign.first.id])
  }
})

test('direct result reset is closed for all API actors', async () => {
  const sql = "update matches set winner_entry_id = null, status = 'ready' where id = $1 returning id"
  for (const actor of ['owner', 'editor']) {
    const tournament = await bracket()
    const id = tournament.first.id
    await asActor(ctx, actor, 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [id, winningSets])
    assert.equal((await row(id)).status, 'finished')
    for (const deniedActor of ['counter', 'outsider', 'platform_admin', 'anon']) {
      await assertDirectWriteDenied(deniedActor, sql, [id])
    }
    await assertDirectWriteDenied(actor, sql, [id])
    assert.equal((await row(id)).status, 'finished')
  }
})

test('manual result submission rejects legacy foreign winner and loser edges atomically', async () => {
  for (const sport of ['tennis', 'football']) {
    for (const column of ['next_match_id', 'loser_next_match_id']) {
      const own = await bracket({ sport })
      const foreign = await bracket({ sport, owner: 'outsider' })
      // A privileged fixture reproduces previously persisted bad data. The
      // public RPC must not trust it even after clients can no longer create it.
      const slotColumn = column === 'next_match_id' ? 'next_slot' : 'loser_next_slot'
      await ctx.db.query(`update matches set ${column} = $1, ${slotColumn} = 'A' where id = $2`, [foreign.first.id, own.first.id])
      const [sql, params] = sport === 'tennis'
        ? ['select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [own.first.id, winningSets]]
        : ['select update_football_result($1,2,0,null,null,(select score_revision from matches where id=$1))', [own.first.id]]
      await assertDeniedUnchanged(ctx, 'owner', sql, params, /tournament/i)
    }
  }
})

test('result correction cannot clear a legacy foreign downstream match or its sets', async () => {
  const own = await bracket()
  const foreign = await bracket({ owner: 'outsider' })
  await asActor(ctx, 'owner', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [own.first.id, winningSets])
  await asActor(ctx, 'outsider', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [foreign.first.id, winningSets])
  await ctx.db.query("update matches set next_match_id = $1, next_slot = 'A' where id = $2", [foreign.first.id, own.first.id])
  await assertDeniedUnchanged(ctx, 'editor', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [own.first.id, reverseWinningSets], /tournament/i)
})

test('a counter cannot finish a live match through a legacy foreign graph edge', async () => {
  const own = await bracket()
  const foreign = await bracket({ owner: 'outsider' })
  await asActor(ctx, 'counter', 'select start_live_match($1,(select score_revision from matches where id=$1))', [own.first.id])
  // Reach match point through the real RPC so the failure checks rollback of
  // live state, revision, match sets, winner assignment, and propagation.
  for (let point = 0; point < 47; point++) {
    await asActor(ctx, 'counter', "select record_point($1,'a',(select revision from live_scores where match_id=$1))", [own.first.id])
  }
  await ctx.db.query("update matches set loser_next_match_id = $1, loser_next_slot = 'A' where id = $2", [foreign.first.id, own.first.id])
  await assertDeniedUnchanged(ctx, 'counter', "select record_point($1, 'a', 47)", [own.first.id], /tournament/i)
})
