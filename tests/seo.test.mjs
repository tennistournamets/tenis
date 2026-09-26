import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { messages } from './helpers/messages.mjs'
import {
  LABELS, LANDING_PATHS, applyLandingHead, clearLandingHead, escapeHtml, fetchPublicTournament, fetchSitemapTournaments,
  isProductionEnv, landingHead, normalizeOrigin, pickLocale, previewHtml, replaceHeadBlock, robotsTxt, shellHead, siteOrigin,
  sitemapXml, tournamentMeta, formatDateRange, scheduleSpan, jsonLdScript, landingJsonLd, tournamentJsonLd, tournamentImageUrl,
  applyTournamentHead, clearTournamentHead,
} from '../src/lib/seo.js'
import { LOCALES, landingPath } from '../src/lib/localeRoute.js'

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
const botRewrite = vercel.rewrites.find(rule => rule.destination.startsWith('/api/preview'))
const botPattern = new RegExp(`^${botRewrite.has[0].value}$`)

test('landing URLs agree between the SEO helpers and the router', () => {
  assert.deepEqual(Object.keys(LANDING_PATHS), LOCALES)
  for (const locale of LOCALES) assert.equal(LANDING_PATHS[locale], landingPath(locale))
})

test('preview labels match the app translations', () => {
  for (const locale of ['ru', 'en', 'lt']) {
    assert.deepEqual(LABELS[locale].sport, messages[locale].sport, locale)
    assert.deepEqual(LABELS[locale].format, messages[locale].tournamentFormat, locale)
  }
})

test('site origin: SITE_URL, then the Vercel production domain, then the request host', () => {
  assert.equal(normalizeOrigin('bracketa.lt/'), 'https://bracketa.lt')
  assert.equal(normalizeOrigin('not a url'), '')
  assert.equal(siteOrigin({ SITE_URL: 'https://bracketa.lt/', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }), 'https://bracketa.lt')
  assert.equal(siteOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'tenis.vercel.app' }), 'https://tenis.vercel.app')
  const request = new Request('https://internal/api/preview?slug=a', { headers: { 'x-forwarded-host': 'preview.vercel.app' } })
  assert.equal(siteOrigin({}, request), 'https://preview.vercel.app')
  assert.equal(siteOrigin({}), '')
})

test('locale comes from Accept-Language with lt as the default', () => {
  assert.equal(pickLocale('lt-LT,lt;q=0.9,en;q=0.8'), 'lt')
  assert.equal(pickLocale('de-DE,en;q=0.5'), 'en')
  assert.equal(pickLocale('ru-RU,ru;q=0.9'), 'ru')
  assert.equal(pickLocale('de-DE'), 'lt')
  assert.equal(pickLocale(undefined), 'lt')
})

test('tournament meta: name, sport, format, status and venue; unknown row falls back to the site', () => {
  const row = { name: 'Vilnius Open', sport: 'padel', format: 'round_robin', status: 'registration_open', visibility: 'public', venue_address: 'Ozo g. 14', description: 'Weekly   americano' }
  const meta = tournamentMeta(row, { locale: 'ru', origin: 'https://bracketa.lt', slug: 'vilnius-open' })
  assert.equal(meta.title, 'Vilnius Open')
  assert.equal(meta.description, 'Идёт регистрация. Падел · Круговая · Ozo g. 14. Weekly americano')
  assert.equal(meta.url, 'https://bracketa.lt/tournaments/vilnius-open')
  assert.equal(meta.image, 'https://bracketa.lt/api/og?slug=vilnius-open&lang=ru')
  const dated = tournamentMeta({ ...row, starts_at: '2026-10-12T07:00:00Z', ends_at: '2026-10-14T16:00:00Z', updated_at: '2026-09-20T10:00:00Z', schedule_config: { timezone: 'Europe/Vilnius' } }, { locale: 'ru', origin: 'https://bracketa.lt', slug: 'vilnius-open' })
  assert.match(dated.description, /Падел · Круговая · 12–14 октября( 2026 г\.)? · Ozo g\. 14/)
  assert.equal(dated.image, `https://bracketa.lt/api/og?slug=vilnius-open&lang=ru&v=${Date.parse('2026-09-20T10:00:00Z')}`)
  assert.equal(tournamentMeta(null, { origin: 'https://bracketa.lt' }).image, 'https://bracketa.lt/og-image.png')
  assert.equal(meta.indexable, true)
  assert.equal(tournamentMeta({ ...row, visibility: 'link' }).indexable, false)
  const generic = tournamentMeta(null, { locale: 'en', origin: 'https://bracketa.lt', slug: 'hidden' })
  assert.equal(generic.title, LABELS.en.siteTitle)
  assert.equal(generic.indexable, false)
  assert.ok(tournamentMeta({ ...row, description: 'x'.repeat(500) }).description.length <= 200)
})

test('preview HTML escapes tournament text and marks unlisted pages noindex', () => {
  const meta = tournamentMeta({ name: '<script>alert(1)</script> "Cup"', sport: 'tennis', format: 'single_elimination', visibility: 'link' }, { origin: 'https://b.lt', slug: 'cup' })
  const html = previewHtml(meta)
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;Cup&quot;'))
  assert.ok(html.includes('<meta name="robots" content="noindex">'))
  assert.ok(html.includes('<meta property="og:image" content="https://b.lt/api/og?slug=cup&amp;lang=lt">'), 'Lithuanian by default')
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'))
  assert.ok(!previewHtml({ ...meta, indexable: true }).includes('noindex'))
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
})

test('tournament lookup asks the REST API with the anon key and swallows failures', async () => {
  const env = { VITE_SUPABASE_URL: 'https://ref.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' }
  let seen
  const ok = async (url, init) => { seen = { url: String(url), init }; return new Response(JSON.stringify([{ name: 'Cup' }])) }
  assert.deepEqual(await fetchPublicTournament('my cup', env, ok), { name: 'Cup', starts_at: null, ends_at: null })
  assert.match(seen.url, /\/rest\/v1\/tournaments\?select=id%2Cname%2Cdescription/)
  assert.match(seen.url, /slug=eq.my\+cup/)
  assert.equal(seen.init.headers.apikey, 'anon')
  assert.equal(await fetchPublicTournament('x', env, async () => new Response('[]')), null)
  assert.equal(await fetchPublicTournament('x', env, async () => new Response('no', { status: 500 })), null)
  assert.equal(await fetchPublicTournament('x', env, async () => { throw new Error('paused') }), null)
  assert.equal(await fetchPublicTournament('x', {}, ok), null)
  assert.equal(await fetchPublicTournament('', env, ok), null)
})

test('sitemap lists only public tournaments', async () => {
  const env = { VITE_SUPABASE_URL: 'https://ref.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' }
  let url
  const rows = await fetchSitemapTournaments(env, async u => { url = String(u); return new Response(JSON.stringify([{ slug: 'a&b', updated_at: '2026-09-20T10:00:00Z' }, { slug: null }])) })
  assert.match(url, /visibility=eq.public/)
  assert.equal(rows.length, 1)
  const xml = sitemapXml('https://bracketa.lt', rows)
  assert.ok(xml.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'))
  for (const path of ['/', '/en', '/ru']) assert.ok(xml.includes(`<loc>https://bracketa.lt${path}</loc>`), path)
  assert.equal(xml.match(/hreflang="lt" href="https:\/\/bracketa.lt\/"/g).length, 3)
  assert.equal(xml.match(/hreflang="ru" href="https:\/\/bracketa.lt\/ru"/g).length, 3)
  assert.equal(xml.match(/hreflang="x-default" href="https:\/\/bracketa.lt\/"/g).length, 3)
  assert.ok(xml.includes('<loc>https://bracketa.lt/tournaments/a%26b</loc><lastmod>2026-09-20</lastmod>'))
  assert.deepEqual(await fetchSitemapTournaments(env, async () => { throw new Error('down') }), [])
})

test('robots.txt opens production and closes preview deployments', () => {
  const prod = robotsTxt('https://bracketa.lt')
  assert.match(prod, /Disallow: \/admin/)
  assert.match(prod, /Sitemap: https:\/\/bracketa.lt\/sitemap.xml/)
  assert.equal(robotsTxt('https://x', { production: false }), 'User-agent: *\nDisallow: /\n')
  assert.equal(isProductionEnv({}), true)
  assert.equal(isProductionEnv({ VERCEL_ENV: 'production' }), true)
  assert.equal(isProductionEnv({ VERCEL_ENV: 'preview' }), false)
})

test('vercel.json sends messenger crawlers to the preview and keeps browsers and search engines on the SPA', () => {
  const bots = [
    'WhatsApp/2.23.20.0 A',
    'TelegramBot (like TwitterBot)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Viber/13.3.1.22 CFNetwork/1335.0.3 Darwin/21.6.0',
    'Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)',
  ]
  for (const ua of bots) assert.ok(botPattern.test(ua), ua)
  const browsers = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36 Telegram-Android/11.1.3',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ]
  for (const ua of browsers) assert.ok(!botPattern.test(ua), ua)
  assert.equal(botRewrite.source, '/tournaments/:slug')
  const order = vercel.rewrites.map(rule => rule.destination)
  assert.ok(order.includes('/api/robots') && order.includes('/api/sitemap'))
  const pages = Object.fromEntries(vercel.rewrites.filter(rule => !rule.has && rule.destination.endsWith('.html')).map(rule => [rule.source, rule.destination]))
  // Only real app routes get the SPA; anything else falls through to dist/404.html with HTTP 404.
  assert.deepEqual(pages, {
    '/en': '/en.html',
    '/ru': '/ru.html',
    '/blog': '/blog/index.html',
    '/blog/:slug': '/blog/:slug.html',
    '/ru/blog': '/ru/blog/index.html',
    '/ru/blog/:slug': '/ru/blog/:slug.html',
    '/en/blog': '/en/blog/index.html',
    '/en/blog/:slug': '/en/blog/:slug.html',
    '/admin': '/app.html',
    '/admin/:path*': '/app.html',
    '/tournaments/:slug': '/app.html',
    '/tournaments/:slug/poster': '/app.html',
    '/embed/:slug': '/app.html',
  })
  assert.ok(order.indexOf('/api/preview?slug=:slug') < order.lastIndexOf('/app.html'), 'bots are routed before the SPA')
  assert.deepEqual(vercel.functions['api/og.js'], { includeFiles: 'api/_fonts/**' })
  const adminHeaders = vercel.headers.filter(rule => rule.source.startsWith('/admin')).flatMap(rule => rule.headers.map(h => h.value))
  assert.ok(adminHeaders.includes("frame-ancestors 'none'"), 'admin pages cannot be framed')
  assert.ok(!vercel.headers.some(rule => rule.source.startsWith('/embed')), 'the widget stays embeddable')
})

test('preview function answers with tournament tags', async () => {
  const saved = { ...process.env }
  const realFetch = globalThis.fetch
  Object.assign(process.env, { SITE_URL: 'https://bracketa.lt', VITE_SUPABASE_URL: 'https://ref.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' })
  globalThis.fetch = async () => new Response(JSON.stringify([{ name: 'Kaunas Cup', sport: 'tennis', format: 'double_elimination', status: 'in_progress', visibility: 'public' }]))
  try {
    const { GET } = await import('../api/preview.js')
    const response = await GET(new Request('https://x/api/preview?slug=kaunas-cup', { headers: { 'accept-language': 'lt' } }))
    const html = await response.text()
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.ok(html.includes('<meta property="og:title" content="Kaunas Cup">'))
    assert.ok(html.includes('Turnyras vyksta — rezultatai tiesiogiai. Tenisas · Dvigubos eliminacijos'))
    assert.ok(html.includes('https://bracketa.lt/tournaments/kaunas-cup'))
  } finally {
    globalThis.fetch = realFetch
    for (const key of ['SITE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
      if (key in saved) process.env[key] = saved[key]
      else delete process.env[key]
    }
  }
})

test('index.html keeps dev defaults inside the block the build rewrites', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const block = html.slice(html.indexOf('<!-- seo:start -->'), html.indexOf('<!-- seo:end -->'))
  assert.match(block, /<title>Bracketa<\/title>/)
  assert.match(block, /<meta name="description" content="[^"]{60,}"/)
  assert.match(block, /<meta property="og:image" content="__SITE_ORIGIN__\/og-image.png"/)
  assert.ok(!/canonical|hreflang/.test(block), 'SPA routes must not inherit a canonical')
  assert.throws(() => replaceHeadBlock('<head></head>', 'x'), /seo:start/)
  assert.equal(replaceHeadBlock('a<!-- seo:start -->old<!-- seo:end -->b', '<title>n</title>'), 'a<!-- seo:start -->\n    <title>n</title>\n    <!-- seo:end -->b')
})

test('landing head per language: canonical, full hreflang set, localized title and OG', () => {
  for (const [locale, path] of [['lt', '/'], ['en', '/en'], ['ru', '/ru']]) {
    const head = landingHead(locale, 'https://bracketa.lt')
    assert.ok(head.includes(`<title>${LABELS[locale].siteTitle}</title>`), locale)
    assert.ok(head.includes(`<link rel="canonical" href="https://bracketa.lt${path}" data-landing>`), locale)
    for (const [code, href] of [['lt', '/'], ['en', '/en'], ['ru', '/ru'], ['x-default', '/']]) {
      assert.ok(head.includes(`<link rel="alternate" hreflang="${code}" href="https://bracketa.lt${href}" data-landing>`), `${locale} ${code}`)
    }
    assert.ok(head.includes(`<meta property="og:url" content="https://bracketa.lt${path}" data-landing>`))
    const ld = JSON.parse(head.match(/<script type="application\/ld\+json" data-landing>(.*?)<\/script>/)[1])
    const app = ld['@graph'].find(node => node['@type'] === 'WebApplication')
    assert.equal(app.url, `https://bracketa.lt${path}`)
    assert.equal(app.inLanguage, locale)
    assert.deepEqual(app.offers, { '@type': 'Offer', price: '0', priceCurrency: 'EUR' })
  }
  assert.ok(landingHead('lt').includes('<meta property="og:locale" content="lt_LT">'))
  assert.ok(landingHead('lt').includes('<meta property="og:locale:alternate" content="ru_RU">'))
  const shell = shellHead('https://bracketa.lt')
  assert.ok(!/canonical|hreflang|og:url/.test(shell))
  assert.ok(shell.includes('<meta property="og:image" content="https://bracketa.lt/og-image.png">'))
})

test('landing head is kept in the live document and removed on other routes', () => {
  const nodes = []
  const node = tag => {
    const attrs = {}
    return { tag, attrs, setAttribute: (k, v) => { attrs[k] = v }, remove() { nodes.splice(nodes.indexOf(this), 1) } }
  }
  const matches = (n, selector) => [...selector.matchAll(/\[([\w:-]+)(?:="([^"]*)")?\]/g)].every(([, k, v]) => (v === undefined ? k in n.attrs : n.attrs[k] === v))
    && (!/^[a-z]/.test(selector) || selector.startsWith(`${n.tag}[`))
  const doc = {
    title: '',
    createElement: node,
    head: {
      appendChild: n => nodes.push(n),
      querySelector: selector => nodes.find(n => matches(n, selector)) ?? null,
      querySelectorAll: selectors => nodes.filter(n => selectors.split(', ').some(s => matches(n, s))),
    },
  }
  applyLandingHead(doc, 'lt', 'https://bracketa.lt')
  applyLandingHead(doc, 'lt', 'https://bracketa.lt')
  assert.equal(doc.title, LABELS.lt.siteTitle)
  assert.equal(nodes.filter(n => n.attrs.rel === 'canonical').length, 1)
  assert.equal(nodes.find(n => n.attrs.rel === 'canonical').attrs.href, 'https://bracketa.lt/')
  assert.equal(nodes.filter(n => n.attrs.hreflang).length, 4)
  assert.equal(JSON.parse(nodes.find(n => n.tag === 'script').textContent)['@graph'][2].inLanguage, 'lt')
  applyLandingHead(doc, 'en', 'https://bracketa.lt')
  assert.equal(nodes.find(n => n.attrs.rel === 'canonical').attrs.href, 'https://bracketa.lt/en')
  assert.equal(nodes.find(n => n.attrs.name === 'description').attrs.content, LABELS.en.siteDescription)
  applyTournamentHead(doc, { canonical: 'https://bracketa.lt/tournaments/cup', jsonLd: { '@type': 'SportsEvent' } })
  clearLandingHead(doc)
  assert.ok(!nodes.some(n => 'data-landing' in n.attrs))
  assert.ok(nodes.some(n => n.attrs.name === 'description'))
  // A tournament page keeps its own canonical and event data when the landing tags go away.
  assert.equal(nodes.find(n => n.attrs.rel === 'canonical').attrs.href, 'https://bracketa.lt/tournaments/cup')
  assert.equal(JSON.parse(nodes.find(n => n.tag === 'script').textContent)['@type'], 'SportsEvent')
  applyTournamentHead(doc, { canonical: 'https://bracketa.lt/tournaments/cup', jsonLd: null })
  assert.ok(!nodes.some(n => n.tag === 'script'), 'no event data without a date and place')
  clearTournamentHead(doc)
  assert.ok(!nodes.some(n => n.attrs.rel === 'canonical'))
  applyLandingHead(null, 'ru', '')
  applyTournamentHead(null, {})
})

test('dates: one day, a range, another year, a time zone, nothing', () => {
  const now = new Date('2026-09-26T12:00:00Z')
  assert.equal(formatDateRange('2026-10-12T07:00:00Z', '2026-10-12T16:00:00Z', 'ru', 'Europe/Vilnius', now), '12 октября')
  assert.match(formatDateRange('2026-10-12T07:00:00Z', '2026-10-14T16:00:00Z', 'en', 'Europe/Vilnius', now), /^12\s?–\s?14 October$/)
  assert.match(formatDateRange('2027-01-05T08:00:00Z', null, 'lt', undefined, now), /2027/)
  // 23:30 UTC is already the next day in Vilnius.
  assert.equal(formatDateRange('2026-10-12T23:30:00Z', null, 'en', 'Europe/Vilnius', now), '13 October')
  assert.equal(formatDateRange('2026-10-12T07:00:00Z', null, 'en', 'Not/AZone', now), '12 October')
  assert.equal(formatDateRange(null, null, 'ru', undefined, now), '')
  assert.deepEqual(scheduleSpan([
    { scheduled_at: '2026-10-14T16:00:00Z', state: 'published' },
    { scheduled_at: '2026-10-11T09:00:00Z', state: 'draft' },
    { scheduled_at: null, state: 'published' },
    { scheduled_at: '2026-10-12T07:00:00Z' },
  ]), { starts_at: '2026-10-12T07:00:00.000Z', ends_at: '2026-10-14T16:00:00.000Z' })
  assert.deepEqual(scheduleSpan([]), { starts_at: null, ends_at: null })
})

test('SportsEvent JSON-LD needs a start date and a place', () => {
  const row = { name: 'Kaunas Open', sport: 'padel', format: 'round_robin', starts_at: '2026-10-12T07:00:00.000Z', ends_at: '2026-10-13T16:00:00.000Z', venue_address: 'Kaunas, Laisvės al. 1', venue_lat: 54.9, venue_lng: 23.9 }
  const ld = tournamentJsonLd(row, { origin: 'https://bracketa.lt', slug: 'kaunas-open', locale: 'lt', image: 'https://bracketa.lt/api/og?slug=kaunas-open' })
  assert.equal(ld['@type'], 'SportsEvent')
  assert.equal(ld.sport, 'Padel')
  assert.equal(ld.startDate, row.starts_at)
  assert.equal(ld.endDate, row.ends_at)
  assert.deepEqual(ld.location.geo, { '@type': 'GeoCoordinates', latitude: 54.9, longitude: 23.9 })
  assert.equal(ld.location.address, 'Kaunas, Laisvės al. 1')
  assert.equal(ld.url, 'https://bracketa.lt/tournaments/kaunas-open')
  assert.equal(tournamentJsonLd({ ...row, starts_at: null }), null)
  assert.equal(tournamentJsonLd({ ...row, venue_address: '' }), null)
  assert.equal(tournamentJsonLd({ ...row, venue_lat: null, venue_lng: null }).location.geo, undefined)
  const graph = landingJsonLd('ru', 'https://bracketa.lt')['@graph']
  assert.deepEqual(graph.map(node => node['@type']), ['Organization', 'WebSite', 'WebApplication'])
  assert.equal(jsonLdScript({ name: '</script><b>' }), '<script type="application/ld+json">{"name":"\\u003c/script>\\u003cb>"}</script>')
  assert.equal(tournamentImageUrl('https://b.lt', 'a b', 'lt', 'bad-date'), 'https://b.lt/api/og?slug=a+b&lang=lt&v=bad-date')
})
