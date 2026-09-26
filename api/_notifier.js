// One sender run: claim due outbox rows (service role), send each through Resend, record the result.
import { normalizeOrigin } from '../src/lib/seo.js'
import { buildEmail } from './_email.js'

const REQUIRED = ['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'EMAIL_FROM']

export function missingConfig(env) {
  return REQUIRED.filter(name => !String(env[name] ?? '').trim())
}

// Legacy service_role keys are JWTs (sent as Bearer too); new sb_secret_ keys go in apikey only.
function supabaseHeaders(key) {
  const headers = { apikey: key, 'Content-Type': 'application/json' }
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  return headers
}

async function rpc(env, fetchImpl, name, args) {
  const response = await fetchImpl(new URL(`/rest/v1/rpc/${name}`, normalizeOrigin(env.VITE_SUPABASE_URL)), {
    method: 'POST',
    headers: supabaseHeaders(env.SUPABASE_SERVICE_ROLE_KEY),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

export async function processBatch({ env, origin, fetchImpl = globalThis.fetch, limit = 20 }) {
  const rows = await rpc(env, fetchImpl, 'claim_notifications', { p_limit: limit }) ?? []
  const result = { claimed: rows.length, sent: 0, failed: 0 }
  for (const row of rows) {
    try {
      const email = buildEmail(row, origin)
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          // The outbox id: a retry after a timeout never delivers the same email twice.
          'Idempotency-Key': row.id,
        },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [row.recipient], subject: email.subject, html: email.html, text: email.text, tags: [{ name: 'kind', value: row.kind }] }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error(`Resend HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
      await rpc(env, fetchImpl, 'complete_notification', { p_id: row.id, p_ok: true })
      result.sent++
    } catch (error) {
      result.failed++
      await rpc(env, fetchImpl, 'complete_notification', { p_id: row.id, p_ok: false, p_error: String(error?.message ?? error) }).catch(() => {})
    }
  }
  return result
}
