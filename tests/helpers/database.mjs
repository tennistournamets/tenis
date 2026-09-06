import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

export async function createEmptyDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(await readFile(new URL('./supabase-bootstrap.sql', import.meta.url), 'utf8'))
  return db
}

export async function installDatabase(db, mode = 'schema') {
  const root = new URL('../../', import.meta.url)
  const release = JSON.parse(await readFile(new URL('supabase/database-release.json', root), 'utf8'))
  const paths = mode === 'fresh' ? [release.baseline.path]
    : mode === 'upgrade' ? [release.upgradeSource.path, ...release.upgrades.map(m => m.path)]
    : mode === 'schema' ? ['supabase/schema.sql'] : null
  assert.ok(paths, `Unknown installation mode: ${mode}`)
  if (mode !== 'schema') paths.push(...release.forwardMigrations.map(m => m.path))
  for (const path of paths) await db.exec(await readFile(new URL(path, root), 'utf8'))
}

export async function createDatabase() {
  const db = await createEmptyDatabase()
  if (process.env.TENIS_TEST_SCHEMA_PATH) await db.exec(await readFile(process.env.TENIS_TEST_SCHEMA_PATH, 'utf8'))
  else await installDatabase(db, process.env.TENIS_TEST_INSTALL_MODE || 'schema')
  if (process.env.TENIS_TEST_MIGRATION_PATH) {
    const migration = await readFile(process.env.TENIS_TEST_MIGRATION_PATH, 'utf8')
    await db.exec(migration)
    await db.exec(migration)
  }
  const actors = {}
  for (const actor of ['owner', 'editor', 'counter', 'outsider', 'platform_admin']) {
    actors[actor] = randomUUID()
    await db.query('insert into auth.users(id,email) values ($1,$2)', [actors[actor], `${actor}@example.test`])
  }
  await db.query('insert into platform_admins(user_id) values ($1)', [actors.platform_admin])
  return { db, actors }
}

export async function asActor(ctx, actor, sql, params = []) {
  assert.ok(actor === 'anon' || Object.hasOwn(ctx.actors, actor))
  const role = actor === 'anon' ? 'anon' : 'authenticated'
  await ctx.db.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role',$2,false)", [ctx.actors[actor] ?? '', role])
  await ctx.db.exec(`set role ${role}`)
  try {
    return await ctx.db.query(sql, params)
  } finally {
    await ctx.db.exec('reset role')
    await ctx.db.exec("select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.role','',false)")
  }
}

export async function fixture(ctx, { count = 4, format = 'single_elimination', sport = 'tennis', category = 'singles', pairing = null, status = 'in_progress', isPublic = false, owner = 'owner', setFormat = 'best_of_3', scoringConfig = {} } = {}) {
  const id = randomUUID()
  await ctx.db.query(`insert into tournaments(id,name,slug,sport,format,category,set_format,status,is_public,created_by,doubles_pairing_mode,scoring_config)
    values ($1,'RPC access test',$1::uuid::text,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [id, sport, format, category, sport === 'football' ? null : setFormat, status, isPublic, ctx.actors[owner], pairing, JSON.stringify(scoringConfig)])
  const memberships = {}
  const roleActors = owner === 'owner' ? ['owner', 'editor', 'counter'] : [owner]
  for (const actor of roleActors) {
    const role = actor === owner ? 'owner' : actor
    const row = (await ctx.db.query('insert into tournament_admins(tournament_id,user_id,role) values ($1,$2,$3) returning id', [id,ctx.actors[actor],role])).rows[0]
    memberships[actor] = row.id
  }
  const entries = []
  for (let index = 0; index < count; index++) {
    const entryId = randomUUID()
    entries.push(entryId)
    await ctx.db.query(`insert into entries(id,tournament_id,entry_type,display_name,phone_or_email,status,seed_order)
      values ($1,$2,$3,$4,$5,'approved',$6)`, [entryId,id,category,`Player ${index}`,`${entryId}@example.test`,index+1])
    await ctx.db.query('insert into entry_members(entry_id,member_name,member_order) values ($1,$2,1)', [entryId,`Player ${index}`])
  }
  return { id, entries, memberships }
}

export async function matches(ctx, tournamentId) {
  return (await ctx.db.query('select * from matches where tournament_id=$1 order by stage,round_number,match_number', [tournamentId])).rows
}

export async function snapshot(ctx) {
  const result = {}
  for (const table of ['tournaments','tournament_admins','entries','entry_members','players','groups','group_entries','matches','match_sets','live_scores','bracket_versions']) {
    result[table] = (await ctx.db.query(`select * from public.${table} order by id`)).rows
  }
  return result
}

export async function assertDeniedUnchanged(ctx, actor, sql, params = [], expected = /Not allowed|Not authorized|permission denied|row-level security|Authentication required/) {
  const before = await snapshot(ctx)
  await assert.rejects(asActor(ctx,actor,sql,params), expected)
  assert.deepEqual(await snapshot(ctx), before)
}

export const winningSets = JSON.stringify([
  { set_index: 1, side_a_games: 6, side_b_games: 0 },
  { set_index: 2, side_a_games: 6, side_b_games: 0 },
])

// Seed a pre-existing partial score for rule-engine tests. This is fixture setup,
// not an authenticated API path; final-only manual behaviour has separate tests.
export async function seedPartialScore(ctx, id, rows) {
  await ctx.db.query('delete from match_sets where match_id=$1',[id])
  for(const r of rows) await ctx.db.query(`insert into match_sets(match_id,set_index,side_a_games,side_b_games,score_kind,side_a_tiebreak,side_b_tiebreak)
    values($1,$2,$3,$4,$5,$6,$7)`,[id,r.set_index,r.side_a_games,r.side_b_games,r.score_kind||'set',r.side_a_tiebreak??null,r.side_b_tiebreak??null])
  const state=(await ctx.db.query(`select tennis_live_state(m.id,tennis_scoring_rules(t.scoring_config),case when t.set_format='best_of_5' then 3 else 2 end) state
    from matches m join tournaments t on t.id=m.tournament_id where m.id=$1`,[id])).rows[0].state
  await ctx.db.query("update matches set side_a_score=$2,side_b_score=$3,winner_entry_id=null,status='ready' where id=$1",[id,state.setsWon.a,state.setsWon.b])
  await ctx.db.query("update live_scores set state=$2,history='[]',status='stopped',revision=revision+1 where match_id=$1",[id,JSON.stringify(state)])
}
