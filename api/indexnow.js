// Daily Vercel Cron (vercel.json "crons"): pings IndexNow with public tournaments and blog pages
// changed in the last 25 hours. Vercel sends `Authorization: Bearer $CRON_SECRET`; without the
// secret it does nothing. A full resubmit is `npm run indexnow` (scripts/indexnow.mjs).
import { timingSafeEqual } from 'node:crypto'
import { isProductionEnv, siteOrigin } from '../src/lib/seo.js'
import { collectUrls, submitUrls } from './_indexnow.js'

const WINDOW_MS = 25 * 60 * 60 * 1000

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

function authorized(request, secret) {
  if (!secret) return false
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export async function GET(request) {
  if (!authorized(request, process.env.CRON_SECRET)) return json({ error: 'unauthorized' }, 401)
  if (!isProductionEnv(process.env)) return json({ skipped: 'not production' })
  const origin = siteOrigin(process.env, request)
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString()
    const urls = await collectUrls({ env: process.env, origin, since })
    return json({ since, ...(await submitUrls({ origin, urls })) })
  } catch (error) {
    return json({ error: String(error?.message ?? error) }, 502)
  }
}
