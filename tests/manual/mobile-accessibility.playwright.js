// Mobile accessibility acceptance for Step 4A. Real Vue components, isolated
// fixtures, and intercepted API traffic; this scenario never writes to Supabase.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open local Vite first')
  const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  const p = await context.newPage()
  p.setDefaultTimeout(10000)
  const checks = [], errors = []
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label) }
  p.on('pageerror', error => errors.push(error.message))
  await context.route('**/auth/v1/**', route => route.fulfill({ json: { user: null, session: null } }))
  await context.routeWebSocket('**/realtime/**', socket => socket.close())

  const entries = [
    { id: 'a', status: 'approved', display_name: 'Alpha International Club', entry_members: [{ member_name: 'Alpha International Club', member_order: 1 }] },
    { id: 'b', status: 'approved', display_name: 'Beta Community Team', entry_members: [{ member_name: 'Beta Community Team', member_order: 1 }] },
  ]
  const entryMap = Object.fromEntries(entries.map(item => [item.id, item]))
  const match = { id: 'm1', tournament_id: 'access', stage: 'winners', round_number: 1, match_number: 1, side_a_entry_id: 'a', side_b_entry_id: 'b', status: 'ready', score_revision: 0, side_a_score: null, side_b_score: null }
  const standings = entries.map((entry, index) => ({ entry_id: entry.id, display_name: entry.display_name, rank: index + 1, played: 0, won: 0, drawn: 0, lost: 0, score_for: 0, score_against: 0, diff: 0, points: 0 }))
  const snapshot = {
    tournament: { id: 'access', slug: 'access', name: 'Международный кубок сообществ', description: 'Турнир для разных видов спорта.', sport: 'football', format: 'round_robin', category: 'singles', status: 'in_progress', scoring_config: {}, settings_revision: 1, is_public: true },
    entries, matches: [match], sets: [], live: [{ id: 'live1', match_id: 'm1', status: 'active', revision: 0, state: {} }], standings, groups: [], group_standings: {},
  }
  await context.route('**/rest/v1/**', route => route.fulfill({ json: route.request().url().includes('/rpc/get_tournament_sync_state') ? snapshot : { id: 'access' } }))

  const minTarget = async locator => locator.evaluateAll(items => items.every(item => {
    const box = item.getBoundingClientRect()
    return box.width >= 43.5 && box.height >= 43.5
  }))

  try {
    await p.goto(`${origin}/?no3d`)
    await p.evaluate(async () => {
      document.querySelector('#app').__vue_app__?.unmount()
      const dep = name => performance.getEntriesByType('resource').find(e => e.name.includes(`/node_modules/.vite/deps/${name}.js?v=`))?.name || `/node_modules/.vite/deps/${name}.js`
      const vue = await import(dep('vue'))
      const { createI18n } = await import(dep('vue-i18n'))
      const { createPinia } = await import(dep('pinia'))
      const { createRouter, createMemoryHistory } = await import(dep('vue-router'))
      const { messages } = await import('/src/i18n/messages.js')
      const { useAuthStore } = await import('/src/stores/auth.js')
      const { supabase } = await import('/src/lib/supabase.js')
      const { default: App } = await import('/src/App.vue')
      window.a11y = { vue, createI18n, createPinia, createRouter, createMemoryHistory, messages, useAuthStore, supabase, app: null, i18n: null, selected: null, viewed: null }
      a11y.mountShell = async locale => {
        a11y.app?.unmount()
        document.querySelector('#app').innerHTML = ''
        const pageComponent = { render: () => vue.h('h1', { id: 'fixture-heading' }, 'Settings fixture') }
        const router = createRouter({ history: createMemoryHistory(), routes: [
          { path: '/admin/settings', name: 'admin-settings', component: pageComponent },
          { path: '/admin/tournaments', name: 'admin-tournaments', component: pageComponent },
        ] })
        await router.push('/admin/settings')
        const pinia = createPinia(), auth = useAuthStore(pinia)
        auth.ready = true
        auth.user = { id: 'fixture', email: 'organizer.with.a.very.long.address@example.test', user_metadata: { full_name: 'Alexandra Tournament Organizer' } }
        auth.tournamentRolesLoaded = true
        a11y.i18n = createI18n({ legacy: false, locale, messages })
        a11y.app = vue.createApp(App)
        a11y.app.use(a11y.i18n).use(pinia).use(router).mount('#app')
        await vue.nextTick()
      }
      a11y.mountList = async locale => {
        a11y.app?.unmount()
        document.querySelector('#app').innerHTML = ''
        const { default: component } = await import('/src/views/AdminTournamentListView.vue')
        supabase.from = () => ({ select() { return this }, eq: async () => ({ data: [{ role: 'owner', tournaments: { id: 'dated', name: 'Dated Cup', slug: 'dated', sport: 'football', format: 'round_robin', category: 'singles', status: 'in_progress', created_at: '2026-06-05T12:00:00Z' } }], error: null }) })
        const pinia = createPinia(), auth = useAuthStore(pinia)
        auth.ready = true; auth.user = { id: 'fixture', email: 'owner@example.test' }; auth.tournamentRolesLoaded = true
        const router = createRouter({ history: createMemoryHistory(), routes: [
          { path: '/admin/tournaments', name: 'admin-tournaments', component },
          { path: '/admin/tournaments/new', name: 'admin-tournament-new', component: { render: () => null } },
          { path: '/admin/tournaments/:id', name: 'admin-tournament', component: { render: () => null } },
        ] })
        await router.push('/admin/tournaments')
        a11y.i18n = createI18n({ legacy: false, locale, messages })
        a11y.app = vue.createApp(component)
        a11y.app.use(a11y.i18n).use(pinia).use(router).mount('#app')
        await vue.nextTick()
      }
      a11y.mount = async (file, props = {}, twice = false) => {
        a11y.app?.unmount()
        document.querySelector('#app').innerHTML = ''
        const { default: component } = await import(`/src/${file}.vue`)
        const renderProps = { ...props,
          onSelectMatch: value => { a11y.selected = value.id },
          onViewLive: value => { a11y.viewed = value.id },
        }
        a11y.selected = null; a11y.viewed = null
        a11y.i18n ||= createI18n({ legacy: false, locale: 'ru', messages })
        a11y.app = vue.createApp({ render: () => twice
          ? vue.h('div', [vue.h(component, renderProps), vue.h(component, renderProps)])
          : vue.h(component, renderProps) })
        a11y.app.use(a11y.i18n).mount('#app')
        await vue.nextTick()
      }
    })

    await p.evaluate(() => a11y.mountShell('ru'))
    for (const [locale, title] of [['ru', 'Настройки'], ['en', 'Settings'], ['lt', 'Nustatymai']]) {
      await p.evaluate(locale => { a11y.i18n.global.locale.value = locale }, locale)
      await p.waitForFunction(locale => document.documentElement.lang === locale, locale)
      check(await p.evaluate(title => document.title.startsWith(title + ' — '), title), `${locale}: localized document title`)
    }
    const profile = p.locator('.profile-menu__trigger')
    check(await minTarget(p.locator('.theme-toggle, .lang-dropdown__trigger, .profile-menu__trigger')), 'header controls are at least 44 × 44 px')
    check((await profile.getAttribute('aria-label')) === 'Paskyros meniu', 'profile trigger has a translated accessible name')
    await profile.focus(); await p.keyboard.press('Enter')
    check(await p.locator('.profile-menu__item').first().evaluate(el => el === document.activeElement), 'profile opens with focus inside')
    await p.keyboard.press('Escape')
    check(await profile.evaluate(el => el === document.activeElement) && await p.locator('.profile-menu__dropdown').count() === 0, 'Escape closes profile and restores focus')
    await p.locator('.skip-link').focus()
    check(await p.locator('.skip-link').evaluate(el => getComputedStyle(el).transform === 'matrix(1, 0, 0, 1, 0, 0)'), 'skip link becomes visible on focus')
    await p.keyboard.press('Enter')
    check(await p.locator('#main-content').evaluate(el => el === document.activeElement), 'skip link moves focus to main content')

    for (const locale of ['ru', 'en', 'lt']) {
      await p.evaluate(locale => a11y.mountList(locale), locale)
      await p.waitForSelector('.t-card__meta')
      const expectedDate = await p.evaluate(locale => new Date('2026-06-05T12:00:00Z').toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }), locale)
      check((await p.locator('.t-card__meta').innerText()).includes(expectedDate), `${locale}: tournament date follows selected locale`)
    }

    await p.evaluate(({ match, entryMap }) => { a11y.i18n.global.locale.value = 'ru'; return a11y.mount('components/FootballScoreEditor', { matches: [match], entriesMap: entryMap }) }, { match, entryMap })
    const scoreLabels = await p.locator('input[type=number]').evaluateAll(inputs => inputs.map(input => input.getAttribute('aria-label')))
    check(scoreLabels.length === 4 && new Set(scoreLabels).size === 4 && scoreLabels.every(label => /Alpha|Beta/.test(label)), 'goals and penalties identify both teams and sides')
    check(await minTarget(p.locator('input[type=number]')), 'football score fields are at least 44 px high')

    await p.evaluate(({ match, entryMap }) => a11y.mount('components/MatchScoreModal', { match, entriesMap: entryMap, family: 'goals', canEditFinal: true }), { match, entryMap })
    check(await minTarget(p.locator('.modal-close')), 'modal close control is 44 × 44 px')
    const contrast = await p.locator('.input').first().evaluate(input => {
      const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
      const lum = color => rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      const style = getComputedStyle(input)
      return ratio(lum(style.borderTopColor), lum(style.backgroundColor))
    })
    check(contrast >= 3, `light input boundary contrast is ${contrast.toFixed(2)}:1`)
    await p.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    const darkContrast = await p.locator('.input').first().evaluate(input => {
      const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number)
      const lum = color => rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      const style = getComputedStyle(input), a = lum(style.borderTopColor), b = lum(style.backgroundColor)
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
    })
    check(darkContrast >= 3, `dark input boundary contrast is ${darkContrast.toFixed(2)}:1`)
    await p.screenshot({ path: 'output/playwright/mobile-accessibility/score-modal-dark-390.png' })

    await p.evaluate(({ standings, match, entryMap }) => a11y.mount('components/RoundRobinStandings', { rows: standings, matches: [match], entriesMap: entryMap, family: 'goals', liveScoresByMatch: { m1: { status: 'active' } } }), { standings, match, entryMap })
    const disclosure = p.getByRole('button', { name: /Матчи участника Alpha/ })
    await disclosure.focus(); await p.keyboard.press('Space')
    const controlled = await disclosure.getAttribute('aria-controls')
    check(await disclosure.getAttribute('aria-expanded') === 'true' && Boolean(controlled) && await p.evaluate(id => Boolean(document.getElementById(id)), controlled), 'standings row expands from keyboard and controls a named panel')
    const liveAction = p.getByRole('button', { name: /Смотреть live: Alpha.*Beta/ })
    await liveAction.focus(); await p.keyboard.press('Enter')
    check(await p.evaluate(() => a11y.viewed === 'm1'), 'live match in standings activates from keyboard')
    check(await p.locator('.rr-standings tbody tr[tabindex]').count() === 0 && await p.locator('.rr-standings th[scope=row]').count() === 2, 'standings use row headers and no clickable table rows')
    check(await p.locator('.rr-standings thead th[aria-label]').count() === 9, 'abbreviated standing columns expose full labels')

    await p.evaluate(({ standings, match, entryMap }) => a11y.mount('components/RoundRobinCrossTable', { standings, matches: [match], entriesMap: entryMap, family: 'goals', clickable: true }), { standings, match, entryMap })
    const matchAction = p.getByRole('button', { name: /Счёт матча: Alpha.*Beta/ }).first()
    await matchAction.focus(); await p.keyboard.press('Enter')
    check(await p.evaluate(() => a11y.selected === 'm1'), 'cross-table match action activates from keyboard')
    check((await matchAction.getAttribute('aria-label')).includes('Alpha International Club') && (await matchAction.getAttribute('aria-label')).includes('Beta Community Team'), 'cross-table action names both teams')

    const stageMatches = [match, { ...match, id: 'm2', stage: 'losers' }, { ...match, id: 'm3', stage: 'grand_final' }]
    await p.evaluate(({ stageMatches, entryMap }) => a11y.mount('components/DoubleElimBoard', { matches: stageMatches, entriesMap: entryMap }, true), { stageMatches, entryMap })
    const controls = await p.locator('.de-tabs [role=tab]').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-controls')))
    check(controls.length === 6 && new Set(controls).size === 6 && await p.evaluate(ids => ids.every(id => document.getElementById(id)), controls), 'multiple brackets have unique tab and panel relationships')
    const firstStage = p.locator('.de-tabs').first().getByRole('tab').first()
    await firstStage.focus(); await p.keyboard.press('ArrowDown')
    check(await p.locator('.de-tabs').first().getByRole('tab').nth(1).getAttribute('aria-selected') === 'true', 'vertical stage tabs respond to ArrowDown')
    check(await p.locator('.de-tabs').first().locator('[role=tab][tabindex="0"]').count() === 1, 'stage tabs keep one keyboard stop')

    await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; localStorage.setItem('champ_locale', 'ru') })
    await p.goto(`${origin}/tournaments/access`)
    await p.waitForSelector('.mobile-surface-switch')
    check(await p.evaluate(() => document.documentElement.lang === 'ru' && document.title === 'Международный кубок сообществ — Bracketa'), 'public tournament sets document language and tournament title')
    const publicTabs = p.locator('.mobile-surface-switch')
    await publicTabs.getByRole('tab').first().focus(); await p.keyboard.press('ArrowRight')
    check(await publicTabs.getByRole('tab').nth(1).getAttribute('aria-selected') === 'true' && await publicTabs.getByRole('tab').nth(1).evaluate(el => el === document.activeElement), 'public surface switches and focuses with ArrowRight')
    check(await p.locator('#pub-mobile-panel').getAttribute('aria-labelledby') === 'pub-tab-overview', 'public panel follows the active tab label')
    await p.keyboard.press('Home')
    check(await publicTabs.getByRole('tab').first().getAttribute('aria-selected') === 'true', 'Home returns to the first surface')
    check(await minTarget(publicTabs.getByRole('tab')), 'mobile surface tabs are at least 44 px high')
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'accessible public view has no horizontal overflow at 390 px')
    await p.screenshot({ path: 'output/playwright/mobile-accessibility/public-tournament-390.png', fullPage: true })

    check(errors.length === 0, `No browser exceptions: ${errors.join('; ')}`)
    return { passed: checks.length, checks, contrast: { light: contrast, dark: darkContrast } }
  } finally {
    await context.close()
  }
}
