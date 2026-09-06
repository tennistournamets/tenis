import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, snapshot, assertDeniedUnchanged } from './helpers/database.mjs'

const allActors = ['anon', 'outsider', 'counter', 'editor', 'owner', 'platform_admin']
const managers = ['owner', 'editor']
const nonManagers = ['anon', 'outsider', 'counter', 'platform_admin']
let ctx

before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

async function doublesFixture(options = {}) {
  return fixture(ctx, { category: 'doubles', pairing: 'pick_random', status: 'registration_closed', ...options })
}

test('every authenticated role can create a tournament and becomes its owner; anon cannot', async () => {
  await assertDeniedUnchanged(ctx, 'anon', "select create_tournament('Denied', $1)", [randomUUID()])
  for (const actor of allActors.filter(actor => actor !== 'anon')) {
    const { rows } = await asActor(ctx, actor, "select create_tournament('New tournament', $1) as id", [randomUUID()])
    const created = (await ctx.db.query(`select t.created_by, ta.user_id, ta.role
      from tournaments t join tournament_admins ta on ta.tournament_id=t.id where t.id=$1`, [rows[0].id])).rows
    assert.deepEqual(created, [{ created_by: ctx.actors[actor], user_id: ctx.actors[actor], role: 'owner' }])
  }
})

test('role helpers identify tournament assignment independently from platform administrator status', async () => {
  const tournament = await fixture(ctx)
  for (const actor of allActors) {
    const { rows } = await asActor(ctx, actor, `select
      get_my_tournament_role($1) as role, is_tournament_admin($1) as manager,
      can_live_score($1) as scorer, is_platform_admin() as platform`, [tournament.id])
    assert.deepEqual(rows[0], {
      role: ['owner', 'editor', 'counter'].includes(actor) ? actor : null,
      manager: managers.includes(actor),
      scorer: ['owner', 'editor', 'counter'].includes(actor),
      platform: actor === 'platform_admin',
    }, actor)
    const unknown = (await asActor(ctx, actor, `select get_my_tournament_role(null) as role,
      is_tournament_admin(null) as manager, can_live_score(null) as scorer`)).rows[0]
    assert.deepEqual(unknown, { role: null, manager: false, scorer: false })
  }
})

test('public registration accepts each actor and creates a pending entry with its member', async () => {
  const tournament = await fixture(ctx, { count: 0, isPublic: true, status: 'registration_open' })
  for (const actor of allActors) {
    const contact = `${actor}@registration.example.test`
    const name = `Registered ${actor}`
    const { rows } = await asActor(ctx, actor, "select register_entry($1, 'singles', $2, $3) as id", [tournament.id, contact, name])
    const registered = (await ctx.db.query(`select e.tournament_id, e.status, e.phone_or_email, em.member_name, em.member_order
      from entries e join entry_members em on em.entry_id=e.id where e.id=$1`, [rows[0].id])).rows
    assert.deepEqual(registered, [{ tournament_id: tournament.id, status: 'pending', phone_or_email: contact, member_name: name, member_order: 1 }])
  }
})

test('private and closed registrations reject every role without changing data', async () => {
  for (const options of [
    { isPublic: false, status: 'registration_open' },
    { isPublic: true, status: 'registration_closed' },
  ]) {
    const tournament = await fixture(ctx, { count: 0, ...options })
    for (const actor of allActors) {
      await assertDeniedUnchanged(ctx, actor, "select register_entry($1, 'singles', $2, 'Denied player')",
        [tournament.id, `${actor}@denied.example.test`], /Tournament is private|Registration is closed/)
    }
  }
})

test('owner and editor can form random or manual pairs and split them', async () => {
  for (const actor of managers) {
    for (const mode of ['random', 'manual']) {
      const tournament = await doublesFixture()
      const paired = mode === 'random'
        ? await asActor(ctx, actor, 'select form_random_pairs($1) as count', [tournament.id])
        : await asActor(ctx, actor, 'select form_manual_pairs($1, $2::jsonb) as count', [tournament.id, JSON.stringify([
          tournament.entries.slice(0, 2), tournament.entries.slice(2, 4),
        ])])
      assert.equal(paired.rows[0].count, 2)
      const members = (await ctx.db.query(`select e.id, count(em.id)::integer as members
        from entries e join entry_members em on em.entry_id=e.id where e.tournament_id=$1
        group by e.id`, [tournament.id])).rows
      assert.equal(members.length, 2)
      assert.ok(members.every(entry => entry.members === 2))

      const split = await asActor(ctx, actor, 'select split_pairs($1) as count', [tournament.id])
      assert.equal(split.rows[0].count, 2)
      const singles = (await ctx.db.query(`select e.id, count(em.id)::integer as members
        from entries e join entry_members em on em.entry_id=e.id where e.tournament_id=$1
        group by e.id`, [tournament.id])).rows
      assert.equal(singles.length, 4)
      assert.ok(singles.every(entry => entry.members === 1))
    }
  }
})

test('counter, outsider, anon and unassigned platform admin cannot form or split pairs', async () => {
  const unpaired = await doublesFixture()
  const paired = await doublesFixture()
  await asActor(ctx, 'owner', 'select form_random_pairs($1)', [paired.id])
  for (const actor of nonManagers) {
    await assertDeniedUnchanged(ctx, actor, 'select form_random_pairs($1)', [unpaired.id])
    await assertDeniedUnchanged(ctx, actor, 'select form_manual_pairs($1, $2::jsonb)',
      [unpaired.id, JSON.stringify([unpaired.entries.slice(0, 2)])])
    await assertDeniedUnchanged(ctx, actor, 'select split_pairs($1)', [paired.id])
  }
})

test('manual pairing rejects malformed, null, self-pair, reused and foreign entries atomically', async () => {
  const tournament = await doublesFixture({ count: 6 })
  const foreign = await doublesFixture({ owner: 'outsider', count: 2 })
  const [a, b, c, d] = tournament.entries
  const cases = [
    ['SQL null', undefined],
    ['JSON null', null],
    ['object root', {}],
    ['string root', 'pairs'],
    ['numeric root', 1],
    ['flat UUID list', [a, b]],
    ['object item', [{ 0: a, 1: b }]],
    ['null item', [null]],
    ['empty item', [[]]],
    ['one entry', [[a]]],
    ['three entries', [[a, b, c]]],
    ['null entry', [[a, null]]],
    ['invalid UUID', [[a, 'invalid-uuid']]],
    ['unknown entry', [[a, randomUUID()]]],
    ['self-pair', [[a, a]]],
    ['reused surviving entry', [[a, b], [a, c]]],
    ['reused deleted entry', [[a, b], [b, c]]],
    ['foreign entry', [[a, foreign.entries[0]]]],
    ['valid pair before foreign pair', [[a, b], [c, foreign.entries[0]]]],
    ['valid pair before invalid item', [[a, b], [c, d, null]]],
  ]
  for (const [label, payload] of cases) {
    const before = await snapshot(ctx)
    await assert.rejects(asActor(ctx, 'owner', 'select form_manual_pairs($1, $2::jsonb)',
      [tournament.id, payload === undefined ? null : JSON.stringify(payload)]), undefined, label)
    assert.deepEqual(await snapshot(ctx), before, `${label} changed stored data`)
  }
})

test('manual pairing rejects pending, already-paired and wrong-category entries without partial changes', async () => {
  for (const invalidState of ['pending', 'paired', 'singles']) {
    const tournament = await doublesFixture()
    const [a, b, c, d] = tournament.entries
    if (invalidState === 'pending') await ctx.db.query("update entries set status='pending' where id=$1", [d])
    if (invalidState === 'singles') await ctx.db.query("update entries set entry_type='singles' where id=$1", [d])
    if (invalidState === 'paired') await ctx.db.query("insert into entry_members(entry_id, member_name, member_order) values ($1, 'Partner', 2)", [d])
    await assertDeniedUnchanged(ctx, 'editor', 'select form_manual_pairs($1, $2::jsonb)',
      [tournament.id, JSON.stringify([[a, b], [c, d]])], /./)
  }
})

test('owner and editor retain equivalent administrator management and email-list access', async () => {
  for (const actor of managers) {
    const tournament = await fixture(ctx)
    for (const role of ['counter', 'editor', 'owner']) {
      await asActor(ctx, actor, 'select add_tournament_admin_by_email($1, $2, $3)', [tournament.id, 'outsider@example.test', role])
      const assigned = (await ctx.db.query('select role from tournament_admins where tournament_id=$1 and user_id=$2', [tournament.id, ctx.actors.outsider])).rows
      assert.deepEqual(assigned, [{ role }])
    }
    const listed = (await asActor(ctx, actor, 'select * from get_tournament_admins_with_email($1)', [tournament.id])).rows
    assert.equal(listed.length, 4)
    for (const member of listed) {
      assert.ok(Object.values(ctx.actors).includes(member.user_id))
      assert.equal(member.email, `${Object.keys(ctx.actors).find(name => ctx.actors[name] === member.user_id)}@example.test`)
    }
    const added = listed.find(member => member.user_id === ctx.actors.outsider)
    assert.equal(added.role, 'owner')
    await asActor(ctx, actor, 'select remove_tournament_admin($1, $2)', [tournament.id, added.id])
    assert.equal((await ctx.db.query('select id from tournament_admins where id=$1', [added.id])).rows.length, 0)
    assert.equal((await asActor(ctx, actor, 'select * from get_tournament_admins_with_email($1)', [tournament.id])).rows.length, 3)
  }
})

test('non-managers cannot add/remove administrators or read their emails', async () => {
  const tournament = await fixture(ctx)
  for (const actor of nonManagers) {
    await assertDeniedUnchanged(ctx, actor, 'select add_tournament_admin_by_email($1, $2, $3)',
      [tournament.id, 'platform_admin@example.test', 'owner'])
    await assertDeniedUnchanged(ctx, actor, 'select remove_tournament_admin($1, $2)', [tournament.id, tournament.memberships.owner])
    await assertDeniedUnchanged(ctx, actor, 'select * from get_tournament_admins_with_email($1)', [tournament.id])
  }
})

test('administrator removal cannot remove a membership belonging to another tournament', async () => {
  const local = await fixture(ctx)
  const foreign = await fixture(ctx, { owner: 'outsider' })
  const original = await snapshot(ctx)
  await asActor(ctx, 'editor', 'select remove_tournament_admin($1, $2)', [local.id, foreign.memberships.outsider])
  assert.deepEqual(await snapshot(ctx), original)
})

test('standings are public for public tournaments and limited to assigned roles for private tournaments', async () => {
  for (const isPublic of [true, false]) {
    const tournament = await fixture(ctx, { isPublic })
    for (const actor of allActors) {
      if (isPublic || ['owner', 'editor', 'counter'].includes(actor)) {
        const standings = (await asActor(ctx, actor, 'select * from get_standings($1)', [tournament.id])).rows
        assert.deepEqual(standings.map(row => row.entry_id).sort(), [...tournament.entries].sort())
      } else {
        await assertDeniedUnchanged(ctx, actor, 'select * from get_standings($1)', [tournament.id])
      }
    }
  }
})

test('standings validate the group belongs to the requested tournament', async () => {
  const tournament = await fixture(ctx, { isPublic: true })
  const foreign = await fixture(ctx, { owner: 'outsider' })
  const localGroup = (await ctx.db.query("insert into groups(tournament_id,name,group_index) values ($1,'Local',0) returning id", [tournament.id])).rows[0].id
  const foreignGroup = (await ctx.db.query("insert into groups(tournament_id,name,group_index) values ($1,'Foreign',0) returning id", [foreign.id])).rows[0].id
  await ctx.db.query('insert into group_entries(group_id,entry_id) values ($1,$2)', [localGroup, tournament.entries[0]])
  for (const actor of allActors) {
    const valid = (await asActor(ctx, actor, 'select * from get_standings($1,$2)', [tournament.id, localGroup])).rows
    assert.deepEqual(valid.map(row => row.entry_id), [tournament.entries[0]])
    for (const invalidGroup of [foreignGroup, randomUUID()]) {
      await assertDeniedUnchanged(ctx, actor, 'select * from get_standings($1,$2)', [tournament.id, invalidGroup], /./)
    }
  }
})
