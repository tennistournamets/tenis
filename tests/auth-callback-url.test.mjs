import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  authCallbackCleanupLocation, hasAuthCallbackHash, scrubAuthCallbackFromLocation, stripAuthHash,
} from '../src/lib/authCallbackUrl.js'

const TOKENS = '#access_token=at.jwt&expires_at=1&expires_in=3600&provider_token=ya29&refresh_token=rt&token_type=bearer'
const Empty = { render: () => null }

// Same shape as src/router/index.js: Google OAuth lands on /admin, a redirect record sends it on.
function makeRouter(cleanup) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Empty, beforeEnter: () => ({ path: '/admin/tournaments' }) },
      { path: '/admin', component: Empty, redirect: { path: '/admin/tournaments' },
        children: [{ path: 'tournaments', component: Empty }, { path: 'tournaments/:id', component: Empty }] },
    ],
  })
  router.beforeEach(async (to) => {
    await new Promise((r) => setTimeout(r, 1)) // auth.init() awaiting supabase-js URL detection
    if (cleanup) return authCallbackCleanupLocation(to) ?? true
    return true
  })
  return router
}

test('root cause: a redirect record carries the OAuth hash into the final URL', async () => {
  const router = makeRouter(false)
  await router.push(`/admin${TOKENS}`)
  assert.equal(router.currentRoute.value.path, '/admin/tournaments')
  assert.match(router.currentRoute.value.fullPath, /access_token=/)
})

test('guard cleanup removes tokens on every landing path', async () => {
  for (const landing of [`/admin${TOKENS}`, `/admin/tournaments${TOKENS}`, `/${TOKENS}`,
    '/admin#error=access_denied&error_code=bad_oauth_state&error_description=Denied',
    '/admin?code=abc123&sb_flow_id=f1', '/?error=server_error&error_description=oops']) {
    const router = makeRouter(true)
    await router.push(landing)
    const { fullPath, hash, query } = router.currentRoute.value
    assert.equal(fullPath, '/admin/tournaments', landing)
    assert.equal(hash, '')
    assert.deepEqual(query, {})
  }
})

test('ordinary tab hashes and queries are left alone', async () => {
  const router = makeRouter(true)
  await router.push('/admin/tournaments/42?surface=bracket#schedule')
  assert.equal(router.currentRoute.value.fullPath, '/admin/tournaments/42?surface=bracket#schedule')
  assert.equal(authCallbackCleanupLocation({ path: '/x', query: { qr: '1' }, hash: '#entries' }), null)
  assert.equal(hasAuthCallbackHash('#entries'), false)
  assert.equal(hasAuthCallbackHash(TOKENS), true)
  assert.equal(stripAuthHash(`${TOKENS}&tab=bracket`), '#tab=bracket')
})

test('address-bar scrub keeps history.state and the path', () => {
  const state = { back: null, current: '/admin/tournaments', position: 0 }
  const calls = []
  const win = {
    location: { href: `https://app.test/admin/tournaments${TOKENS}` },
    history: { state, replaceState: (...args) => calls.push(args) },
  }
  assert.equal(scrubAuthCallbackFromLocation(win), true)
  assert.deepEqual(calls, [[state, '', '/admin/tournaments']])
  win.location.href = 'https://app.test/admin/tournaments/1#bracket'
  assert.equal(scrubAuthCallbackFromLocation(win), false)
  assert.equal(calls.length, 1)
})
