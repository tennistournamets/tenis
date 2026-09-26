// SEO and link-preview helpers shared by the Vercel functions (api/), the build-time
// landing prerender (scripts/prerender.mjs) and the client (landing head per language).
// Messengers (WhatsApp, Telegram, Facebook...) do not run JavaScript, so the SPA's own title
// never reaches them; vercel.json routes their user agents to api/preview instead.
// Plain ESM without extensionless imports, so Node runs it directly.
import { DEFAULT_LOCALE, LOCALES, landingPath } from './localeRoute.js'

export const SITE_NAME = 'Bracketa'
export const OG_IMAGE_PATH = '/og-image.png'
export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630

// Must match sport.* and tournamentFormat.* in src/i18n/messages.js (checked by tests/seo.test.mjs).
export const LABELS = {
  ru: {
    sport: { tennis: 'Теннис', padel: 'Падел', football: 'Футбол' },
    format: {
      single_elimination: 'Олимпийка (на выбывание)',
      round_robin: 'Круговая',
      groups_playoff: 'Группы + плей-офф',
      double_elimination: 'Двойное выбывание',
    },
    status: {
      registration_open: 'Идёт регистрация',
      in_progress: 'Турнир идёт — счёт онлайн',
      completed: 'Турнир завершён — итоги и сетка',
    },
    chip: { registration_open: 'Регистрация открыта', registration_closed: 'Регистрация закрыта', in_progress: 'LIVE', completed: 'Завершён' },
    siteTitle: 'Bracketa — турниры по теннису, паделу и футболу',
    siteDescription: 'Бесплатный сервис для турниров по теннису, паделу и футболу: регистрация участников, турнирная сетка, live-счёт и расписание кортов. Зрителям не нужен аккаунт.',
    open: 'Открыть турнир',
  },
  en: {
    sport: { tennis: 'Tennis', padel: 'Padel', football: 'Football' },
    format: {
      single_elimination: 'Single elimination',
      round_robin: 'Round robin',
      groups_playoff: 'Groups + playoff',
      double_elimination: 'Double elimination',
    },
    status: {
      registration_open: 'Registration is open',
      in_progress: 'Live now — follow the score',
      completed: 'Finished — results and bracket',
    },
    chip: { registration_open: 'Registration open', registration_closed: 'Registration closed', in_progress: 'LIVE', completed: 'Finished' },
    siteTitle: 'Bracketa — tennis, padel and football tournaments',
    siteDescription: 'Free app for tennis, padel and football tournaments: player registration, brackets, live scores and court schedule. Spectators need no account.',
    open: 'Open tournament',
  },
  lt: {
    sport: { tennis: 'Tenisas', padel: 'Padelis', football: 'Futbolas' },
    format: {
      single_elimination: 'Vienos eliminacijos',
      round_robin: 'Ratų sistema',
      groups_playoff: 'Grupės + atkrentamosios',
      double_elimination: 'Dvigubos eliminacijos',
    },
    status: {
      registration_open: 'Vyksta registracija',
      in_progress: 'Turnyras vyksta — rezultatai tiesiogiai',
      completed: 'Turnyras baigtas — rezultatai ir tinklelis',
    },
    chip: { registration_open: 'Registracija atvira', registration_closed: 'Registracija uždaryta', in_progress: 'LIVE', completed: 'Baigtas' },
    siteTitle: 'Bracketa — teniso, padelio ir futbolo turnyrai',
    siteDescription: 'Nemokama programa teniso, padelio ir futbolo turnyrams: dalyvių registracija, turnyrų tinklelis, rezultatai tiesiogiai ir kortų tvarkaraštis. Žiūrovams paskyros nereikia.',
    open: 'Atidaryti turnyrą',
  },
}

const OG_LOCALE = { ru: 'ru_RU', en: 'en_US', lt: 'lt_LT' }
const INTL_LOCALE = { ru: 'ru-RU', en: 'en-GB', lt: 'lt-LT' }
// schema.org `sport` values (English names are what search engines match on).
const SCHEMA_SPORT = { tennis: 'Tennis', padel: 'Padel', football: 'Football' }
export const LANDING_PATHS = Object.fromEntries(LOCALES.map(locale => [locale, landingPath(locale)]))
const HEAD_START = '<!-- seo:start -->'
const HEAD_END = '<!-- seo:end -->'

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

/** Canonical https origin without a trailing slash, or '' when unknown. */
export function normalizeOrigin(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    return url.origin
  } catch {
    return ''
  }
}

/**
 * Public site origin: SITE_URL (own domain) wins, then Vercel's production domain,
 * then the host of the current request.
 */
export function siteOrigin(env = {}, request = null) {
  const configured = normalizeOrigin(env.SITE_URL) || normalizeOrigin(env.VERCEL_PROJECT_PRODUCTION_URL)
  if (configured) return configured
  if (!request) return ''
  const host = request.headers?.get?.('x-forwarded-host') || request.headers?.get?.('host')
  if (host) return normalizeOrigin(`${request.headers.get('x-forwarded-proto') || 'https'}://${host}`)
  try { return new URL(request.url).origin } catch { return '' }
}

/** ru | en | lt from an Accept-Language header; lt is the app default. */
export function pickLocale(acceptLanguage) {
  const tags = String(acceptLanguage ?? '').toLowerCase().split(',').map(part => part.trim().slice(0, 2))
  return tags.find(tag => LOCALES.includes(tag)) || DEFAULT_LOCALE
}

function clip(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

/** Title/description/url for one tournament row (null row = generic site preview). */
export function tournamentMeta(row, { locale = DEFAULT_LOCALE, origin = '', slug = '' } = {}) {
  const labels = LABELS[locale] ?? LABELS[DEFAULT_LOCALE]
  const path = slug ? `/tournaments/${encodeURIComponent(slug)}` : '/'
  const base = { url: `${origin}${path}`, image: `${origin}${OG_IMAGE_PATH}`, locale, indexable: false }
  if (!row?.name) {
    return { ...base, title: labels.siteTitle, description: labels.siteDescription }
  }
  const facts = [
    labels.sport[row.sport],
    labels.format[row.format],
    formatDateRange(row.starts_at, row.ends_at, locale, row.schedule_config?.timezone),
    row.venue_address ? clip(row.venue_address, 60) : '',
  ].filter(Boolean).join(' · ')
  const lead = [labels.status[row.status], facts].filter(Boolean).join('. ')
  const description = clip([lead, row.description].filter(Boolean).join('. '), 200)
  return {
    ...base,
    title: clip(row.name, 90),
    description: description || labels.siteDescription,
    image: tournamentImageUrl(origin, slug, locale, row.updated_at),
    indexable: row.visibility === 'public',
  }
}

/** Per-tournament preview card (api/og.js); `v` changes with the row so caches refresh. */
export function tournamentImageUrl(origin, slug, locale = DEFAULT_LOCALE, version = '') {
  const params = new URLSearchParams({ slug, lang: locale })
  if (version) params.set('v', String(Date.parse(version) || version).slice(0, 20))
  return `${origin}/api/og?${params}`
}

function validDate(value) {
  const time = Date.parse(value ?? '')
  return Number.isNaN(time) ? null : new Date(time)
}

function validTimeZone(timeZone) {
  if (!timeZone) return undefined
  try { new Intl.DateTimeFormat('en', { timeZone }); return timeZone } catch { return undefined }
}

/** "12–14 октября", "12 окт. – 2 нояб.", "12 октября 2026" (other year) or '' without a date. */
export function formatDateRange(start, end, locale = DEFAULT_LOCALE, timeZone, now = new Date()) {
  const from = validDate(start)
  if (!from) return ''
  const to = validDate(end) ?? from
  const zone = validTimeZone(timeZone)
  const intl = INTL_LOCALE[locale] ?? INTL_LOCALE.ru
  const parts = date => Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(date).map(part => [part.type, part.value]))
  const a = parts(from)
  const b = parts(to)
  const withYear = a.year !== b.year || a.year !== parts(now).year
  const options = { timeZone: zone, day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}) }
  const format = new Intl.DateTimeFormat(intl, options)
  if (a.year === b.year && a.month === b.month && a.day === b.day) return format.format(from)
  return format.formatRange(from, to)
}

/** First and last published match time (ISO strings) from schedule rows. */
export function scheduleSpan(rows = []) {
  const times = rows
    .filter(row => row?.scheduled_at && (!row.state || row.state === 'published'))
    .map(row => Date.parse(row.scheduled_at))
    .filter(time => !Number.isNaN(time))
    .sort((x, y) => x - y)
  if (!times.length) return { starts_at: null, ends_at: null }
  return { starts_at: new Date(times[0]).toISOString(), ends_at: new Date(times[times.length - 1]).toISOString() }
}

/** JSON-LD inside <script>: "<" is escaped so tournament text cannot close the tag. */
export function jsonLdScript(data, attrs = '') {
  return `<script type="application/ld+json"${attrs}>${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
}

/** schema.org graph of the landing: the site, the product (free web app) and the brand. */
export function landingJsonLd(locale, origin = '') {
  const labels = LABELS[locale] ?? LABELS[DEFAULT_LOCALE]
  const url = `${origin}${LANDING_PATHS[locale] ?? landingPath(DEFAULT_LOCALE)}`
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': `${origin}/#organization`, name: SITE_NAME, url: `${origin}/`, logo: `${origin}/icon-512.png` },
      { '@type': 'WebSite', '@id': `${origin}/#website`, name: SITE_NAME, url: `${origin}/`, inLanguage: LOCALES, publisher: { '@id': `${origin}/#organization` } },
      {
        '@type': 'WebApplication',
        name: SITE_NAME,
        url,
        description: labels.siteDescription,
        inLanguage: locale,
        applicationCategory: 'SportsApplication',
        operatingSystem: 'Web',
        browserRequirements: 'Requires JavaScript',
        image: `${origin}${OG_IMAGE_PATH}`,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
        publisher: { '@id': `${origin}/#organization` },
      },
    ],
  }
}

/**
 * schema.org SportsEvent for a public tournament page, or null when search engines
 * could not use it (Google requires a start date and a place for events).
 */
export function tournamentJsonLd(row, { origin = '', slug = '', locale = DEFAULT_LOCALE, image = '' } = {}) {
  if (!row?.name || !row.starts_at || !row.venue_address) return null
  const place = { '@type': 'Place', name: row.venue_address, address: row.venue_address }
  if (Number.isFinite(row.venue_lat) && Number.isFinite(row.venue_lng)) {
    place.geo = { '@type': 'GeoCoordinates', latitude: row.venue_lat, longitude: row.venue_lng }
  }
  const labels = LABELS[locale] ?? LABELS[DEFAULT_LOCALE]
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: row.name,
    description: clip([labels.sport[row.sport], labels.format[row.format], row.description].filter(Boolean).join('. '), 300),
    sport: SCHEMA_SPORT[row.sport] ?? row.sport,
    startDate: row.starts_at,
    endDate: row.ends_at || row.starts_at,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: place,
    url: `${origin}/tournaments/${encodeURIComponent(slug)}`,
    image: image || `${origin}${OG_IMAGE_PATH}`,
    inLanguage: locale,
  }
}

/** Standalone HTML with Open Graph / Twitter tags. Served only to link-preview bots. */
export function previewHtml(meta) {
  const labels = LABELS[meta.locale] ?? LABELS[DEFAULT_LOCALE]
  const e = escapeHtml
  const title = meta.title === labels.siteTitle ? meta.title : `${meta.title} — ${SITE_NAME}`
  return `<!doctype html>
<html lang="${e(meta.locale)}">
<head>
<meta charset="utf-8">
<title>${e(title)}</title>
<meta name="description" content="${e(meta.description)}">
${meta.indexable ? '' : '<meta name="robots" content="noindex">\n'}<link rel="canonical" href="${e(meta.url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="${OG_LOCALE[meta.locale] ?? OG_LOCALE[DEFAULT_LOCALE]}">
<meta property="og:url" content="${e(meta.url)}">
<meta property="og:title" content="${e(meta.title)}">
<meta property="og:description" content="${e(meta.description)}">
<meta property="og:image" content="${e(meta.image)}">
<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">
<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">
<meta property="og:image:alt" content="${SITE_NAME}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(meta.title)}">
<meta name="twitter:description" content="${e(meta.description)}">
<meta name="twitter:image" content="${e(meta.image)}">
</head>
<body>
<h1>${e(meta.title)}</h1>
<p>${e(meta.description)}</p>
<p><a href="${e(meta.url)}">${e(labels.open)}</a></p>
</body>
</html>
`
}

function supabaseHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' }
}

/**
 * One tournament as the anonymous public sees it. RLS returns only public/link tournaments,
 * so private and password pages get the generic preview. Any failure (paused project,
 * timeout) also falls back to null.
 */
export async function fetchPublicTournament(slug, env, fetchImpl = globalThis.fetch) {
  const base = normalizeOrigin(env.VITE_SUPABASE_URL)
  const key = env.VITE_SUPABASE_ANON_KEY
  if (!base || !key || !slug) return null
  const url = new URL('/rest/v1/tournaments', base)
  url.searchParams.set('select', 'id,name,description,sport,format,status,visibility,venue_address,venue_lat,venue_lng,schedule_config,updated_at')
  url.searchParams.set('slug', `eq.${slug}`)
  url.searchParams.set('limit', '1')
  try {
    const response = await fetchImpl(url, { headers: supabaseHeaders(key), signal: AbortSignal.timeout(3000) })
    if (!response.ok) return null
    const rows = await response.json()
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null
    if (!row) return null
    return { ...row, ...(await fetchScheduleSpan(row.id, base, key, fetchImpl)) }
  } catch {
    return null
  }
}

// Earliest and latest published match time; RLS shows published rows of public tournaments only.
async function fetchScheduleSpan(tournamentId, base, key, fetchImpl) {
  const edge = async order => {
    const url = new URL('/rest/v1/match_schedule', base)
    url.searchParams.set('select', 'scheduled_at')
    url.searchParams.set('tournament_id', `eq.${tournamentId}`)
    url.searchParams.set('state', 'eq.published')
    url.searchParams.set('scheduled_at', 'not.is.null')
    url.searchParams.set('order', `scheduled_at.${order}`)
    url.searchParams.set('limit', '1')
    try {
      const response = await fetchImpl(url, { headers: supabaseHeaders(key), signal: AbortSignal.timeout(2000) })
      if (!response.ok) return []
      const rows = await response.json()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }
  if (!tournamentId) return { starts_at: null, ends_at: null }
  const [first, last] = await Promise.all([edge('asc'), edge('desc')])
  return scheduleSpan([...first, ...last])
}

/** Slugs of tournaments listed as public (link-only tournaments stay unlisted). */
export async function fetchSitemapTournaments(env, fetchImpl = globalThis.fetch) {
  const base = normalizeOrigin(env.VITE_SUPABASE_URL)
  const key = env.VITE_SUPABASE_ANON_KEY
  if (!base || !key) return []
  const url = new URL('/rest/v1/tournaments', base)
  url.searchParams.set('select', 'slug,updated_at')
  url.searchParams.set('visibility', 'eq.public')
  url.searchParams.set('order', 'updated_at.desc')
  url.searchParams.set('limit', '5000')
  try {
    const response = await fetchImpl(url, { headers: supabaseHeaders(key), signal: AbortSignal.timeout(5000) })
    if (!response.ok) return []
    const rows = await response.json()
    return Array.isArray(rows) ? rows.filter(row => row?.slug) : []
  } catch {
    return []
  }
}

export function sitemapXml(origin, tournaments = []) {
  const e = escapeHtml
  const alternates = Object.keys(LANDING_PATHS)
    .map(locale => `<xhtml:link rel="alternate" hreflang="${locale}" href="${e(`${origin}${LANDING_PATHS[locale]}`)}"/>`)
    .concat(`<xhtml:link rel="alternate" hreflang="x-default" href="${e(`${origin}/`)}"/>`)
    .join('')
  const urls = Object.values(LANDING_PATHS).map(path => `  <url><loc>${e(`${origin}${path}`)}</loc>${alternates}</url>`)
  for (const row of tournaments) {
    const lastmod = row.updated_at && !Number.isNaN(Date.parse(row.updated_at))
      ? `<lastmod>${new Date(row.updated_at).toISOString().slice(0, 10)}</lastmod>`
      : ''
    urls.push(`  <url><loc>${e(`${origin}/tournaments/${encodeURIComponent(row.slug)}`)}</loc>${lastmod}</url>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`
}

/** Production is indexable; Vercel preview deployments are closed to crawlers. */
export function robotsTxt(origin, { production = true } = {}) {
  if (!production) return 'User-agent: *\nDisallow: /\n'
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /api/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    `Sitemap: ${origin}/blog/sitemap.xml`,
    '',
  ].join('\n')
}

export function isProductionEnv(env = {}) {
  return !env.VERCEL_ENV || env.VERCEL_ENV === 'production'
}

function ogTags(locale, { title, description, url, image }) {
  const e = escapeHtml
  const alternates = Object.keys(OG_LOCALE).filter(code => code !== locale)
    .map(code => `<meta property="og:locale:alternate" content="${OG_LOCALE[code]}">`)
  return [
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:locale" content="${OG_LOCALE[locale] ?? OG_LOCALE[DEFAULT_LOCALE]}">`,
    ...alternates,
    url ? `<meta property="og:url" content="${e(url)}" data-landing>` : '',
    `<meta property="og:title" content="${e(title)}">`,
    `<meta property="og:description" content="${e(description)}">`,
    `<meta property="og:image" content="${e(image)}">`,
    `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">`,
    `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">`,
    `<meta property="og:image:alt" content="${SITE_NAME}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${e(title)}">`,
    `<meta name="twitter:description" content="${e(description)}">`,
    `<meta name="twitter:image" content="${e(image)}">`,
  ].filter(Boolean)
}

/** Head tags of the landing page in one language: title, description, canonical, hreflang, OG. */
export function landingHead(locale, origin = '') {
  const labels = LABELS[locale] ?? LABELS[DEFAULT_LOCALE]
  const e = escapeHtml
  const url = `${origin}${LANDING_PATHS[locale] ?? landingPath(DEFAULT_LOCALE)}`
  const hreflang = Object.entries(LANDING_PATHS)
    .map(([code, path]) => `<link rel="alternate" hreflang="${code}" href="${e(`${origin}${path}`)}" data-landing>`)
    .concat(`<link rel="alternate" hreflang="x-default" href="${e(`${origin}/`)}" data-landing>`)
  return [
    `<title>${e(labels.siteTitle)}</title>`,
    `<meta name="description" content="${e(labels.siteDescription)}">`,
    `<link rel="canonical" href="${e(url)}" data-landing>`,
    ...hreflang,
    ...ogTags(locale, { title: labels.siteTitle, description: labels.siteDescription, url, image: `${origin}${OG_IMAGE_PATH}` }),
    jsonLdScript(landingJsonLd(locale, origin), ' data-landing'),
  ].join('\n    ')
}

/** Head tags of the SPA shell (every non-landing route): no canonical, the app sets titles. */
export function shellHead(origin = '') {
  const labels = LABELS[DEFAULT_LOCALE]
  return [
    `<title>${SITE_NAME}</title>`,
    `<meta name="description" content="${escapeHtml(labels.siteDescription)}">`,
    ...ogTags(DEFAULT_LOCALE, { title: labels.siteTitle, description: labels.siteDescription, image: `${origin}${OG_IMAGE_PATH}` }),
  ].join('\n    ')
}

/** Replaces the marked block of index.html (between seo:start and seo:end). */
export function replaceHeadBlock(html, block) {
  const start = html.indexOf(HEAD_START)
  const end = html.indexOf(HEAD_END)
  if (start < 0 || end < start) throw new Error('index.html has no seo:start/seo:end block')
  return `${html.slice(0, start + HEAD_START.length)}\n    ${block}\n    ${html.slice(end)}`
}

function upsertMeta(doc, selector, attrs) {
  let node = doc.head.querySelector(selector)
  if (!node) {
    node = doc.createElement(attrs.rel ? 'link' : 'meta')
    doc.head.appendChild(node)
  }
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
}

/**
 * Keeps the live document head equal to the prerendered one when the landing switches
 * language in the browser (Google renders JavaScript and reads the final head).
 */
export function applyLandingHead(doc, locale, origin) {
  if (!doc?.head) return
  const labels = LABELS[locale] ?? LABELS[DEFAULT_LOCALE]
  const url = `${origin}${LANDING_PATHS[locale] ?? landingPath(DEFAULT_LOCALE)}`
  doc.title = labels.siteTitle
  upsertMeta(doc, 'meta[name="description"]', { name: 'description', content: labels.siteDescription })
  upsertMeta(doc, 'link[rel="canonical"][data-landing]', { rel: 'canonical', href: url, 'data-landing': '' })
  for (const [code, path] of Object.entries(LANDING_PATHS)) {
    upsertMeta(doc, `link[rel="alternate"][hreflang="${code}"]`, { rel: 'alternate', hreflang: code, href: `${origin}${path}`, 'data-landing': '' })
  }
  upsertMeta(doc, 'link[rel="alternate"][hreflang="x-default"]', { rel: 'alternate', hreflang: 'x-default', href: `${origin}/`, 'data-landing': '' })
  upsertMeta(doc, 'meta[property="og:url"]', { property: 'og:url', content: url, 'data-landing': '' })
  upsertJsonLd(doc, 'script[type="application/ld+json"][data-landing]', landingJsonLd(locale, origin), 'data-landing')
  upsertMeta(doc, 'meta[property="og:locale"]', { property: 'og:locale', content: OG_LOCALE[locale] ?? OG_LOCALE[DEFAULT_LOCALE] })
  upsertMeta(doc, 'meta[property="og:title"]', { property: 'og:title', content: labels.siteTitle })
  upsertMeta(doc, 'meta[property="og:description"]', { property: 'og:description', content: labels.siteDescription })
}

/** Other routes must not inherit the landing canonical/hreflang (Google would fold them into "/"). */
export function clearLandingHead(doc) {
  if (!doc?.head) return
  for (const node of doc.head.querySelectorAll('[data-landing]')) node.remove()
}

function upsertJsonLd(doc, selector, data, marker) {
  let node = doc.head.querySelector(selector)
  if (!data) { node?.remove(); return }
  if (!node) {
    node = doc.createElement('script')
    node.setAttribute('type', 'application/ld+json')
    node.setAttribute(marker, '')
    doc.head.appendChild(node)
  }
  node.textContent = JSON.stringify(data)
}

/** Public tournament page: canonical URL and SportsEvent JSON-LD (null removes it). */
export function applyTournamentHead(doc, { canonical, jsonLd }) {
  if (!doc?.head) return
  if (canonical) upsertMeta(doc, 'link[rel="canonical"][data-tournament]', { rel: 'canonical', href: canonical, 'data-tournament': '' })
  upsertJsonLd(doc, 'script[type="application/ld+json"][data-tournament]', jsonLd, 'data-tournament')
}

export function clearTournamentHead(doc) {
  if (!doc?.head) return
  for (const node of doc.head.querySelectorAll('link[data-tournament], script[data-tournament]')) node.remove()
}
