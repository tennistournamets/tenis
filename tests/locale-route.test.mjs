import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_LOCALE, LANDING_ROUTE_PATH, browserLocale, landingLocaleDecision, landingPath, pathLocale, preferredLocale, readStoredLocale, storeLocale } from '../src/lib/localeRoute.js'

const storage = (initial = {}) => {
  const data = { ...initial }
  return { getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value }, data }
}

test('landing paths: Lithuanian is the default and has no prefix, en, ru and lv have one', () => {
  assert.equal(DEFAULT_LOCALE, 'lt')
  assert.equal(landingPath('lt'), '/')
  assert.equal(landingPath('en'), '/en')
  assert.equal(landingPath('ru'), '/ru')
  assert.equal(landingPath('lv'), '/lv')
  assert.equal(landingPath('de'), '/')
  assert.equal(LANDING_ROUTE_PATH, '/:lang(ru|en|lv)?')
})

test('the URL names the landing language; other pages name none', () => {
  assert.equal(pathLocale('/'), 'lt')
  assert.equal(pathLocale('/ru'), 'ru')
  assert.equal(pathLocale('/en/'), 'en')
  assert.equal(pathLocale('/lv'), 'lv')
  assert.equal(pathLocale('/de'), null)
  assert.equal(pathLocale('/lt'), null)
  assert.equal(pathLocale('/ru/tournaments'), null)
  assert.equal(pathLocale('/admin/tournaments'), null)
  assert.equal(pathLocale('/tournaments/en'), null)
})

test('stored locale is validated and storage failures are ignored', () => {
  assert.equal(readStoredLocale(storage({ champ_locale: 'lt' })), 'lt')
  assert.equal(readStoredLocale(storage({ champ_locale: 'xx' })), null)
  assert.equal(readStoredLocale({ getItem() { throw new Error('blocked') } }), null)
  const s = storage()
  storeLocale('en', s)
  assert.equal(s.data.champ_locale, 'en')
  storeLocale('en', { setItem() { throw new Error('blocked') } })
})

test('landing language: URL first; a first visit is Lithuanian; a return visit to "/" follows the saved choice', () => {
  const start = { name: undefined, matched: [] }
  assert.deepEqual(landingLocaleDecision({ params: { lang: 'ru' } }, start, 'lt'), { locale: 'ru' })
  assert.deepEqual(landingLocaleDecision({ params: { lang: '' } }, start, 'ru'), { redirect: '/ru' })
  assert.deepEqual(landingLocaleDecision({ params: {} }, { name: 'public-tournament' }, 'en'), { redirect: '/en' })
  assert.deepEqual(landingLocaleDecision({ params: {} }, start, null), { locale: 'lt' })
  assert.deepEqual(landingLocaleDecision({ params: {} }, start, 'lt'), { locale: 'lt' })
  // Switching or going back inside the landing never bounces to the saved language.
  assert.deepEqual(landingLocaleDecision({ params: {} }, { name: 'home' }, 'ru'), { locale: 'lt' })
})

test('first visit: the browser language decides when nothing is stored; crawlers stay on Lithuanian', () => {
  const nav = (languages, userAgent = 'Mozilla/5.0 (Macintosh) Chrome/131.0') => ({ languages, language: languages[0], userAgent })
  assert.equal(browserLocale(nav(['lv-LV', 'en'])), 'lv')
  assert.equal(browserLocale(nav(['de-DE', 'ru'])), 'ru')
  assert.equal(browserLocale(nav(['en-US', 'lt'])), 'en')
  assert.equal(browserLocale(nav(['de', 'fr'])), null)
  assert.equal(browserLocale({ language: 'LV', userAgent: '' }), 'lv')
  assert.equal(browserLocale(nav(['en-US'], 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')), null)
  assert.equal(browserLocale(nav(['en-US'], 'Mozilla/5.0 Chrome-Lighthouse')), null)
  assert.equal(browserLocale(null), null)
  assert.equal(preferredLocale(storage({ champ_locale: 'ru' }), nav(['lv'])), 'ru')
  assert.equal(preferredLocale(storage(), nav(['lv'])), 'lv')
  assert.equal(preferredLocale(storage(), nav(['de'])), 'lt')
  // A shared link's ?lang= beats the browser on a first visit, never a stored choice.
  assert.equal(preferredLocale(storage(), nav(['en-US']), 'lv'), 'lv')
  assert.equal(preferredLocale(storage({ champ_locale: 'ru' }), nav(['en-US']), 'lv'), 'ru')
  assert.equal(preferredLocale(storage(), nav(['en-US']), 'xx'), 'en')
  assert.equal(preferredLocale(storage(), nav(['en-US']), ['lv']), 'en')
  // "/" sends a first-time Latvian visitor to /lv; the default language stays on "/".
  const start = { name: undefined, matched: [] }
  assert.deepEqual(landingLocaleDecision({ params: {} }, start, 'lv'), { redirect: '/lv' })
  assert.deepEqual(landingLocaleDecision({ params: { lang: 'lv' } }, start, 'ru'), { locale: 'lv' })
  assert.deepEqual(landingLocaleDecision({ params: {} }, start, 'xx'), { locale: 'lt' })
})
