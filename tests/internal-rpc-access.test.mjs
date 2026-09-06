import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

// Runs the real schema and migration in PostgreSQL WASM. Auth claims, API roles,
// and Supabase's default grants are reproduced locally; HTTP/JWT validation and
// the deployed database/migration history are deliberately outside this test.
const helpers = [
  'public.propagate_winner(uuid,uuid)',
  'public.clear_downstream(uuid,uuid)',
  'public.generate_single_elim(uuid,uuid[],public.match_stage)',
  'public.generate_double_elim(uuid,uuid[])',
  'public.generate_round_robin_matches(uuid,uuid[],public.match_stage,uuid,integer)',
  'public.sync_live_match_sets(uuid,jsonb)',
]
const actors = Object.fromEntries(['owner', 'editor', 'counter', 'outsider'].map(role => [role, randomUUID()]))
let db

before(async () => {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    create publication supabase_realtime;
    alter default privileges in schema public
      grant execute on functions to anon, authenticated, service_role;
    alter default privileges in schema public
      grant select on tables to anon, authenticated;
  `)
  await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'))
  // Default table grants above emulate the API without reopening privileges
  // explicitly restricted by the schema (for example participant contacts).
  for (const [name, id] of Object.entries(actors)) {
    await db.query('insert into auth.users(id, email) values ($1, $2)', [id, `${name}@example.test`])
  }
})

after(async () => { await db?.close() })

async function asActor(actor, sql, params = []) {
  assert.ok(actor === 'anon' || Object.hasOwn(actors, actor))
  const role = actor === 'anon' ? 'anon' : 'authenticated'
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [actors[actor] ?? '', role])
  await db.exec(`set role ${role}`)
  try {
    return await db.query(sql, params)
  } finally {
    await db.exec('reset role')
    await db.exec("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)")
  }
}

async function fixture(format = 'single_elimination', count = 4, sport = 'tennis', isPublic = true) {
  const tournamentId = randomUUID()
  await db.query(`insert into tournaments(id, name, slug, sport, format, category,
    set_format, status, is_public, created_by)
    values ($1::uuid, 'SQL test', $1::uuid::text, $2, $3, 'singles', 'best_of_3', 'in_progress', $4, $5)`,
  [tournamentId, sport, format, isPublic, actors.owner])
  for (const role of ['owner', 'editor', 'counter']) {
    await db.query('insert into tournament_admins(tournament_id, user_id, role) values ($1, $2, $3)', [tournamentId, actors[role], role])
  }
  for (let index = 0; index < count; index += 1) {
    await db.query(`insert into entries(tournament_id, entry_type, display_name, phone_or_email, status, seed_order)
      values ($1, 'singles', $2, $3, 'approved', $4)`, [tournamentId, `Player ${index}`, `player${index}@example.test`, index + 1])
  }
  return tournamentId
}

async function matches(tournamentId) {
  return (await db.query('select * from matches where tournament_id = $1 order by stage, round_number, match_number', [tournamentId])).rows
}

async function match(id) {
  return (await db.query('select * from matches where id = $1', [id])).rows[0]
}

async function saveTennis(actor, id, winner = 'a') {
  const sets = [1, 2].map(set_index => ({ set_index, side_a_games: winner === 'a' ? 6 : 0, side_b_games: winner === 'b' ? 6 : 0 }))
  return asActor(actor, 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [id, JSON.stringify(sets)])
}

async function assertHelpersClosed() {
  for (const signature of helpers) {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await db.query('select has_function_privilege($1, $2, \'EXECUTE\') as allowed', [role, signature])
      assert.equal(rows[0].allowed, false, `${role} can execute ${signature}`)
    }
    const { rows } = await db.query(`select count(*)::integer as grants from pg_proc p,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where p.oid = $1::regprocedure and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'`, [signature])
    assert.equal(rows[0].grants, 0, `PUBLIC can execute ${signature}`)
  }
}

test('fresh schema removes inherited, explicit client, and PUBLIC execution for all six helpers', assertHelpersClosed)

test('owner, editor, counter, outsider, and anon cannot invoke any helper directly', async () => {
  const id = await fixture()
  await asActor('owner', 'select generate_bracket($1)', [id])
  const original = await matches(id)
  const first = original.find(row => row.status === 'ready')
  const entries = [first.side_a_entry_id, first.side_b_entry_id]
  const invocations = [
    ['propagate_winner($1, $2)', [first.id, first.side_a_entry_id]],
    ['clear_downstream($1, $2)', [first.id, first.side_a_entry_id]],
    ["generate_single_elim($1, $2::uuid[], 'main')", [id, entries]],
    ['generate_double_elim($1, $2::uuid[])', [id, entries]],
    ["generate_round_robin_matches($1, $2::uuid[], 'main', null, 0)", [id, entries]],
    ["sync_live_match_sets($1, '{}'::jsonb)", [first.id]],
  ]
  for (const actor of [...Object.keys(actors), 'anon']) {
    for (const [invocation, params] of invocations) {
      await assert.rejects(asActor(actor, `select ${invocation}`, params),
        error => error.code === '42501' && /permission denied for function/.test(error.message), `${actor}: ${invocation}`)
    }
  }
  assert.deepEqual(await matches(id), original)
})

test('owner and editor generate single and double elimination through the public RPC', async () => {
  for (const actor of ['owner', 'editor']) {
    for (const format of ['single_elimination', 'double_elimination']) {
      const id = await fixture(format)
      await asActor(actor, 'select generate_bracket($1)', [id])
      const rows = await matches(id)
      assert.equal(rows.length, format === 'single_elimination' ? 3 : 6)
      assert.equal(rows.filter(row => row.status === 'ready').length, 2)
      if (format === 'double_elimination') {
        assert.deepEqual([...new Set(rows.map(row => row.stage))].sort(), ['grand_final', 'losers', 'winners'])
        const first = rows.find(row => row.stage === 'winners' && row.status === 'ready')
        await saveTennis(actor, first.id)
        const winnerSlot = first.next_slot === 'A' ? 'side_a_entry_id' : 'side_b_entry_id'
        const loserSlot = first.loser_next_slot === 'A' ? 'side_a_entry_id' : 'side_b_entry_id'
        assert.equal((await match(first.next_match_id))[winnerSlot], first.side_a_entry_id)
        assert.equal((await match(first.loser_next_match_id))[loserSlot], first.side_b_entry_id)
      }
    }
  }
})

test('round robin and group playoff RPCs retain access to their private generators', async () => {
  for (const actor of ['owner', 'editor']) {
    const rr = await fixture('round_robin')
    await asActor(actor, 'select generate_round_robin($1)', [rr])
    const rounds = await matches(rr)
    assert.equal(rounds.length, 6)
    assert.equal(new Set(rounds.map(row => [row.side_a_entry_id, row.side_b_entry_id].sort().join(':'))).size, 6)

    const groups = await fixture('groups_playoff')
    await asActor(actor, 'select generate_groups($1, 2)', [groups])
    const groupMatches = await matches(groups)
    assert.equal(groupMatches.length, 2)
    for (const row of groupMatches) await saveTennis(actor, row.id)
    await asActor(actor, 'select generate_group_playoff($1)', [groups])
    const playoffs = (await matches(groups)).filter(row => row.stage === 'winners')
    assert.equal(playoffs.length, 3)
    assert.equal(playoffs.filter(row => row.status === 'ready').length, 2)
  }
})

test('tennis correction cannot invalidate a finished downstream match', async () => {
  const id = await fixture()
  await asActor('owner', 'select generate_bracket($1)', [id])
  const semifinals = (await matches(id)).filter(row => row.round_number === 1)
  for (const row of semifinals) await saveTennis('owner', row.id)
  const finalId = semifinals[0].next_match_id
  await saveTennis('editor', finalId)
  assert.equal((await match(finalId)).status, 'finished')

  const before=await matches(id)
  await assert.rejects(saveTennis('editor', semifinals[0].id, 'b'),/downstreamStarted/)
  assert.deepEqual(await matches(id),before)
})

test('football saves and corrections retain winner propagation and downstream clearing', async () => {
  const id = await fixture('single_elimination', 4, 'football')
  await asActor('owner', 'select generate_bracket($1)', [id])
  const first = (await matches(id)).find(row => row.round_number === 1)
  await asActor('owner', 'select update_football_result($1,2,0,null,null,(select score_revision from matches where id=$1))', [first.id])
  const slot = first.next_slot === 'A' ? 'side_a_entry_id' : 'side_b_entry_id'
  assert.equal((await match(first.next_match_id))[slot], first.side_a_entry_id)
  await asActor('editor', 'select update_football_result($1,0,2,null,null,(select score_revision from matches where id=$1))', [first.id])
  assert.equal((await match(first.next_match_id))[slot], first.side_b_entry_id)
})

test('counter live scoring can still synchronize sets, undo a game, finish, and propagate a winner', async () => {
  const id = await fixture()
  await asActor('owner', 'select generate_bracket($1)', [id])
  const first = (await matches(id)).find(row => row.round_number === 1)
  await asActor('counter', 'select start_live_match($1,(select score_revision from matches where id=$1))', [first.id])
  for (let point = 0; point < 4; point += 1) {
    await asActor('counter', "select record_point($1,'a',(select revision from live_scores where match_id=$1))", [first.id])
  }
  assert.equal((await db.query('select side_a_games from match_sets where match_id = $1', [first.id])).rows[0].side_a_games, 1)
  await asActor('counter', "select record_point($1,'undo',(select revision from live_scores where match_id=$1))", [first.id])
  assert.equal((await db.query('select count(*)::integer as count from match_sets where match_id = $1', [first.id])).rows[0].count, 0)
  // A straight-sets win is 48 points; after undo there are three recorded points.
  for (let point = 3; point < 48; point += 1) {
    await asActor('counter', "select record_point($1,'a',(select revision from live_scores where match_id=$1))", [first.id])
  }
  assert.equal((await match(first.id)).winner_entry_id, first.side_a_entry_id)
  const slot = first.next_slot === 'A' ? 'side_a_entry_id' : 'side_b_entry_id'
  assert.equal((await match(first.next_match_id))[slot], first.side_a_entry_id)
  assert.deepEqual((await db.query('select side_a_games, side_b_games from match_sets where match_id = $1 order by set_index', [first.id])).rows,
    [{ side_a_games: 6, side_b_games: 0 }, { side_a_games: 6, side_b_games: 0 }])
})

test('counter, outsider, and anon are refused by tournament-management RPCs without changing matches', async () => {
  const id = await fixture()
  await asActor('owner', 'select generate_bracket($1)', [id])
  const original = await matches(id)
  for (const actor of ['counter', 'outsider', 'anon']) {
    for (const fn of ['generate_bracket', 'rebuild_bracket', 'generate_round_robin', 'generate_groups', 'generate_group_playoff']) {
      await assert.rejects(asActor(actor, `select ${fn}($1)`, [id]), /Not allowed|permission denied/, `${actor}: ${fn}`)
    }
    await assert.rejects(saveTennis(actor, original[0].id), /Not allowed|permission denied/)
    await assert.rejects(asActor(actor, 'select update_football_result($1,1,0,null,null,(select score_revision from matches where id=$1))', [original[0].id]), /Not allowed|permission denied/)
  }
  for (const actor of ['outsider', 'anon']) {
    await assert.rejects(asActor(actor, 'select start_live_match($1,(select score_revision from matches where id=$1))', [original[0].id]), /Not allowed|permission denied/)
    await assert.rejects(asActor(actor, "select record_point($1,'a',(select revision from live_scores where match_id=$1))", [original[0].id]), /Not allowed|permission denied/)
  }
  assert.deepEqual(await matches(id), original)
})

test('RLS helpers continue supporting public reads and authorized private tournament reads', async () => {
  const publicId = await fixture()
  const privateId = await fixture('single_elimination', 4, 'tennis', false)
  assert.equal((await asActor('anon', 'select id from tournaments where id = $1', [publicId])).rows.length, 1)
  for (const actor of ['owner', 'editor', 'counter']) {
    assert.equal((await asActor(actor, 'select id from tournaments where id = $1', [privateId])).rows.length, 1)
  }
  for (const actor of ['outsider', 'anon']) {
    assert.equal((await asActor(actor, 'select id from tournaments where id = $1', [privateId])).rows.length, 0)
  }
})

test('the deployment check script reports closed helpers and compatible public RPC owners', async () => {
  const results = await db.exec(await readFile(new URL('../supabase/checks/internal_rpc_access.sql', import.meta.url), 'utf8'))
  assert.equal(results.length, 2)
  assert.equal(results[0].rows.length, 6)
  for (const row of results[0].rows) {
    assert.equal(row.function_exists, true, row.signature)
    assert.equal(row.anon_execute, false, row.signature)
    assert.equal(row.authenticated_execute, false, row.signature)
    assert.equal(row.public_execute, false, row.signature)
  }
  assert.equal(results[1].rows.length, 8)
  for (const row of results[1].rows) {
    assert.equal(row.authenticated_execute, true, row.signature)
    assert.equal(row.security_definer, true, row.signature)
    assert.ok(results[0].rows.every(helper => helper.owner === row.owner), row.signature)
  }
})

test('upgrade revokes old grants, is repeatable, and preserves existing match data', async () => {
  const id = await fixture()
  await asActor('owner', 'select generate_bracket($1)', [id])
  const first = (await matches(id))[0]
  await saveTennis('owner', first.id)
  const beforeMatches = await matches(id)
  const beforeSets = (await db.query('select * from match_sets where match_id = $1 order by set_index', [first.id])).rows
  // Reproduce the vulnerable database's inherited and explicit helper grants.
  for (const signature of helpers.slice(0, 5)) {
    await db.exec(`grant execute on function ${signature} to public, anon, authenticated`)
    assert.equal((await db.query("select has_function_privilege('anon', $1, 'EXECUTE') as allowed", [signature])).rows[0].allowed, true)
  }
  const migration = await readFile(new URL('../supabase/upgrades/20260905194009_restrict_internal_rpc_execution.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(migration)
  await assertHelpersClosed()
  assert.deepEqual(await matches(id), beforeMatches)
  assert.deepEqual((await db.query('select * from match_sets where match_id = $1 order by set_index', [first.id])).rows, beforeSets)
  // Verify the upgrade still permits a parent RPC to call the now-private helper.
  await saveTennis('editor', first.id, 'b')
  assert.equal((await match(first.id)).winner_entry_id, first.side_b_entry_id)
})
