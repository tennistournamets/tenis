import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, snapshot, assertDeniedUnchanged, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const revision = async id => (await ctx.db.query('select settings_revision from tournaments where id=$1', [id])).rows[0].settings_revision
const settings = async (t, patch, actor = 'owner') =>
  asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3) v', [t.id, JSON.stringify(patch), await revision(t.id)])
const setPassword = async (t, password, actor = 'owner') =>
  (await asActor(ctx, actor, 'select set_tournament_password($1,$2,$3) r', [t.id, password, await revision(t.id)])).rows[0].r
const unlockResult = async (t, password, actor = 'anon') => (await asActor(ctx, actor, 'select unlock_tournament($1,$2) r', [t.id, password])).rows[0].r
const unlock = async (t, password, actor = 'anon') => { const r = await unlockResult(t, password, actor); assert.equal(r.ok, true, r.error); return r }
const unlockFails = async (t, password, code) => { const before = await snapshot(ctx); const r = await unlockResult(t, password); assert.equal(r.ok, false); assert.equal(r.error, code); return before }
const withToken = async (t, token, actor = 'anon') => (await asActor(ctx, actor, 'select get_tournament_sync_state_with_token($1,$2) s', [t.id, token])).rows[0].s
const row = async id => (await ctx.db.query('select visibility, is_public, access_password_hash, access_password_version from tournaments where id=$1', [id])).rows[0]

async function protectedTournament(options = {}) {
  const t = await fixture(ctx, { status: 'registration_open', isPublic: true, ...options })
  await setPassword(t, 'court-2026')
  await settings(t, { visibility: 'password' })
  return t
}

test('password mode needs a stored bcrypt hash; the hash and the flag never reach the public', async () => {
  const t = await fixture(ctx, { isPublic: true })
  await assert.rejects(settings(t, { visibility: 'password' }), /access\.passwordRequired/)
  for (const bad of ['abc', 'x'.repeat(73)]) await assert.rejects(setPassword(t, bad), /access\.passwordTooShort/)
  for (const actor of ['counter', 'outsider', 'platform_admin', 'anon']) {
    await assertDeniedUnchanged(ctx, actor, 'select set_tournament_password($1,$2,$3)', [t.id, 'court-2026', await revision(t.id)])
  }
  const set = await setPassword(t, 'court-2026', 'editor')
  assert.equal(set.password_set, true)
  const stored = await row(t.id)
  assert.match(stored.access_password_hash, /^\$2a\$10\$/)
  assert.equal(stored.access_password_version, 1)
  await settings(t, { visibility: 'password' })
  assert.deepEqual([(await row(t.id)).visibility, (await row(t.id)).is_public], ['password', false])
  assert.equal((await asActor(ctx, 'owner', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s.tournament.access_password_set, true)
  assert.equal((await asActor(ctx, 'anon', 'select tournament_password_set($1) v', [t.id])).rows[0].v, null)
  await assert.rejects(asActor(ctx, 'anon', 'select access_password_hash from tournaments where id=$1', [t.id]), /permission denied/)
  await assert.rejects(asActor(ctx, 'owner', 'select access_password_hash from tournaments where id=$1', [t.id]), /permission denied/)
  await assert.rejects(asActor(ctx, 'anon', 'select * from tournament_access_grants'), /permission denied/)
  // Removing the password while in password mode is refused; switching mode first works.
  await assert.rejects(setPassword(t, null), /access\.passwordRequired/)
  await settings(t, { visibility: 'link' })
  assert.equal((await setPassword(t, '')).password_set, false)
  assert.equal((await row(t.id)).access_password_hash, null)
})

test('anonymous visitors learn only that a slug is password-protected and unlock it with the right password', async () => {
  const t = await protectedTournament()
  const plain = await fixture(ctx, { isPublic: false })
  assert.equal((await asActor(ctx, 'anon', 'select tournament_access_mode($1) m', [t.id])).rows[0].m, 'password')
  assert.equal((await asActor(ctx, 'anon', 'select tournament_access_mode($1) m', [plain.id])).rows[0].m, null)
  assert.equal((await asActor(ctx, 'anon', 'select tournament_access_mode($1) m', ['missing-slug'])).rows[0].m, null)
  assert.deepEqual((await asActor(ctx, 'anon', 'select id from tournaments where id=$1', [t.id])).rows, [])
  assert.equal((await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s, null)
  await unlockFails(plain, 'anything', 'access.noPassword')
  await unlockFails(t, 'wrong', 'access.wrongPassword')
  assert.equal((await ctx.db.query('select failed_count from tournament_unlock_attempts where tournament_id=$1', [t.id])).rows[0].failed_count, 1)
  const grant = await unlock(t, 'court-2026')
  assert.equal(grant.tournament_id, t.id)
  assert.match(grant.token, /^[0-9a-f]{64}$/)
  assert.ok(new Date(grant.expires_at).getTime() > Date.now() + 11 * 3600_000)
  const stored = (await ctx.db.query('select token_hash, password_version from tournament_access_grants where tournament_id=$1', [t.id])).rows
  assert.equal(stored.length, 1)
  assert.notEqual(stored[0].token_hash, grant.token)
  assert.equal(stored[0].password_version, 1)
})

test('the token opens a public projection: approved entries, published schedule, no contacts or drafts', async () => {
  const t = await protectedTournament({ count: 3 })
  await ctx.db.query("update entries set status='pending' where id=$1", [t.entries[2]])
  await ctx.db.query("update tournaments set contact_phone='+37060000000', publish_contact=true where id=$1", [t.id])
  await asActor(ctx, 'owner', "select generate_bracket($1)", [t.id]).catch(() => {})
  const token = (await unlock(t, 'court-2026')).token
  const s = await withToken(t, token)
  assert.equal(s.tournament.id, t.id)
  assert.equal(s.tournament.visibility, 'password')
  assert.deepEqual(s.entries.map(e => e.status), ['approved', 'approved'])
  assert.equal(s.tournament.access_password_set, null)
  assert.equal(s.tournament.contact_phone, null)
  assert.equal(s.tournament.publish_contact, false)
  assert.equal(s.registration.accepting, true)
  assert.ok(!/phone_or_email|@example\.test|\$2a\$/.test(JSON.stringify(s)))
  for (const bad of ['deadbeef', null, '']) {
    await assert.rejects(asActor(ctx, 'anon', 'select get_tournament_sync_state_with_token($1,$2)', [t.id, bad]), /access\.tokenExpired/)
  }
  const other = await protectedTournament()
  await assert.rejects(asActor(ctx, 'anon', 'select get_tournament_sync_state_with_token($1,$2)', [other.id, token]), /access\.tokenExpired/)
  // Registration works with the token and is refused without it.
  const queued = (await asActor(ctx, 'anon', "select register_entry($1,'singles','guest@example.test','Guest',null,null,$2) r", [t.id, token])).rows[0].r
  assert.equal(queued.status, 'pending')
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles','other@example.test','Other')", [t.id], /Tournament is private/)
  await assertDeniedUnchanged(ctx, 'anon', "select register_entry($1,'singles','other@example.test','Other',null,null,'bogus')", [t.id], /Tournament is private/)
})

test('changing the password or the mode revokes every token; expired tokens and lockouts are enforced', async () => {
  const t = await protectedTournament()
  const first = (await unlock(t, 'court-2026')).token
  assert.ok(await withToken(t, first))
  await ctx.db.query("update tournament_access_grants set expires_at=now()-interval '1 minute' where tournament_id=$1", [t.id])
  await assert.rejects(withToken(t, first), /access\.tokenExpired/)
  const second = (await unlock(t, 'court-2026')).token
  assert.equal((await ctx.db.query('select count(*)::int n from tournament_access_grants where tournament_id=$1', [t.id])).rows[0].n, 1)
  await setPassword(t, 'new-secret')
  await assert.rejects(withToken(t, second), /access\.tokenExpired/)
  await unlockFails(t, 'court-2026', 'access.wrongPassword')
  const third = (await unlock(t, 'new-secret')).token
  await settings(t, { visibility: 'link' })
  await assert.rejects(withToken(t, third), /access\.tokenExpired/)
  assert.equal((await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s.tournament.id, t.id)
  await settings(t, { visibility: 'password' })
  for (let i = 0; i < 10; i++) await unlockFails(t, 'nope', 'access.wrongPassword')
  const locked = await unlockResult(t, 'new-secret')
  assert.deepEqual([locked.ok, locked.error], [false, 'access.locked'])
  assert.ok(locked.locked_until)
  await ctx.db.query('update tournament_unlock_attempts set locked_until=now()-interval \'1 second\' where tournament_id=$1', [t.id])
  assert.ok((await unlock(t, 'new-secret')).token)
  assert.equal((await ctx.db.query('select count(*)::int n from tournament_unlock_attempts where tournament_id=$1', [t.id])).rows[0].n, 0)
})

test('older is_public writes keep the password mode hidden; the forward chain replays cleanly', async () => {
  const t = await protectedTournament()
  await settings(t, { is_public: true })
  assert.deepEqual([(await row(t.id)).visibility, (await row(t.id)).is_public], ['link', true])
  await settings(t, { visibility: 'password' })
  // Hiding an already hidden password page changes nothing.
  await settings(t, { is_public: false })
  assert.equal((await row(t.id)).visibility, 'password')
  await settings(t, { is_public: true })
  assert.equal((await row(t.id)).visibility, 'link')
  const before = await snapshot(ctx)
  await reapplyForwardMigrations(ctx)
  assert.deepEqual(await snapshot(ctx), before)
  const labels = (await ctx.db.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='tournaments_visibility_check'")).rows[0].d
  assert.match(labels, /password/)
})
