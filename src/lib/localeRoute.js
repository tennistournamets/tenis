// Landing page URLs per language: / (lt, the default), /en, /ru. Search engines index each one
// separately (hreflang); the rest of the app keeps its URLs and the stored choice.

export const LOCALES = ['ru', 'en', 'lt']
export const DEFAULT_LOCALE = 'lt'
export const LOCALE_STORAGE_KEY = 'champ_locale'
// vue-router pattern: optional language prefix, the default language has none.
export const LANDING_ROUTE_PATH = '/:lang(ru|en)?'

export function isLocale(value) {
  return LOCALES.includes(value)
}

export function landingPath(locale) {
  return isLocale(locale) && locale !== DEFAULT_LOCALE ? `/${locale}` : '/'
}

/** Language named by a landing URL ("/ru" -> ru, "/" -> lt), or null for other pages. */
export function pathLocale(pathname) {
  const match = /^\/(ru|en)\/?$/.exec(String(pathname ?? ''))
  if (match) return match[1]
  return pathname === '/' || pathname === '' ? DEFAULT_LOCALE : null
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
 * Landing navigation decision. The URL is the source of truth, except that a visitor
 * arriving at "/" from outside the landing is sent to the language they chose before.
 * Switching inside the landing (language menu, back button) never redirects.
 * Returns { locale } to apply, or { redirect } with the path to go to.
 */
export function landingLocaleDecision(to, from, stored) {
  const lang = typeof to?.params?.lang === 'string' && to.params.lang ? to.params.lang : ''
  if (lang) return { locale: lang }
  if (from?.name !== 'home' && stored && stored !== DEFAULT_LOCALE) return { redirect: landingPath(stored) }
  return { locale: DEFAULT_LOCALE }
}
