// IndexNow: tells Bing (and through it ChatGPT/Copilot search, Yandex, Seznam…) which URLs changed.
// The key is public by design: search engines fetch it from public/<key>.txt to prove we own the host.
import { LANDING_PATHS, fetchSitemapTournaments } from '../src/lib/seo.js'

export const INDEXNOW_KEY = '80bd7f4d853402c90818859a9ae89c85'
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
const MAX_URLS = 10000

/** <loc>/<lastmod> pairs of a sitemap document (lastmod may be null). */
export function sitemapEntries(xml) {
  return [...String(xml ?? '').matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, body]) => {
    const loc = body.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim().replaceAll('&amp;', '&')
    const lastmod = body.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() ?? null
    return loc ? { loc, lastmod } : null
  }).filter(Boolean)
}

/** Entries whose lastmod is at or after `since` (a date-only lastmod counts from the start of that UTC day). */
export function changedSince(entries, since) {
  const from = Date.parse(since)
  return entries.filter(({ lastmod }) => lastmod && Date.parse(lastmod) >= from - (lastmod.length === 10 ? 86400000 - 1 : 0))
}

async function fetchText(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
    return response.ok ? await response.text() : ''
  } catch {
    return ''
  }
}

/**
 * URLs worth pinging. `since` = null gives every indexable URL (landings, blog, public tournaments);
 * otherwise only public tournaments and blog pages changed since then.
 */
export async function collectUrls({ env, origin, since = null, fetchImpl = globalThis.fetch }) {
  const tournaments = (await fetchSitemapTournaments(env, fetchImpl))
    .filter(row => !since || (row.updated_at && Date.parse(row.updated_at) >= Date.parse(since)))
    .map(row => `${origin}/tournaments/${encodeURIComponent(row.slug)}`)
  const blog = sitemapEntries(await fetchText(`${origin}/blog/sitemap.xml`, fetchImpl))
  const blogUrls = (since ? changedSince(blog, since) : blog).map(entry => entry.loc)
  const landings = since ? [] : Object.values(LANDING_PATHS).map(path => `${origin}${path}`)
  return [...new Set([...landings, ...blogUrls, ...tournaments])].filter(url => url.startsWith(`${origin}/`))
}

/** One IndexNow submission; returns { submitted, status }. 200 and 202 mean accepted. */
export async function submitUrls({ origin, urls, fetchImpl = globalThis.fetch }) {
  const urlList = urls.slice(0, MAX_URLS)
  if (!urlList.length) return { submitted: 0, status: null }
  const response = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(origin).host,
      key: INDEXNOW_KEY,
      keyLocation: `${origin}/${INDEXNOW_KEY}.txt`,
      urlList,
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`IndexNow: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  return { submitted: urlList.length, status: response.status }
}
