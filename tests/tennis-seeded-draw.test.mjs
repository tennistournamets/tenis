import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const seedCount = size => (size <= 8 ? 2 : size <= 16 ? 4 : size <= 32 ? 8 : 16)
const drawSize = n => 2 ** Math.ceil(Math.log2(n))

// First-round slots in bracket order (null = BYE), read back from the matches.
async function draw(n, { format = 'single_elimination', mode = 'seeded' } = {}) {
  const t = await fixture(ctx, { status: 'registration_closed', count: n, format })
  await asActor(ctx, 'owner', 'select generate_bracket($1,$2)', [t.id, mode])
  const stage = format === 'double_elimination' ? 'winners' : 'main'
  const { rows } = await ctx.db.query(`select side_a_entry_id a, side_b_entry_id b, status, winner_entry_id w
    from matches where tournament_id=$1 and round_number=1 and stage=$2 order by match_number`, [t.id, stage])
  return { t, slots: rows.flatMap(r => [r.a, r.b]), rows, seedOf: id => (id == null ? null : t.entries.indexOf(id) + 1) }
}

for (const n of [2, 3, 5, 8, 11, 12, 16, 17, 24, 32]) {
  test(`${n} entries: seeds on their lines, BYEs to seeds first, everyone placed once`, async () => {
    const { slots, rows, seedOf } = await draw(n)
    const size = drawSize(n)
    const seeds = Math.min(seedCount(size), n)
    const byes = size - n
    const seedAt = slots.map(seedOf)
    const lineOf = k => seedAt.indexOf(k)

    assert.equal(slots.length, size)
    assert.equal(new Set(slots.filter(Boolean)).size, n)
    assert.equal(slots.filter(s => s == null).length, byes)

    assert.equal(lineOf(1), 0, 'seed 1 on the top line')
    if (n >= 2) assert.equal(lineOf(2), size - 1, 'seed 2 on the bottom line')
    // Seeds 1..4 in different quarters, 1..8 in different eighths.
    for (const [count, parts] of [[4, 4], [8, 8], [16, 16]]) {
      if (seeds < count) continue
      const sections = new Set(Array.from({ length: count }, (_, i) => Math.floor(lineOf(i + 1) / (size / parts))))
      assert.equal(sections.size, count, `seeds 1-${count} in different sections`)
    }
    // BYEs opposite the seeds in seed order.
    for (let k = 1; k <= Math.min(byes, seeds); k++) {
      const line = lineOf(k)
      assert.equal(slots[line ^ 1], null, `seed ${k} has a BYE`)
    }
    // Seeds never meet in round 1 (two entries: they play the final).
    if (n > 2) {
      for (let m = 0; m < size / 2; m++) {
        const pair = [seedAt[2 * m], seedAt[2 * m + 1]].filter(k => k != null && k <= seeds)
        assert.ok(pair.length < 2, `match ${m + 1} pairs two seeds`)
      }
    }
    // A BYE match is decided at once and its player moves on.
    for (const r of rows) if (r.a == null || r.b == null) assert.equal(r.status, 'finished')
  })
}

test('the lot changes the unseeded lines and the order of seeds 3-4, never seeds 1-2', async () => {
  const layouts = new Set()
  const thirdLines = new Set()
  for (let i = 0; i < 12; i++) {
    const { slots, seedOf } = await draw(12)
    const seedAt = slots.map(seedOf)
    layouts.add(seedAt.join(','))
    thirdLines.add(seedAt.indexOf(3))
    assert.equal(seedAt.indexOf(1), 0)
    assert.equal(seedAt.indexOf(2), 15)
  }
  assert.ok(layouts.size > 6, `only ${layouts.size} different draws out of 12`)
  assert.equal(thirdLines.size, 2, 'seed 3 lands in either remaining quarter')
})

test('11 entries in 16 lines: 4 seeds get BYEs and the fifth BYE sits on a drawn line', async () => {
  const { slots, seedOf } = await draw(11)
  const seedAt = slots.map(seedOf)
  const byeOpponents = []
  for (let m = 0; m < 8; m++) {
    const [a, b] = [seedAt[2 * m], seedAt[2 * m + 1]]
    if (a == null) byeOpponents.push(b)
    if (b == null) byeOpponents.push(a)
  }
  assert.equal(byeOpponents.length, 5)
  assert.deepEqual(byeOpponents.filter(k => k <= 4).sort(), [1, 2, 3, 4])
  assert.equal(byeOpponents.filter(k => k > 4).length, 1)
})

test('manual stays strict seeding and auto-random stays random', async () => {
  const strict = (await draw(11, { mode: 'manual' })).slots
  const again = (await draw(11, { mode: 'manual' }))
  assert.deepEqual(strict.map((id, i) => id == null), again.slots.map(id => id == null))
  // 1 v BYE, 8 v 9, ... the same lines every time.
  assert.deepEqual(again.slots.map(again.seedOf), [1, null, 8, 9, 4, null, 5, null, 2, null, 7, 10, 3, null, 6, 11])
  const random = await draw(11, { mode: 'auto-random' })
  assert.equal(random.slots.filter(s => s == null).length, 5)
})

test('double elimination with a seeded draw puts the seeds on the same lines', async () => {
  const { slots, seedOf } = await draw(8, { format: 'double_elimination' })
  const seedAt = slots.map(seedOf)
  assert.equal(seedAt.length, 8)
  assert.equal(seedAt.indexOf(1), 0)
  assert.equal(seedAt.indexOf(2), 7)
  assert.equal(new Set(seedAt).size, 8)
})

test('rebuild_bracket takes the seeded mode, and the chain replays', async () => {
  const t = await fixture(ctx, { status: 'registration_closed', count: 6 })
  await asActor(ctx, 'owner', "select generate_bracket($1,'seeded')", [t.id])
  await asActor(ctx, 'owner', "select rebuild_bracket($1,'seeded')", [t.id])
  const { rows } = await ctx.db.query('select count(*)::int n from bracket_versions where tournament_id=$1', [t.id])
  assert.equal(rows[0].n, 1)
  await reapplyForwardMigrations(ctx)
  await asActor(ctx, 'owner', "select rebuild_bracket($1,'seeded')", [t.id])
  await assert.rejects(asActor(ctx, 'outsider', "select generate_bracket($1,'seeded')", [t.id]), /Not allowed/)
})
