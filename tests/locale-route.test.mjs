import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_LOCALE, LANDING_ROUTE_PATH, landingLocaleDecision, landingPath, pathLocale, readStoredLocale, storeLocale } from '../src/lib/localeRoute.js'

const storage = (initial = {}) => {
  const data = { ...initial }
  return { getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value }, data }
}

test('landing paths: Lithuanian is the default and has no prefix, en and ru have one', () => {
  assert.equal(DEFAULT_LOCALE, 'lt')
  assert.equal(landingPath('lt'), '/')
  assert.equal(landingPath('en'), '/en')
  assert.equal(landingPath('ru'), '/ru')
  assert.equal(landingPath('de'), '/')
  assert.equal(LANDING_ROUTE_PATH, '/:lang(ru|en)?')
})

test('the URL names the landing language; other pages name none', () => {
  assert.equal(pathLocale('/'), 'lt')
  assert.equal(pathLocale('/ru'), 'ru')
  assert.equal(pathLocale('/en/'), 'en')
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
