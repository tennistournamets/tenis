import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { cleanReferrer, initAnalytics, pageUrl, resetAnalytics, track, trackPageview } from '../src/lib/analytics.js'

function fakeDom() {
  const listeners = {}
  const script = { dataset: {}, addEventListener: (name, fn) => { listeners[name] = fn } }
  const doc = { head: { children: [], appendChild(node) { this.children.push(node) } }, createElement: () => script, referrer: '' }
  const win = { document: doc, location: { origin: 'https://bracketa.lt' } }
  return { doc, win, script, load: () => listeners.load?.() }
}

function fakeUmami() {
  const calls = []
  return { calls, track: (...args) => calls.push(args) }
}

beforeEach(() => resetAnalytics())

test('analytics stays off without a website id', () => {
  const { doc, win } = fakeDom()
  assert.equal(initAnalytics({}, doc, win), false)
  assert.equal(doc.head.children.length, 0)
  win.umami = fakeUmami()
  track('x', null, win)
  assert.equal(win.umami.calls.length, 0)
})

test('the tracker loads with auto-tracking off and flushes queued events once ready', () => {
  const { doc, win, script, load } = fakeDom()
  assert.equal(initAnalytics({ VITE_UMAMI_WEBSITE_ID: 'site-1', VITE_UMAMI_DOMAINS: 'bracketa.lt' }, doc, win), true)
  assert.equal(script.src, 'https://cloud.umami.is/script.js')
  assert.equal(script.dataset.websiteId, 'site-1')
  assert.equal(script.dataset.autoTrack, 'false')
  assert.equal(script.dataset.domains, 'bracketa.lt')
  track('tournament_created', { sport: 'padel' }, win)
  track('share_link_copied', null, win)
  win.umami = fakeUmami()
  load()
  assert.deepEqual(win.umami.calls, [['tournament_created', { sport: 'padel' }], ['share_link_copied']])
})

test('page URLs keep utm tags only and collapse admin ids', () => {
  assert.equal(pageUrl({ path: '/admin/tournaments/2f1c-uuid', params: { id: '2f1c-uuid' }, query: { tab: 'x' } }), '/admin/tournaments/:id')
  assert.equal(pageUrl({ path: '/tournaments/vilnius-open', params: { slug: 'vilnius-open' }, query: { utm_source: 'bracketa', code: 'secret', access_token: 't' } }), '/tournaments/vilnius-open?utm_source=bracketa')
  assert.equal(pageUrl(null), '/')
})

test('page views send a clean url and the external referrer only on the first view', () => {
  const { doc, win } = fakeDom()
  initAnalytics({ VITE_UMAMI_WEBSITE_ID: 'site-1' }, doc, win)
  win.umami = fakeUmami()
  doc.referrer = 'https://www.google.com/search?q=padel+turnyras'
  trackPageview({ name: 'home', path: '/', query: { code: 'oauth-code' } }, win)
  trackPageview({ name: 'public-tournament', path: '/tournaments/a', query: {} }, win)
  const payloads = win.umami.calls.map(([fn]) => fn({ website: 'site-1', url: '/leak?code=1', title: 'Old' }))
  assert.deepEqual(payloads[0], { website: 'site-1', url: '/', title: 'home', referrer: 'https://www.google.com/search' })
  assert.deepEqual(payloads[1], { website: 'site-1', url: '/tournaments/a', title: 'public-tournament', referrer: '' })
})

test('referrers from the site itself or unparsable ones are dropped', () => {
  assert.equal(cleanReferrer('https://bracketa.lt/admin?x=1', 'https://bracketa.lt'), '')
  assert.equal(cleanReferrer('', 'https://bracketa.lt'), '')
  assert.equal(cleanReferrer('https://t.me/padel_vilnius?start=1', 'https://bracketa.lt'), 'https://t.me/padel_vilnius')
})
