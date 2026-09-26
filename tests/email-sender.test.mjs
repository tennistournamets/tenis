import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEmail } from '../api/_email.js'
import { missingConfig, processBatch } from '../api/_notifier.js'

const row = {
  id: '6f1c2c1e-0000-4000-8000-000000000001',
  kind: 'match_reminder',
  locale: 'lt',
  recipient: 'ann@example.test',
  entry_name: 'Ann <b>',
  tournament_name: 'Vilnius Cup',
  tournament_slug: 'vilnius-cup',
  time_zone: 'Europe/Vilnius',
  scheduled_at: '2026-10-12T12:30:00Z',
  court_name: 'Court 2',
  opponent_name: 'Ben',
}

test('emails are localized, escaped and link back with utm tags', () => {
  const lt = buildEmail(row, 'https://bracketa.lt')
  assert.equal(lt.subject, 'Jūsų rungtynės netrukus: Vilnius Cup')
  assert.match(lt.text, /prieš Ben prasideda 15:30, kortas: Court 2/)
  assert.ok(lt.html.includes('Ann &lt;b&gt;'))
  assert.ok(!lt.html.includes('<b>'))
  assert.ok(lt.html.includes('https://bracketa.lt/tournaments/vilnius-cup?utm_source=email&amp;utm_medium=notification&amp;utm_campaign=match_reminder'))
  assert.ok(lt.html.includes('https://bracketa.lt/?utm_source=email'), 'growth link to the Lithuanian landing')

  const ru = buildEmail({ ...row, kind: 'registration_approved', locale: 'ru' }, 'https://bracketa.lt')
  assert.equal(ru.subject, 'Заявка одобрена: Vilnius Cup')
  assert.ok(ru.html.includes('https://bracketa.lt/ru?utm_source=email'))
  const fallback = buildEmail({ ...row, kind: 'registration_received', locale: null }, 'https://b.lt')
  assert.equal(fallback.subject, 'Registracija gauta: Vilnius Cup', 'Lithuanian when the language is unknown')
  assert.throws(() => buildEmail({ ...row, kind: 'spam' }, 'https://b.lt'), /Unknown notification kind/)
})

function fakeServices({ rows, resendStatus = 200 }) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    calls.push({ target, init, body: init.body ? JSON.parse(init.body) : null })
    if (target.endsWith('/rpc/claim_notifications')) return new Response(JSON.stringify(rows))
    if (target.endsWith('/rpc/complete_notification')) return new Response('')
    if (target === 'https://api.resend.com/emails') return new Response('{}', { status: resendStatus })
    throw new Error(`unexpected ${target}`)
  }
  return { calls, fetchImpl }
}

const env = { VITE_SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', RESEND_API_KEY: 're_x', EMAIL_FROM: 'Bracketa <turnyrai@bracketa.lt>' }

test('a batch sends each claimed row once and reports the result back', async () => {
  const { calls, fetchImpl } = fakeServices({ rows: [row] })
  const result = await processBatch({ env, origin: 'https://bracketa.lt', fetchImpl })
  assert.deepEqual(result, { claimed: 1, sent: 1, failed: 0 })
  const send = calls.find(call => call.target === 'https://api.resend.com/emails')
  assert.equal(send.init.headers['Idempotency-Key'], row.id)
  assert.deepEqual(send.body.to, ['ann@example.test'])
  assert.equal(send.body.from, env.EMAIL_FROM)
  const claim = calls.find(call => call.target.endsWith('/rpc/claim_notifications'))
  assert.equal(claim.init.headers.apikey, 'sb_secret_x')
  assert.equal(claim.init.headers.Authorization, undefined, 'new secret keys are not sent as a JWT')
  assert.deepEqual(calls.at(-1).body, { p_id: row.id, p_ok: true })
})

test('a failed delivery goes back to the queue with the error', async () => {
  const { calls, fetchImpl } = fakeServices({ rows: [row], resendStatus: 422 })
  const result = await processBatch({ env: { ...env, SUPABASE_SERVICE_ROLE_KEY: 'eyJlegacy' }, origin: 'https://b.lt', fetchImpl })
  assert.deepEqual(result, { claimed: 1, sent: 0, failed: 1 })
  const done = calls.at(-1)
  assert.equal(done.body.p_ok, false)
  assert.match(done.body.p_error, /Resend HTTP 422/)
  assert.equal(done.init.headers.Authorization, 'Bearer eyJlegacy')
})

test('the sender reports which settings are missing', () => {
  assert.deepEqual(missingConfig({}), ['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'EMAIL_FROM'])
  assert.deepEqual(missingConfig(env), [])
})

test('the endpoint refuses calls without the shared secret', async () => {
  const saved = process.env.NOTIFICATIONS_SECRET
  process.env.NOTIFICATIONS_SECRET = 'cron-secret'
  try {
    const { POST } = await import('../api/notifications.js')
    assert.equal((await POST(new Request('https://b.lt/api/notifications', { method: 'POST' }))).status, 401)
    assert.equal((await POST(new Request('https://b.lt/api/notifications', { method: 'POST', headers: { authorization: 'Bearer wrong' } }))).status, 401)
    const unconfigured = await POST(new Request('https://b.lt/api/notifications', { method: 'POST', headers: { authorization: 'Bearer cron-secret' } }))
    assert.equal(unconfigured.status, 503)
    assert.ok((await unconfigured.json()).missing.includes('RESEND_API_KEY'))
  } finally {
    if (saved === undefined) delete process.env.NOTIFICATIONS_SECRET
    else process.env.NOTIFICATIONS_SECRET = saved
  }
})
