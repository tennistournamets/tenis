import { createI18n } from 'vue-i18n'
import { DEFAULT_LOCALE, isLocale, pathLocale, readStoredLocale } from '../lib/localeRoute'

// Each language is its own chunk (scripts/vite-locale-messages.js): only the active one is downloaded.
const loaders = {
  ru: () => import('virtual:bracketa-locale/ru'),
  en: () => import('virtual:bracketa-locale/en'),
  lt: () => import('virtual:bracketa-locale/lt'),
}

// A landing URL (/en, /ru) names its language; an embed may pass ?lang=; elsewhere the stored choice
// applies, and a first visit starts in Lithuanian (DEFAULT_LOCALE).
function initialLocale() {
  const urlLocale = pathLocale(window.location.pathname)
  if (urlLocale && urlLocale !== DEFAULT_LOCALE) return urlLocale
  if (window.location.pathname.startsWith('/embed/')) {
    const lang = new URLSearchParams(window.location.search).get('lang')
    if (isLocale(lang)) return lang
  }
  return readStoredLocale() || DEFAULT_LOCALE
}

const locale = initialLocale()

const i18n = createI18n({
  legacy: false,
  locale,
  fallbackLocale: 'en',
  // ru and lt carry every key; en lacks only plural forms English never selects.
  fallbackWarn: false,
  missingWarn: import.meta.env.DEV,
  messages: {},
})

const pending = {}

export function loadLocaleMessages(code) {
  if (!isLocale(code)) return Promise.reject(new Error(`Unknown locale ${code}`))
  if (i18n.global.availableLocales.includes(code) && !pending[code]) return Promise.resolve()
  pending[code] ??= loaders[code]().then(module => {
    i18n.global.setLocaleMessage(code, module.default)
  }).finally(() => { delete pending[code] })
  return pending[code]
}

/** Switches the UI language once its messages are loaded. */
export async function setAppLocale(code) {
  await loadLocaleMessages(code)
  i18n.global.locale.value = code
}

export const i18nReady = loadLocaleMessages(locale)

export default i18n
