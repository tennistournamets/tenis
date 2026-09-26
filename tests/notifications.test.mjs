import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })

const open = (options = {}) => fixture(ctx, { status: 'registration_open', isPublic: true, count: 0, ...options })

// The app sends its UI language in x-bracketa-locale; PostgREST exposes headers as request.headers.
async function register(t, { email = null, phone = '+37060012345', name = 'Player', headers = null } = {}) {
  await ctx.db.query("select set_config('request.headers', $1, false)", [headers ? JSON.stringify(headers) : ''])
  try {
    return (await asActor(ctx, 'anon', 'select register_entry($1,$2,null,$3,null,null,null,$4,$5) r', [t.id, 'singles', name, phone, email])).rows[0].r
  } finally {
    await ctx.db.query("select set_config('request.headers', '', false)")
  }
}

async function asService(sql, params = []) {
  await ctx.db.exec('set role service_role')
  try { return await ctx.db.query(sql, params) } finally { await ctx.db.exec('reset role') }
}

const outbox = async entryId => (await ctx.db.query('select kind, status, match_id from notification_outbox where entry_id=$1 order by created_at, kind', [entryId])).rows
// Tests share one database: start from an empty queue and no scheduled matches.
const clearOutbox = async () => {
  await ctx.db.query('delete from match_schedule')
  await ctx.db.query('delete from notification_outbox')
}

test('a registration with an email queues "received" and stores the request language', async () => {
  const t = await open()
  const r = await register(t, { email: 'ann@example.test', name: 'Ann', headers: { 'x-bracketa-locale': 'ru', 'accept-language': 'lt-LT' } })
  assert.deepEqual(await outbox(r.id), [{ kind: 'registration_received', status: 'pending', match_id: null }])
  assert.equal((await ctx.db.query('select notify_locale from entries where id=$1', [r.id])).rows[0].notify_locale, 'ru')

  const other = await register(t, { email: 'ben@example.test', phone: '+37060054321', name: 'Ben', headers: { 'accept-language': 'en-GB,en;q=0.9' } })
  assert.equal((await ctx.db.query('select notify_locale from entries where id=$1', [other.id])).rows[0].notify_locale, 'en')
  const plain = await register(t, { email: 'cid@example.test', phone: '+37060011111', name: 'Cid', headers: { 'accept-language': 'de-DE' } })
  assert.equal((await ctx.db.query('select notify_locale from entries where id=$1', [plain.id])).rows[0].notify_locale, null)
})

test('status changes queue approved / rejected / waitlisted once each, and nothing without an email', async () => {
  const t = await open()
  const r = await register(t, { email: 'dan@example.test', name: 'Dan' })
  await asActor(ctx, 'owner', "update entries set status='approved' where id=$1", [r.id])
  await ctx.db.query("update entries set display_name='Dan B' where id=$1", [r.id])
  await asActor(ctx, 'owner', "update entries set status='approved' where id=$1", [r.id])
  assert.deepEqual((await outbox(r.id)).map(row => row.kind), ['registration_received', 'registration_approved'])

  const rejected = await register(t, { email: 'eve@example.test', phone: '+37060022222', name: 'Eve' })
  await asActor(ctx, 'owner', "update entries set status='rejected' where id=$1", [rejected.id])
  assert.deepEqual((await outbox(rejected.id)).map(row => row.kind), ['registration_received', 'registration_rejected'])

  // A phone-only legacy contact has no address to write to.
  const phoneOnly = randomUUID()
  await ctx.db.query("insert into entries(id,tournament_id,entry_type,display_name,phone_or_email,status) values ($1,$2,'singles','Phone','+37060033333','pending')", [phoneOnly, t.id])
  await ctx.db.query("update entries set status='approved' where id=$1", [phoneOnly])
  assert.deepEqual(await outbox(phoneOnly), [])
})

test('a full tournament with a waitlist queues "waitlisted"', async () => {
  const t = await open()
  await ctx.db.query('update tournaments set registration_capacity=1, waitlist_enabled=true where id=$1', [t.id])
  const first = await register(t, { email: 'f1@example.test', phone: '+37060044444', name: 'First' })
  await asActor(ctx, 'owner', "update entries set status='approved' where id=$1", [first.id])
  const second = await register(t, { email: 'f2@example.test', phone: '+37060055555', name: 'Second' })
  assert.equal(second.status, 'waitlisted')
  assert.deepEqual((await outbox(second.id)).map(row => row.kind), ['registration_waitlisted'])
})

async function scheduledMatch({ minutesAhead = 20, timeKind = 'fixed', state = 'published', tournamentStatus = 'in_progress' } = {}) {
  const t = await fixture(ctx, { count: 2, status: tournamentStatus })
  await ctx.db.query("update entries set contact_email = replace(display_name, ' ', '') || '@mail.test' where tournament_id=$1", [t.id])
  const matchId = randomUUID()
  await ctx.db.query("insert into matches(id,tournament_id,round_number,match_number,side_a_entry_id,side_b_entry_id,status) values ($1,$2,1,1,$3,$4,'ready')", [matchId, t.id, t.entries[0], t.entries[1]])
  const courtId = randomUUID()
  await ctx.db.query("insert into courts(id,tournament_id,name) values ($1,$2,'Court 2')", [courtId, t.id])
  await ctx.db.query("insert into match_schedule(tournament_id,match_id,state,court_id,scheduled_at,time_kind) values ($1,$2,$3,$4, now() + make_interval(mins => $5), $6)", [t.id, matchId, state, courtId, minutesAhead, timeKind])
  await ctx.db.query("update tournaments set schedule_config = '{\"timezone\":\"Europe/Vilnius\"}' where id=$1", [t.id])
  // Fixture entries start approved; their "approved" emails belong to an earlier day.
  await ctx.db.query('delete from notification_outbox where tournament_id=$1', [t.id])
  return { ...t, matchId }
}

test('reminders: only fixed published times within 35 minutes of a live tournament, once per side', async () => {
  await clearOutbox()
  const due = await scheduledMatch({ minutesAhead: 20 })
  await scheduledMatch({ minutesAhead: 90 })
  await scheduledMatch({ minutesAhead: 20, timeKind: 'not_before' })
  await scheduledMatch({ minutesAhead: 20, state: 'draft' })
  await scheduledMatch({ minutesAhead: 20, tournamentStatus: 'registration_closed' })
  assert.equal((await asService('select notifications_due() d')).rows[0].d, true)
  assert.equal((await ctx.db.query('select enqueue_match_reminders() n')).rows[0].n, 2)
  assert.equal((await ctx.db.query('select enqueue_match_reminders() n')).rows[0].n, 0, 'no duplicates')
  const rows = (await ctx.db.query("select entry_id, match_id from notification_outbox where kind='match_reminder'")).rows
  assert.deepEqual(rows.map(row => row.match_id), [due.matchId, due.matchId])
  assert.deepEqual(rows.map(row => row.entry_id).sort(), [...due.entries].sort())
})

test('claim hands out due rows with names, court and time, then completion marks them sent or retries', async () => {
  await clearOutbox()
  const match = await scheduledMatch({ minutesAhead: 25 })
  const claimed = (await asService('select * from claim_notifications(10) order by recipient')).rows
  assert.equal(claimed.length, 2)
  const [a] = claimed
  assert.equal(a.kind, 'match_reminder')
  assert.equal(a.recipient, 'player0@mail.test')
  assert.equal(a.entry_name, 'Player 0')
  assert.equal(a.opponent_name, 'Player 1')
  assert.equal(a.court_name, 'Court 2')
  assert.equal(a.time_zone, 'Europe/Vilnius')
  assert.equal(a.tournament_slug, match.id)
  assert.equal(a.locale, 'lt', 'Lithuanian when the language is unknown')
  assert.ok(a.scheduled_at instanceof Date)
  assert.equal((await asService('select count(*)::int n from claim_notifications(10)')).rows[0].n, 0, 'sending rows are not handed out twice')

  await asService('select complete_notification($1, true)', [claimed[0].id])
  await asService('select complete_notification($1, false, $2)', [claimed[1].id, 'Resend 500'])
  const states = Object.fromEntries((await ctx.db.query('select id, status, attempts, last_error, sent_at, send_after > now() later from notification_outbox')).rows.map(row => [row.id, row]))
  assert.equal(states[claimed[0].id].status, 'sent')
  assert.ok(states[claimed[0].id].sent_at)
  assert.equal(states[claimed[1].id].status, 'pending')
  assert.equal(states[claimed[1].id].last_error, 'Resend 500')
  assert.equal(states[claimed[1].id].later, true, 'retried later')

  await ctx.db.query("update notification_outbox set attempts=5, status='sending' where id=$1", [claimed[1].id])
  await asService('select complete_notification($1, false, $2)', [claimed[1].id, 'bounce'])
  assert.equal((await ctx.db.query('select status from notification_outbox where id=$1', [claimed[1].id])).rows[0].status, 'failed')
})

test('a reminder for a finished match is skipped, and a stuck "sending" row comes back', async () => {
  await clearOutbox()
  const match = await scheduledMatch({ minutesAhead: 15 })
  await ctx.db.query('select enqueue_match_reminders()')
  await ctx.db.query("update matches set status='finished' where id=$1", [match.matchId])
  assert.equal((await asService('select count(*)::int n from claim_notifications(10)')).rows[0].n, 0)
  assert.deepEqual((await ctx.db.query("select distinct status from notification_outbox where match_id=$1", [match.matchId])).rows, [{ status: 'skipped' }])

  const t = await open()
  const r = await register(t, { email: 'stuck@example.test', phone: '+37060066666', name: 'Stuck' })
  await ctx.db.query("update notification_outbox set status='sending', claimed_at=now() - interval '11 minutes' where entry_id=$1", [r.id])
  const again = (await asService('select entry_name from claim_notifications(10)')).rows
  assert.deepEqual(again.map(row => row.entry_name), ['Stuck'])
})

test('the outbox and the sender functions are closed to the public API', async () => {
  for (const actor of ['anon', 'owner']) {
    await assert.rejects(asActor(ctx, actor, 'select * from notification_outbox'), /permission denied/)
    await assert.rejects(asActor(ctx, actor, 'select * from claim_notifications(1)'), /permission denied/)
    await assert.rejects(asActor(ctx, actor, "select complete_notification(gen_random_uuid(), true)"), /permission denied/)
    await assert.rejects(asActor(ctx, actor, 'select notifications_due()'), /permission denied/)
    await assert.rejects(asActor(ctx, actor, 'select enqueue_match_reminders()'), /permission denied/)
    await assert.rejects(asActor(ctx, actor, "insert into notification_outbox(kind,tournament_id,entry_id) values ('registration_received',gen_random_uuid(),gen_random_uuid())"), /permission denied/)
  }
  // The address never reaches the public entry projection.
  await assert.rejects(asActor(ctx, 'anon', 'select notify_locale from entries limit 1'), /permission denied/)
})

test('an organizer adding an entry directly still gets it queued, and deleting the entry clears its queue', async () => {
  const t = await open()
  const id = randomUUID()
  await asActor(ctx, 'owner', "insert into entries(id,tournament_id,entry_type,display_name,phone_or_email,contact_email,status) values ($1,$2,'singles','Direct','direct@example.test','direct@example.test','approved')", [id, t.id])
  assert.deepEqual((await outbox(id)).map(row => row.kind), ['registration_approved'])
  await ctx.db.query('delete from entries where id=$1', [id])
  assert.deepEqual(await outbox(id), [])
})

test('the forward migrations replay cleanly with the outbox in place', async () => {
  await reapplyForwardMigrations(ctx)
  assert.equal((await ctx.db.query("select count(*)::int n from pg_trigger where tgname in ('trg_entries_notify_locale','trg_entries_queue_notification')")).rows[0].n, 2)
})
