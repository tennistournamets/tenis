// Run via Playwright CLI on a local Vite page. Actual Vue components and App
// shell; auth, RPC and Realtime use isolated fixtures. No real database writes.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open local Vite first')
  const context = await page.context().browser().newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  const p = await context.newPage()
  p.setDefaultTimeout(10000)
  const checks = [], measurements = [], errors = []
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label) }
  p.on('pageerror', error => errors.push(error.message))
  await context.route('**/auth/v1/**', route => route.fulfill({ json: { user: null, session: null } }))
  await context.routeWebSocket('**/realtime/**', socket => socket.close())
  const fixture = (sport = 'tennis', format = 'single_elimination', status = 'in_progress') => {
    const entries = Array.from({ length: 16 }, (_, i) => ({ id: `e${i}`, status: 'approved', display_name: `${i + 1} Александра Петраускайте-Янкаускене`, entry_members: [{ member_name: `${i + 1} Александра Петраускайте-Янкаускене` }] }))
    const matches = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, tournament_id: 'mobile', stage: format === 'groups_playoff' ? 'group' : 'winners', group_id: format === 'groups_playoff' ? 'g1' : null, round_number: 1, match_number: i + 1, side_a_entry_id: `e${i * 2}`, side_b_entry_id: `e${i * 2 + 1}`, status: 'ready', score_revision: 0, side_a_score: null, side_b_score: null }))
    const standings = entries.map((entry, i) => ({ entry_id: entry.id, display_name: entry.display_name, rank: i + 1, played: 0, won: 0, lost: 0, drawn: 0, score_for: 0, score_against: 0, points: 0 }))
    return { tournament: { id: 'mobile', slug: 'mobile', name: 'Кубок городского сообщества', description: 'Открытый турнир для участников сообщества.', category: sport === 'padel' ? 'doubles' : 'singles', sport, format, status, set_format: 'best_of_5', scoring_config: {}, settings_revision: 1, is_public: true }, entries, matches, sets: [], live: [], standings: format === 'round_robin' ? standings : [], groups: format === 'groups_playoff' ? [{ id: 'g1', name: 'A', group_number: 1 }] : [], group_standings: { g1: standings } }
  }
  let source = fixture()
  await context.route('**/rest/v1/**', route => route.fulfill({ json: route.request().url().includes('/rpc/get_tournament_sync_state') ? source : { id: 'mobile' } }))
  const fit = async label => {
    const result = await p.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }))
    measurements.push({ label, ...result })
    check(result.document <= result.viewport + 1, `${label}: page fits (${result.document}/${result.viewport})`)
  }
  try {
    for (const width of [320, 390, 430, 768]) for (const locale of ['ru', 'en', 'lt']) {
      await p.setViewportSize({ width, height: width === 320 ? 568 : 844 })
      await p.goto(origin + '/?no3d')
      await p.evaluate(locale => localStorage.setItem('champ_locale', locale), locale)
      for (const [format, status] of [['single_elimination', 'registration_open'], ['groups_playoff', 'in_progress']]) {
        source = fixture('tennis', format, status)
        await p.goto(origin + '/tournaments/mobile')
        await p.waitForSelector('.pub-hero')
        await fit(`${locale}/${width}/${format}/${status}`)
        if (status === 'registration_open') {
          const separate = await p.locator('.participant-item').evaluateAll(items => items.every(item => {
            const name = item.querySelector('strong').getBoundingClientRect(), badge = item.querySelector('.badge').getBoundingClientRect()
            return name.right <= badge.left || name.bottom <= badge.top || badge.bottom <= name.top
          }))
          check(separate, `${locale}/${width}: participant name and status do not overlap`)
        }
        if (width === 320 && locale === 'ru') {
          if (status === 'registration_open') await p.locator('#reg-contact').scrollIntoViewIfNeeded()
          await p.screenshot({ path: `output/playwright/mobile-foundation/public-${format}-320.png` })
        }
      }
    }
    await p.goto(origin + '/?no3d')
    await p.evaluate(async () => {
      document.querySelector('#app').__vue_app__?.unmount()
      const dep = name => performance.getEntriesByType('resource').find(e => e.name.includes(`/node_modules/.vite/deps/${name}.js?v=`))?.name || `/node_modules/.vite/deps/${name}.js`
      const vue = await import(dep('vue')), { createI18n } = await import(dep('vue-i18n')), { createPinia } = await import(dep('pinia')), { createRouter, createMemoryHistory } = await import(dep('vue-router'))
      const { messages } = await import('/src/i18n/messages.js'), { useAuthStore } = await import('/src/stores/auth.js'), { supabase } = await import('/src/lib/supabase.js'), { default: App } = await import('/src/App.vue')
      window.mf = { data: null, role: 'owner', app: null, mode: '', calls: [], locale: 'ru', theme: 'light' }
      supabase.rpc = async (name, args) => {
        mf.calls.push({ name, args })
        if (name === 'get_tournament_sync_state') return { data: structuredClone(mf.data), error: null }
        if (name === 'get_my_tournament_role') return { data: mf.role, error: null }
        if (name === 'get_tournament_admins_with_email') return { data: [], error: null }
        if (name === 'start_live_match') return { data: { id: 'live-fixture', match_id: args.p_match_id, revision: 0, status: 'active', state: { points: { a: 0, b: 0 }, games: { a: 0, b: 0 }, sets: [], winner: null } }, error: null }
        if (name === 'create_tournament') {
          if (mf.mode === 'delay') await new Promise(resolve => { mf.release = resolve })
          if (mf.mode === 'throw') throw new Error('Synthetic network failure')
          if (mf.mode === 'duplicate') return { data: null, error: { code: '23505' } }
          return { data: 'new-fixture', error: null }
        }
        throw new Error('Unexpected fixture RPC: ' + name)
      }
      supabase.channel = () => { const channel = { on: () => channel, subscribe: () => channel }; return channel }
      supabase.removeChannel = async () => {}
      mf.mount = async (file, props = {}) => {
        mf.app?.unmount(); mf.calls = []; mf.mode = ''; history.replaceState(null, '', location.pathname)
        document.querySelector('#app').innerHTML = ''
        const pinia = createPinia(), auth = useAuthStore(pinia)
        auth.ready = true; auth.user = { id: 'fixture', email: 'alexander.organizer.international.tournament@example.com', user_metadata: {} }; auth.tournamentRolesLoaded = true
        const { default: component } = await import(`/src/${file}.vue`)
        const router = createRouter({ history: createMemoryHistory(), routes: [
          { path: '/admin/current', name: 'mobile-current', component, props },
          { path: '/admin', name: 'admin-tournaments', component: { render: () => null } },
          { path: '/admin/:id', name: 'admin-tournament', component: { render: () => null } },
          { path: '/tournaments/:slug', name: 'public-tournament', component: { render: () => null } },
        ] })
        await router.push('/admin/current')
        mf.i18n = createI18n({ legacy: false, locale: mf.locale, messages })
        document.documentElement.dataset.theme = mf.theme
        mf.app = vue.createApp(App); mf.app.use(mf.i18n).use(pinia).use(router).mount('#app'); await vue.nextTick()
      }
    })
    for (const width of [320, 390, 430, 768]) for (const locale of ['ru', 'en', 'lt']) {
      await p.setViewportSize({ width, height: width === 320 ? 568 : 844 })
      await p.evaluate(async ({ data, locale }) => { mf.data = data; mf.locale = locale; mf.role = 'owner'; await mf.mount('views/AdminTournamentView', { id: 'mobile' }) }, { data: fixture(), locale })
      await p.waitForSelector('#adm-tournament-title'); await fit(`admin/${width}/${locale}`)
      if (width === 320 && locale === 'ru') { await p.locator('.admin-tournament-overview__actions').scrollIntoViewIfNeeded(); await p.screenshot({ path: 'output/playwright/mobile-foundation/admin-320.png' }) }
      await p.evaluate(() => mf.mount('views/AdminSettingsView')); await p.waitForSelector('.account-identity'); await fit(`settings/${width}/${locale}`)
      await p.evaluate(() => mf.mount('views/AdminTournamentCreateView')); await p.waitForSelector('.wizard__heading')
      for (let step = 1; step <= 3; step++) {
        if (step > 1) { await p.locator('.wizard__foot .btn--primary').click(); await p.waitForTimeout(50) }
        await fit(`wizard/${step}/${width}/${locale}`)
        const progress = await p.locator('.wizard__step-count').boundingBox()
        check(progress && progress.y >= 0 && progress.y + progress.height <= p.viewportSize().height, `${locale}/${width}/${step}: progress in viewport`)
        if (step > 1) {
          const focus = await p.locator('.wizard__heading').evaluate(e => ({ headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom, focused: document.activeElement === e, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom }))
          check(focus.focused && focus.top >= focus.headerBottom && focus.bottom <= p.viewportSize().height, `${locale}/${width}/${step}: heading visible and focused`)
        }
      }
      if (width === 320 && locale === 'ru') await p.screenshot({ path: 'output/playwright/mobile-foundation/wizard-step3-320.png' })
    }
    await p.setViewportSize({ width: 390, height: 844 })
    for (const sport of ['tennis', 'padel', 'football']) for (const format of ['single_elimination', 'round_robin', 'groups_playoff', 'double_elimination']) for (const role of ['owner', 'editor', 'counter']) {
      const label = `${sport}/${format}/${role}`
      await p.evaluate(async ({ data, role }) => { mf.locale = 'ru'; mf.data = data; mf.role = role; await mf.mount('views/AdminTournamentView', { id: 'mobile' }) }, { data: fixture(sport, format), role })
      await p.waitForSelector('#tab-scores')
      if (sport === 'football' && role === 'counter') {
        check(await p.locator('#tab-scores').isDisabled() && await p.getByText('В футболе итоговый счёт', { exact: false }).isVisible(), `${label}: unavailable action explained`)
        check(await p.locator('.match-card__score-btn:visible').count() === 0, `${label}: no forbidden score action`)
        continue
      }
      await p.locator('#tab-scores').click()
      check(await p.locator('#panel-scores').isVisible(), `${label}: score tab opens`)
      if (sport !== 'football') {
        if (format === 'round_robin') {
          await p.locator('#panel-scores button.rr-cross__result').first().click()
          if (role !== 'counter') await p.locator('.msm-actions .btn--ghost').click()
        } else await p.locator('#panel-scores .score-match__actions .btn--ghost').first().click()
        await p.waitForSelector('.live-modal')
        check(await p.evaluate(() => mf.calls.some(c => c.name === 'start_live_match')), `${label}: permitted LIVE starts`)
        if (role === 'counter') check(await p.locator('.live-modal .btn--danger').count() === 0, `${label}: counter has no stop action`)
        await p.keyboard.press('Escape')
      } else if (format === 'single_elimination' || format === 'double_elimination') {
        await p.locator('#tab-bracket').click()
        await p.locator('.match-card__score-btn:visible').first().click()
        await p.waitForSelector('.msm-goals')
        check(await p.locator('.live-modal').count() === 0 && !await p.evaluate(() => mf.calls.some(c => c.name === 'start_live_match')), `${label}: bracket opens goals without tennis RPC`)
        await p.keyboard.press('Escape')
      }
    }
    await p.setViewportSize({ width: 320, height: 568 })
    await p.evaluate(async () => { mf.locale = 'ru'; mf.theme = 'dark'; await mf.mount('views/AdminTournamentCreateView') })
    await p.locator('.wizard__foot .btn--primary').click(); await p.locator('.wizard__foot .btn--primary').click()
    await p.locator('#create-name').fill('Кубок города')
    check((await p.locator('#create-slug-preview').innerText()).endsWith('/tournaments/kubok-goroda'), 'Slug: exact normalized preview before submission')
    await p.locator('#create-slug').fill('---'); await p.locator('.wizard__foot .btn--primary').click()
    check(await p.locator('#create-slug-error').isVisible() && !await p.evaluate(() => mf.calls.some(c => c.name === 'create_tournament')), 'Slug: punctuation-only manual address rejected without RPC')
    await p.locator('#create-slug').fill(''); await p.evaluate(() => { mf.mode = 'duplicate' }); await p.locator('.wizard__foot .btn--primary').click()
    check(await p.locator('#create-slug').getAttribute('aria-invalid') === 'true' && await p.locator('#create-name').inputValue() === 'Кубок города', 'Slug: conflict preserves form and identifies address field')
    await p.locator('#create-slug').fill('Žalgirio taurė'); await p.evaluate(() => { mf.mode = 'throw' }); await p.locator('.wizard__foot .btn--primary').click()
    check(await p.locator('.wizard__form [role=alert]').isVisible() && await p.locator('.wizard__foot .btn--primary').isEnabled(), 'Wizard: network exception preserves form and releases submit')
    await fit('wizard/dark/errors/320')
    await p.evaluate(() => { mf.mode = 'delay'; mf.calls = [] }); await p.locator('.wizard__foot .btn--primary').click()
    check(await p.locator('.wizard__foot .btn--primary').isDisabled(), 'Wizard: pending creation blocks repeated taps')
    await p.evaluate(() => { mf.mode = ''; mf.release() }); await p.waitForSelector('.wizard', { state: 'detached' })
    check(await p.evaluate(() => mf.calls.filter(c => c.name === 'create_tournament').length === 1 && mf.calls.find(c => c.name === 'create_tournament').args.p_slug === 'zalgirio-taure'), 'Wizard: one creation uses displayed Lithuanian slug')
    check(errors.length === 0, `No browser exceptions: ${errors.join('; ')}`)
    return { passed: checks.length, checks, measurements }
  } finally { await context.close() }
}
