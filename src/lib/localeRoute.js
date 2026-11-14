// Landing page URLs per language: / (lt, the default), /en, /ru, /lv. Search engines index each one
// separately (hreflang); the rest of the app keeps its URLs and the stored choice.

export const LOCALES = ['ru', 'en', 'lt', 'lv']
export const DEFAULT_LOCALE = 'lt'
export const LOCALE_STORAGE_KEY = 'champ_locale'
// Languages whose landing (and legal/blog pages) live under a /<code> prefix.
export const PREFIXED_LOCALES = LOCALES.filter(code => code !== DEFAULT_LOCALE)
// vue-router pattern: optional language prefix, the default language has none.
export const LANDING_ROUTE_PATH = `/:lang(${PREFIXED_LOCALES.join('|')})?`
// Crawlers and preview bots keep the default language: the URL alone decides what they index.
const BOT_AGENT = /bot|crawl|spider|slurp|facebookexternalhit|lighthouse|headless|prerender/i

export function isLocale(value) {
  return LOCALES.includes(value)
}

export function landingPath(locale) {
  return isLocale(locale) && locale !== DEFAULT_LOCALE ? `/${locale}` : '/'
}

// Static legal pages (content/legal, scripts/legal.mjs): /privacy (lt), /ru/privacy, /en/terms...
export const LEGAL_DOCS = ['privacy', 'terms']

export function legalPath(locale, doc) {
  return isLocale(locale) && locale !== DEFAULT_LOCALE ? `/${locale}/${doc}` : `/${doc}`
}

/** Language named by a landing URL ("/ru" -> ru, "/" -> lt), or null for other pages. */
export function pathLocale(pathname) {
  const match = /^\/([a-z]{2})\/?$/.exec(String(pathname ?? ''))
  if (match && PREFIXED_LOCALES.includes(match[1])) return match[1]
  return pathname === '/' || pathname === '' ? DEFAULT_LOCALE : null
}

/** First browser language the app speaks ("lv-LV" -> lv), or null; crawlers always get null. */
export function browserLocale(nav = globalThis.navigator) {
  if (!nav || BOT_AGENT.test(String(nav.userAgent ?? ''))) return null
  const tags = Array.isArray(nav.languages) && nav.languages.length ? nav.languages : [nav.language]
  for (const tag of tags) {
    const code = String(tag ?? '').toLowerCase().split(/[-_]/)[0]
    if (isLocale(code)) return code
  }
  return null
}

export function readStoredLocale(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(LOCALE_STORAGE_KEY)
    return isLocale(value) ? value : null
  } catch {
    return null
  }
}

export function storeLocale(locale, storage = globalThis.localStorage) {
  try { storage?.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* Storage may be unavailable. */ }
}

/**
 * Language of a visitor: their stored choice, else the language a shared link names
 * (?lang=, set by the organizer's share/QR links), else the browser's language, else lt.
 */
export function preferredLocale(storage = globalThis.localStorage, nav = globalThis.navigator, hint = null) {
  return readStoredLocale(storage) || (isLocale(hint) ? hint : null) || browserLocale(nav) || DEFAULT_LOCALE
}

/**
 * Landing navigation decision. The URL is the source of truth, except that a visitor
 * arriving at "/" from outside the landing is sent to their language (stored choice,
 * else the browser's one). Switching inside the landing (language menu, back button)
 * never redirects. Returns { locale } to apply, or { redirect } with the path to go to.
 */
export function landingLocaleDecision(to, from, preferred) {
  const lang = typeof to?.params?.lang === 'string' && to.params.lang ? to.params.lang : ''
  if (lang) return { locale: lang }
  if (from?.name !== 'home' && isLocale(preferred) && preferred !== DEFAULT_LOCALE) return { redirect: landingPath(preferred) }
  return { locale: DEFAULT_LOCALE }
}
