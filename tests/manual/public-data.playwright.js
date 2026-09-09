// Run via playwright_cli.sh -s=public11 run-code --filename=tests/manual/public-data.playwright.js
// Requires a local Vite page. Mounts the actual public page, intercepts REST
// and replaces Realtime with an in-memory channel. No server data is changed.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open the local Vite page first')
  const checks = [], errors = []
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label) }
  page.setDefaultTimeout(10000)
  const onError = error => errors.push(error.message)
  page.on('pageerror', onError)
  await page.route('**/rest/v1/**', route => route.fulfill({ json: [] }))
  await page.route('**/auth/v1/**', route => route.fulfill({ json: { user: null, session: null } }))
  await page.goto(origin)
  await page.evaluate(async () => {
    document.querySelector('#app').__vue_app__?.unmount()
    const vue = await import('/node_modules/.vite/deps/vue.js')
    const { createI18n } = await import('/node_modules/.vite/deps/vue-i18n.js')
    const { createRouter, createMemoryHistory } = await import('/node_modules/.vite/deps/vue-router.js')
    const { messages } = await import('/src/i18n/messages.js')
    const { supabase } = await import('/src/lib/supabase.js')
    const { default: component } = await import('/src/views/PublicTournamentView.vue')
    const i18n = createI18n({ legacy: false, locale: 'ru', messages })
    window.pd = { vue, i18n, app: null, channels: [], sources: {}, calls: [], lookupError: false, snapshotError: false }
    pd.fixture = (id, slug, format = 'single_elimination') => ({
      tournament: { id, slug, name: `Tournament ${id}`, category: 'singles', sport: 'tennis', format,
        status: 'in_progress', is_public: true },
      entries: [], matches: [], sets: [], live: [], groups: [], standings: [], group_standings: {},
    })
    supabase.from = table => ({ select: () => ({ eq: (key, slug) => ({ maybeSingle: async () => {
      if (table !== 'tournaments' || key !== 'slug') throw new Error('Unexpected lookup')
      pd.calls.push({ type: 'lookup', slug })
      if (pd.lookupError) return { data: null, error: { message: 'PRIVATE_LOOKUP_ERROR' } }
      const source = Object.values(pd.sources).find(value => value?.tournament.slug === slug)
      return { data: source ? { id: source.tournament.id } : null, error: null }
    } }) }) })
    supabase.rpc = async (name, args) => {
      if (name !== 'get_tournament_sync_state') throw new Error(`Unexpected RPC ${name}`)
      const id = args.p_tournament_id
      pd.calls.push({ type: 'snapshot', id })
      const data = pd.sources[id] ? structuredClone(pd.sources[id]) : null
      if (pd.delayId === id) {
        pd.delayId = null
        await new Promise(resolve => { pd.releaseRead = resolve })
      }
      if (pd.snapshotError) return { data: null, error: { message: 'PRIVATE_SNAPSHOT_ERROR' } }
      return { data, error: null }
    }
    supabase.channel = name => {
      const channel = { name, removed: false, bindings: [],
        on(type, filter, callback) { this.bindings.push({ type, filter, callback }); return this },
        subscribe(callback) { this.callback = callback; return this },
      }
      pd.channels.push(channel)
      return channel
    }
    supabase.removeChannel = async channel => { channel.removed = true }
    pd.mount = async (slug, config = {}) => {
      pd.app?.unmount()
      pd.calls = []; pd.channels = []; pd.lookupError = false; pd.snapshotError = false
      pd.delayId = null; pd.releaseRead = null
      Object.assign(pd, config)
      document.querySelector('#app').innerHTML = ''
      pd.props = vue.reactive({ slug })
      const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] })
      pd.app = vue.createApp({ render: () => vue.h(component, pd.props) })
      pd.app.use(i18n).use(router).mount('#app')
      await vue.nextTick()
    }
  })

  await page.evaluate(() => pd.mount('cup', { lookupError: true, sources: {} }))
  await page.waitForSelector('[role=alert]')
  for (const locale of ['ru', 'en', 'lt']) {
    await page.evaluate(locale => { pd.i18n.global.locale.value = locale }, locale)
    const copy = await page.evaluate(() => ({ failed: pd.i18n.global.t('sync.loadFailed'), hint: pd.i18n.global.t('sync.loadFailedHint'), retry: pd.i18n.global.t('sync.retry') }))
    check(await page.locator('.empty-state__title').innerText() === copy.failed, `${locale}: initial network failure has a translated load error`)
    check(await page.locator('.empty-state__hint').innerText() === copy.hint && await page.getByRole('button', { name: copy.retry, exact: true }).count() === 1, `${locale}: load failure offers translated explanation and retry`)
  }
  check(!(await page.locator('body').innerText()).includes('PRIVATE_LOOKUP_ERROR'), 'Backend error details are not exposed to visitors')
  await page.evaluate(() => { pd.lookupError = false; pd.sources.a = pd.fixture('a', 'cup') })
  await page.getByRole('button', { name: await page.evaluate(() => pd.i18n.global.t('sync.retry')), exact: true }).click()
  await page.waitForSelector('h1')
  check(await page.locator('h1').innerText() === 'Tournament a' && await page.getByRole('alert').count() === 0, 'Manual retry recovers the public page from an initial network failure')

  await page.evaluate(() => pd.mount('missing', { sources: {} }))
  await page.waitForSelector('[role=alert]')
  for (const locale of ['ru', 'en', 'lt']) {
    await page.evaluate(locale => { pd.i18n.global.locale.value = locale }, locale)
    check(await page.locator('.empty-state__title').innerText() === await page.evaluate(() => pd.i18n.global.t('errors.notFound')), `${locale}: absent tournament is distinct from a network failure`)
  }
  check(await page.evaluate(() => pd.calls.every(call => call.type === 'lookup') && pd.channels.length === 0), 'Absent tournament starts no snapshot query or subscription')
  await page.evaluate(() => { pd.sources.a = pd.fixture('a', 'missing') })
  await page.getByRole('button', { name: await page.evaluate(() => pd.i18n.global.t('sync.retry')), exact: true }).click()
  await page.waitForSelector('h1')
  check(await page.locator('h1').innerText() === 'Tournament a', 'Manual retry discovers a newly visible tournament after not-found')

  await page.evaluate(() => pd.mount('focus-cup', { sources: {} }))
  await page.waitForSelector('.empty-state[role=alert]')
  await page.evaluate(() => { pd.sources.a = pd.fixture('a', 'focus-cup'); window.dispatchEvent(new Event('focus')) })
  await page.waitForSelector('h1')
  check(await page.locator('h1').innerText() === 'Tournament a' && await page.evaluate(() => pd.channels.length === 1 && !pd.channels[0].removed), 'Focus recovers an initially absent tournament and starts its subscription')

  for (const format of ['single_elimination', 'round_robin', 'groups_playoff', 'double_elimination']) {
    await page.evaluate(format => pd.mount('cup', { sources: { a: pd.fixture('a', 'cup', format) } }), format)
    await page.waitForSelector('h1')
    check(await page.locator('.empty-state[role=status]').innerText() === await page.evaluate(() => pd.i18n.global.t('bracket.empty')), `${format}: a valid tournament with no matches displays the empty bracket state`)
    check(await page.getByRole('alert').count() === 0, `${format}: empty data is not a loading error`)
  }

  const beforeRefresh = await page.evaluate(() => ({ lookups: pd.calls.filter(call => call.type === 'lookup').length, reads: pd.calls.filter(call => call.type === 'snapshot').length }))
  await page.evaluate(() => { pd.sources.a.tournament.name = 'Fresh snapshot'; window.dispatchEvent(new Event('online')) })
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Fresh snapshot')
  check(await page.evaluate(before => pd.calls.filter(call => call.type === 'lookup').length === before.lookups && pd.calls.filter(call => call.type === 'snapshot').length === before.reads + 1, beforeRefresh), 'Refresh uses exactly one RPC and no additional slug lookup')

  await page.evaluate(() => { pd.snapshotError = true; window.dispatchEvent(new Event('online')) })
  await page.waitForSelector('.alert--error[role=status]')
  check(await page.locator('h1').innerText() === 'Fresh snapshot', 'Transient refresh failure preserves the last good tournament')
  check(await page.getByRole('alert').count() === 0 && !(await page.locator('body').innerText()).includes('PRIVATE_SNAPSHOT_ERROR'), 'Refresh failure is distinguished from initial failure and hides backend details')
  await page.evaluate(() => { pd.snapshotError = false; pd.sources.a.tournament.name = 'Recovered snapshot' })
  await page.getByRole('button', { name: await page.evaluate(() => pd.i18n.global.t('sync.retry')), exact: true }).click()
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Recovered snapshot')
  check(await page.locator('.alert--error[role=status]').count() === 0, 'Retry replaces the stale snapshot and clears its refresh warning')

  await page.evaluate(() => { pd.sources.a = null; pd.lookupError = true; window.dispatchEvent(new Event('online')) })
  await page.waitForSelector('.empty-state[role=alert]')
  check(await page.locator('h1').count() === 0 && !(await page.locator('body').innerText()).includes('Recovered snapshot'), 'Access loss clears old tournament data even when the next slug lookup fails')
  check(await page.evaluate(() => pd.channels.every(channel => channel.removed)), 'Access loss removes the old Realtime subscription')
  check(await page.locator('.empty-state__title').innerText() === await page.evaluate(() => pd.i18n.global.t('sync.loadFailed')), 'Failed access recheck remains a recoverable load error')

  await page.evaluate(() => pd.mount('restore-cup', { sources: { a: pd.fixture('a', 'restore-cup') } }))
  await page.waitForSelector('h1')
  await page.evaluate(() => { pd.sources.a = null; window.dispatchEvent(new Event('online')) })
  await page.waitForSelector('.empty-state[role=alert]')
  check(await page.locator('h1').count() === 0 && await page.locator('.empty-state__title').innerText() === await page.evaluate(() => pd.i18n.global.t('errors.notFound')), 'A successful absent snapshot clears a revoked tournament without a network error')
  check(await page.evaluate(() => pd.channels.length === 1 && pd.channels[0].removed), 'A revoked tournament has no active Realtime subscription')
  await page.evaluate(() => { pd.sources.a = pd.fixture('a', 'restore-cup'); window.dispatchEvent(new Event('online')) })
  await page.waitForSelector('h1')
  check(await page.locator('h1').innerText() === 'Tournament a' && await page.evaluate(() => pd.channels.length === 2 && !pd.channels[1].removed), 'Online recovery restores access and reconnects after the old subscription was removed')

  await page.evaluate(() => pd.mount('old', { sources: { a: pd.fixture('a', 'old'), b: pd.fixture('b', 'new') } }))
  await page.waitForSelector('h1')
  await page.evaluate(() => { pd.delayId = 'a'; pd.sources.a.tournament.name = 'Late old snapshot'; window.dispatchEvent(new Event('online')) })
  await page.waitForFunction(() => Boolean(pd.releaseRead))
  await page.evaluate(() => { pd.props.slug = 'new' })
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Tournament b')
  check(await page.evaluate(() => pd.channels.length === 2 && pd.channels[0].removed && !pd.channels[1].removed && pd.channels[1].name === 'public-b'), 'Route changes remove the previous subscription and subscribe to the new tournament')
  await page.evaluate(async () => { pd.releaseRead(); await pd.vue.nextTick() })
  check(await page.locator('h1').innerText() === 'Tournament b', 'A late read for the previous slug cannot replace the new tournament')
  const callsAfterRouteChange = await page.evaluate(() => pd.calls.length)
  await page.evaluate(() => {
    const old = pd.channels[0]
    old.callback('SUBSCRIBED')
    old.bindings.find(binding => binding.filter.table === 'tournaments' && binding.filter.event === 'UPDATE').callback({ table: 'tournaments', eventType: 'UPDATE', new: { id: 'a' } })
  })
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)))
  check(await page.evaluate(before => pd.calls.length === before, callsAfterRouteChange), 'Events from the disposed subscription do not trigger reads for the new route')

  // Keep the real scheduler/coalescer, but shorten only the recovery interval
  // while mounting this fixture so the browser test does not wait 30 seconds.
  await page.evaluate(async () => {
    const originalSetInterval = window.setInterval
    window.setInterval = (callback, delay, ...args) => originalSetInterval(callback, delay === 30000 ? 100 : delay, ...args)
    try { await pd.mount('poll-cup', { sources: {} }) }
    finally { window.setInterval = originalSetInterval }
  })
  await page.waitForSelector('.empty-state[role=alert]')
  await page.evaluate(() => { pd.sources.a = pd.fixture('a', 'poll-cup') })
  await page.waitForSelector('h1')
  check(await page.locator('h1').innerText() === 'Tournament a' && await page.evaluate(() => pd.calls.filter(call => call.type === 'lookup').length >= 2), 'Polling recovers an absent tournament without clicks, focus or online events')
  await page.evaluate(() => pd.app.unmount())
  check(await page.evaluate(() => pd.channels.every(channel => channel.removed)), 'Unmount removes the remaining subscription')
  const callsAfterUnmount = await page.evaluate(() => pd.calls.length)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)))
  check(await page.evaluate(before => pd.calls.length === before, callsAfterUnmount), 'Unmount stops online, focus, visibility and polling refreshes')
  check(errors.length === 0, `No uncaught browser errors: ${errors.join('; ')}`)
  page.off('pageerror', onError)
  await page.goto('about:blank')
  await page.unroute('**/rest/v1/**')
  await page.unroute('**/auth/v1/**')
  return { passed: checks.length, checks }
}
