import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { INDEXNOW_ENDPOINT, INDEXNOW_KEY, changedSince, collectUrls, sitemapEntries, submitUrls } from '../api/_indexnow.js'
import { GET } from '../api/indexnow.js'
import { LANDING_PATHS } from '../src/lib/seo.js'

const origin = 'https://braketa.top'
const env = { VITE_SUPABASE_URL: 'https://db.example.test', VITE_SUPABASE_ANON_KEY: 'anon' }

const blogXml = `<?xml version="1.0"?><urlset>
  <url><loc>${origin}/blog</loc><xhtml:link rel="alternate" hreflang="lt" href="${origin}/blog"/></url>
  <url><loc>${origin}/blog/americano?a=1&amp;b=2</loc><lastmod>2026-09-30</lastmod></url>
  <url><loc>${origin}/ru/blog/old</loc><lastmod>2026-08-01</lastmod></url>
</urlset>`

function fakeFetch({ tournaments = [], blog = blogXml, indexnowStatus = 202 } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ href, init })
    if (href.startsWith('https://db.example.test/rest/v1/tournaments')) return new Response(JSON.stringify(tournaments))
    if (href === `${origin}/blog/sitemap.xml`) return new Response(blog)
    if (href === INDEXNOW_ENDPOINT) return new Response('', { status: indexnowStatus })
    return new Response('not found', { status: 404 })
  }
  return { impl, calls }
}

test('the key file is published at the site root and matches the key', () => {
  assert.match(INDEXNOW_KEY, /^[a-f0-9]{32}$/)
  assert.equal(readFileSync(new URL(`../public/${INDEXNOW_KEY}.txt`, import.meta.url), 'utf8').trim(), INDEXNOW_KEY)
})

test('the daily cron is wired in vercel.json', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.deepEqual(vercel.crons.map(cron => cron.path), ['/api/indexnow'])
})

test('sitemap entries: loc unescaped, lastmod optional', () => {
  assert.deepEqual(sitemapEntries(blogXml), [
    { loc: `${origin}/blog`, lastmod: null },
    { loc: `${origin}/blog/americano?a=1&b=2`, lastmod: '2026-09-30' },
    { loc: `${origin}/ru/blog/old`, lastmod: '2026-08-01' },
  ])
})

test('changedSince keeps a date-only lastmod for the whole UTC day', () => {
  const entries = sitemapEntries(blogXml)
  assert.deepEqual(changedSince(entries, '2026-09-30T20:00:00Z').map(e => e.lastmod), ['2026-09-30'])
  assert.deepEqual(changedSince(entries, '2026-10-01T00:00:00Z'), [])
})

test('full collection: landings, blog and public tournaments, no duplicates', async () => {
  const { impl } = fakeFetch({ tournaments: [{ slug: 'vilnius cup', updated_at: '2026-01-01T00:00:00Z' }] })
  const urls = await collectUrls({ env, origin, fetchImpl: impl })
  assert.deepEqual(urls, [
    ...Object.values(LANDING_PATHS).map(path => `${origin}${path}`),
    `${origin}/blog`, `${origin}/blog/americano?a=1&b=2`, `${origin}/ru/blog/old`,
    `${origin}/tournaments/vilnius%20cup`,
  ])
})

test('incremental collection: only what changed since the given time', async () => {
  const { impl } = fakeFetch({ tournaments: [
    { slug: 'new-cup', updated_at: '2026-09-30T21:00:00Z' },
    { slug: 'old-cup', updated_at: '2026-09-01T21:00:00Z' },
    { slug: 'no-date', updated_at: null },
  ] })
  const urls = await collectUrls({ env, origin, since: '2026-09-30T05:00:00Z', fetchImpl: impl })
  assert.deepEqual(urls, [`${origin}/blog/americano?a=1&b=2`, `${origin}/tournaments/new-cup`])
})

test('submission payload follows the IndexNow protocol', async () => {
  const { impl, calls } = fakeFetch()
  assert.deepEqual(await submitUrls({ origin, urls: [`${origin}/`], fetchImpl: impl }), { submitted: 1, status: 202 })
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body, { host: 'braketa.top', key: INDEXNOW_KEY, keyLocation: `${origin}/${INDEXNOW_KEY}.txt`, urlList: [`${origin}/`] })

  assert.deepEqual(await submitUrls({ origin, urls: [], fetchImpl: impl }), { submitted: 0, status: null })
  await assert.rejects(submitUrls({ origin, urls: [`${origin}/`], fetchImpl: fakeFetch({ indexnowStatus: 403 }).impl }), /HTTP 403/)
})

test('cron endpoint requires CRON_SECRET', async () => {
  const saved = process.env.CRON_SECRET
  try {
    delete process.env.CRON_SECRET
    assert.equal((await GET(new Request(`${origin}/api/indexnow`))).status, 401)
    process.env.CRON_SECRET = 'secret'
    assert.equal((await GET(new Request(`${origin}/api/indexnow`, { headers: { authorization: 'Bearer wrong!' } }))).status, 401)
  } finally {
    if (saved === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = saved
  }
})
