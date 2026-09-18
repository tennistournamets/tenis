import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, snapshot, assertDeniedUnchanged, reapplyForwardMigrations, winningSets } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])
const row = async id => (await ctx.db.query('select is_public, visibility, settings_revision from tournaments where id=$1', [id])).rows[0]
const roles = async t => Object.fromEntries((await ctx.db.query('select user_id, role from tournament_admins where tournament_id=$1', [t.id])).rows.map(r => [r.user_id, r.role]))
const addByEmail = (t, actor, who, role) => asActor(ctx, actor, 'select add_tournament_admin_by_email($1,$2,$3)', [t.id, `${who}@example.test`, role])
const membership = async (t, who) => (await ctx.db.query('select id from tournament_admins where tournament_id=$1 and user_id=$2', [t.id, ctx.actors[who]])).rows[0]?.id
const sync = async (t, actor) => (await asActor(ctx, actor, 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s

test('roles are validated; only owners grant ownership or change an owner, the last owner cannot be demoted or removed', async () => {
  const t = await fixture(ctx)
  for (const bad of ['admin', 'viewer', '', null]) {
    await assertDeniedUnchanged(ctx, 'owner', 'select add_tournament_admin_by_email($1,$2,$3)', [t.id, 'outsider@example.test', bad], /access\.invalidRole/)
  }
  await assertDeniedUnchanged(ctx, 'editor', 'select add_tournament_admin_by_email($1,$2,$3)', [t.id, 'outsider@example.test', 'owner'], /access\.ownerOnly/)
  await assertDeniedUnchanged(ctx, 'editor', 'select add_tournament_admin_by_email($1,$2,$3)', [t.id, 'owner@example.test', 'editor'], /access\.ownerOnly/)
  await assertDeniedUnchanged(ctx, 'editor', 'select remove_tournament_admin($1,$2)', [t.id, await membership(t, 'owner')], /access\.ownerOnly/)
  await assertDeniedUnchanged(ctx, 'owner', 'select add_tournament_admin_by_email($1,$2,$3)', [t.id, 'owner@example.test', 'editor'], /access\.lastOwner/)
  await assertDeniedUnchanged(ctx, 'owner', 'select remove_tournament_admin($1,$2)', [t.id, await membership(t, 'owner')], /access\.lastOwner/)
  // A second owner unlocks demotion and removal of the first one.
  await addByEmail(t, 'owner', 'outsider', 'owner')
  assert.equal((await roles(t))[ctx.actors.outsider], 'owner')
  await asActor(ctx, 'outsider', 'select add_tournament_admin_by_email($1,$2,$3)', [t.id, 'owner@example.test', 'editor'])
  assert.equal((await roles(t))[ctx.actors.owner], 'editor')
  await assertDeniedUnchanged(ctx, 'outsider', 'select remove_tournament_admin($1,$2)', [t.id, await membership(t, 'outsider')], /access\.lastOwner/)
  await asActor(ctx, 'outsider', 'select remove_tournament_admin($1,$2)', [t.id, await membership(t, 'owner')])
  assert.equal((await roles(t))[ctx.actors.owner], undefined)
  // Editors still manage editors and counters.
  await addByEmail(t, 'editor', 'platform_admin', 'counter')
  assert.equal((await roles(t))[ctx.actors.platform_admin], 'counter')
  await asActor(ctx, 'editor', 'select remove_tournament_admin($1,$2)', [t.id, await membership(t, 'platform_admin')])
  assert.equal((await roles(t))[ctx.actors.platform_admin], undefined)
  await assertDeniedUnchanged(ctx, 'counter', 'select add_tournament_admin_by_email($1,$2,$3)', [t.id, 'outsider@example.test', 'counter'])
})

test('membership rows cannot be written directly by API roles any more', async () => {
  const t = await fixture(ctx)
  for (const actor of ['owner', 'editor', 'counter', 'outsider', 'platform_admin', 'anon']) {
    await assertDeniedUnchanged(ctx, actor, "insert into tournament_admins(tournament_id,user_id,role) values ($1,$2,'editor') returning id", [t.id, ctx.actors.outsider], /permission denied/)
    await assertDeniedUnchanged(ctx, actor, 'delete from tournament_admins where tournament_id=$1 returning id', [t.id], /permission denied/)
    await assertDeniedUnchanged(ctx, actor, "update tournament_admins set role='owner' where tournament_id=$1 returning id", [t.id], /permission denied/)
  }
  assert.equal((await asActor(ctx, 'counter', 'select role from tournament_admins where tournament_id=$1', [t.id])).rows.length, 1)
})

test('the results role stops its live match and corrects a saved result through the preview flow', async () => {
  const t = await fixture(ctx)
  await asActor(ctx, 'owner', 'select generate_bracket($1)', [t.id])
  const m = (await matches(ctx, t.id)).find(x => x.status === 'ready')
  await asActor(ctx, 'counter', 'select start_live_match($1,$2)', [m.id, m.score_revision])
  await asActor(ctx, 'counter', "select record_point($1,'a',(select revision from live_scores where match_id=$1))", [m.id])
  await asActor(ctx, 'counter', 'select stop_live_match($1,(select revision from live_scores where match_id=$1))', [m.id])
  assert.equal((await ctx.db.query('select status from live_scores where match_id=$1', [m.id])).rows[0].status, 'stopped')
  await asActor(ctx, 'counter', 'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))', [m.id, winningSets])
  const saved = (await ctx.db.query('select winner_entry_id, score_revision from matches where id=$1', [m.id])).rows[0]
  assert.equal(saved.winner_entry_id, m.side_a_entry_id)
  const reversed = JSON.stringify({ sets: JSON.parse(winningSets).map(s => ({ ...s, side_a_games: s.side_b_games, side_b_games: s.side_a_games })) })
  const preview = (await asActor(ctx, 'counter', 'select get_match_correction_preview($1,$2::jsonb,$3) p', [m.id, reversed, saved.score_revision])).rows[0].p
  assert.ok(preview.token)
  await asActor(ctx, 'counter', 'select apply_match_correction($1,$2::jsonb,$3,$4)', [m.id, reversed, saved.score_revision, preview.token])
  assert.equal((await ctx.db.query('select winner_entry_id from matches where id=$1', [m.id])).rows[0].winner_entry_id, m.side_b_entry_id)
  for (const actor of ['outsider', 'platform_admin', 'anon']) {
    await assertDeniedUnchanged(ctx, actor, 'select get_match_correction_preview($1,$2::jsonb,(select score_revision from matches where id=$1))', [m.id, JSON.stringify({ sets: JSON.parse(winningSets) })])
  }
})

test('visibility has three modes, is_public follows it, and older is_public writes still pick a mode', async () => {
  const open = await fixture(ctx, { isPublic: true })
  const hidden = await fixture(ctx, { isPublic: false })
  assert.deepEqual([(await row(open.id)).visibility, (await row(hidden.id)).visibility], ['link', 'private'])
  await settings(open, { visibility: 'public' })
  assert.deepEqual([(await row(open.id)).visibility, (await row(open.id)).is_public], ['public', true])
  assert.equal((await sync(open, 'anon')).tournament.visibility, 'public')
  await settings(open, { visibility: 'private' })
  assert.deepEqual([(await row(open.id)).visibility, (await row(open.id)).is_public], ['private', false])
  assert.equal(await sync(open, 'anon'), null)
  // An older client toggles is_public only: private → link, never straight to public.
  await settings(open, { is_public: true })
  assert.deepEqual([(await row(open.id)).visibility, (await row(open.id)).is_public], ['link', true])
  await settings(open, { visibility: 'public' })
  await settings(open, { is_public: false })
  assert.equal((await row(open.id)).visibility, 'private')
  await settings(open, { is_public: true })
  assert.equal((await row(open.id)).visibility, 'link')
  for (const bad of [{ visibility: 'secret' }, { visibility: null }, { visibility: 'PUBLIC' }]) {
    await assert.rejects(settings(open, bad), /access\.invalidVisibility/)
  }
  // Explicit mode wins when both fields arrive together.
  await settings(open, { visibility: 'public', is_public: false })
  assert.deepEqual([(await row(open.id)).visibility, (await row(open.id)).is_public], ['public', true])
  await assertDeniedUnchanged(ctx, 'counter', 'select update_tournament_settings($1,$2,$3)', [open.id, JSON.stringify({ visibility: 'private' }), await revision(open.id)])
  assert.deepEqual((await asActor(ctx, 'anon', 'select visibility from tournaments where id=$1', [hidden.id])).rows, [])
})

test('the backfill and the trigger survive a replay of the forward chain without touching other rows', async () => {
  const t = await fixture(ctx, { isPublic: true })
  await settings(t, { visibility: 'public' })
  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
  const created = (await asActor(ctx, 'owner', "select create_tournament('Fresh', $1, null, 'tennis', 'single_elimination', 'singles', 'best_of_3', false) id", [`fresh-${Date.now()}`])).rows[0].id
  assert.deepEqual([(await row(created)).visibility, (await row(created)).is_public], ['private', false])
})
