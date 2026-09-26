// Email sender, called every minute by pg_cron in Supabase when notifications_due() is true
// (setup: docs/GROWTH.md). Needs NOTIFICATIONS_SECRET, SUPABASE_SERVICE_ROLE_KEY,
// RESEND_API_KEY and EMAIL_FROM; without them it does nothing.
import { timingSafeEqual } from 'node:crypto'
import { siteOrigin } from '../src/lib/seo.js'
import { missingConfig, processBatch } from './_notifier.js'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

function authorized(request, secret) {
  if (!secret) return false
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export async function POST(request) {
  if (!authorized(request, process.env.NOTIFICATIONS_SECRET)) return json({ error: 'unauthorized' }, 401)
  const missing = missingConfig(process.env)
  if (missing.length) return json({ error: 'not configured', missing }, 503)
  try {
    return json(await processBatch({ env: process.env, origin: siteOrigin(process.env, request) }))
  } catch (error) {
    return json({ error: String(error?.message ?? error) }, 502)
  }
}
