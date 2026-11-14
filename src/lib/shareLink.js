import { DEFAULT_LOCALE, isLocale } from './localeRoute.js'

/**
 * Full public URL for spectators (registration + bracket). A `locale` other than the default
 * adds ?lang=, so messenger previews (api/preview) speak the language of the person sharing.
 * @param {string} slug
 * @param {{ locale?: string }} [options]
 */
export function tournamentShareUrl(slug, { locale } = {}) {
  const lang = isLocale(locale) && locale !== DEFAULT_LOCALE ? `?lang=${locale}` : ''
  const path = `/tournaments/${encodeURIComponent(slug)}${lang}`
  if (typeof window === 'undefined') {
    return path
  }
  return `${window.location.origin}${path}`
}

export async function copyTournamentLink(slug, options) {
  const url = tournamentShareUrl(slug, options)
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    throw new Error('Clipboard unavailable')
  }
  await navigator.clipboard.writeText(url)
  return url
}
