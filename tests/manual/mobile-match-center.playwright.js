// Mobile Step 2 browser acceptance. Run through playwright_cli.sh against local Vite.
// Uses real Vue components with isolated fixtures and never writes to the database.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open local Vite first')
  const context = await page.context().browser().newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  const p = await context.newPage()
  p.setDefaultTimeout(10000)
  const checks = []
  const errors = []
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label) }
  p.on('pageerror', error => errors.push(error.message))
  await context.route('**/auth/v1/**', route => route.fulfill({ json: { user: null, session: null } }))
  await context.routeWebSocket('**/realtime/**', socket => socket.close())

  const entries = Array.from({ length: 20 }, (_, i) => ({
    id: `e${i}`, status: 'approved', display_name: `${i + 1} Александра Петраускайте-Янкаускене`,
    entry_members: [{ member_name: `${i + 1} Александра Петраускайте-Янкаускене`, member_order: 1 }],
  }))
  const matches = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, tournament_id: 'mobile-stage2', stage: i < 4 ? 'winners' : i < 7 ? 'losers' : 'grand_final',
    round_number: i < 7 ? 1 : 2, match_number: i + 1, side_a_entry_id: `e${i * 2}`, side_b_entry_id: `e${i * 2 + 1}`,
    status: i === 0 ? 'ready' : i < 4 ? 'finished' : 'ready', winner_entry_id: i > 0 && i < 4 ? `e${i * 2}` : null,
    side_a_score: i > 0 && i < 4 ? 2 : null, side_b_score: i > 0 && i < 4 ? 0 : null, score_revision: 0,
  }))
  const live = [{ id: 'l0', match_id: 'm0', status: 'active', revision: 0, state: { points: { a: 2, b: 1 }, games: { a: 3, b: 2 }, sets: [] } }]
  const snapshot = {
    tournament: { id: 'mobile-stage2', slug: 'mobile-stage2', name: 'Большой городской турнир', description: 'Длинное описание с регламентом, адресом и условиями участия.', sport: 'football', format: 'double_elimination', category: 'singles', status: 'in_progress', set_format: null, scoring_config: {}, settings_revision: 1, is_public: true, publish_contact: true, contact_phone: '+370 600 00000', contact_email: 'cup@example.test' },
    entries, matches, sets: [], live, groups: [], standings: [], group_standings: {},
  }
  await context.route('**/rest/v1/**', route => route.fulfill({ json: route.request().url().includes('/rpc/get_tournament_sync_state') ? snapshot : { id: 'mobile-stage2' } }))

  try {
    for (const width of [320, 390]) {
      await p.setViewportSize({ width, height: width === 320 ? 568 : 844 })
      await p.goto(`${origin}/tournaments/mobile-stage2`)
      await p.waitForSelector('.match-center')
      check(await p.locator('.mobile-match').count() === 7, `${width}: current filter shows live and ready matches`)
      check(await p.locator('.infinite-canvas').count() === 0, `${width}: bracket canvas is not the initial mobile surface`)
      const heroHeight = await p.locator('.pub-hero').evaluate(el => el.getBoundingClientRect().height)
      check(heroHeight < 300, `${width}: compact tournament header (${Math.round(heroHeight)}px)`)
      check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}: public page has no horizontal overflow`)
      await p.locator('.match-center__search input').fill('19 Александра')
      check(await p.locator('.mobile-match').count() === 1, `${width}: participant search narrows the list`)
      await p.locator('.match-center__search input').fill('')
      await p.getByRole('button', { name: /Завершённые/ }).click()
      check(await p.locator('.mobile-match').count() === 3, `${width}: finished filter works`)
      await p.getByRole('tab', { name: /Сетка и таблицы/ }).click()
      check(await p.locator('.de-tabs').isVisible(), `${width}: double elimination overview opens stage tabs`)
      check(await p.locator('.de-tabs [role=tab]').count() === 3, `${width}: winners, losers and final are separated`)
      check(await p.locator('.de-panel:visible').count() === 1, `${width}: one double-elimination panel is visible`)
      check(await p.locator('.infinite-canvas:visible').evaluate(el => getComputedStyle(el).touchAction) === 'pan-y', `${width}: bracket lets the page handle vertical swipes`)
    }

    await p.goto(`${origin}/?no3d`)
    await p.evaluate(async ({ entries, matches, live }) => {
      document.querySelector('#app').__vue_app__?.unmount()
      const vue = await import('/node_modules/.vite/deps/vue.js')
      const { createI18n } = await import('/node_modules/.vite/deps/vue-i18n.js')
      const { messages } = await import('/src/i18n/messages.js')
      const { default: component } = await import('/src/components/TournamentMatchList.vue')
      window.stage2 = { edited: null, viewed: null }
      const app = vue.createApp({ render: () => vue.h(component, {
        matches, entriesMap: Object.fromEntries(entries.map(entry => [entry.id, entry])), setsByMatch: {},
        liveScoresByMatch: Object.fromEntries(live.map(item => [item.match_id, item])), canEditFinal: true, canLiveScore: true,
        onEditResult: match => { stage2.edited = match.id }, onViewLive: match => { stage2.viewed = match.id },
      }) })
      app.use(createI18n({ legacy: false, locale: 'ru', messages })).mount('#app')
      await vue.nextTick()
    }, { entries, matches, live })
    check(await p.locator('input[type=number]').count() === 0, 'mobile match center does not render the bulk score form')
    await p.locator('[data-match-id=m0] .btn--secondary').click()
    check(await p.evaluate(() => stage2.edited === 'm0'), 'result action selects exactly one match')
    await p.locator('[data-match-id=m0] .btn--primary').click()
    check(await p.evaluate(() => stage2.viewed === 'm0'), 'live action selects exactly one match')
    await p.screenshot({ path: 'output/playwright/mobile-foundation/mobile-match-center-320.png', fullPage: true })

    await p.evaluate(async ({ entries, matches }) => {
      document.querySelector('#app').__vue_app__?.unmount()
      document.querySelector('#app').innerHTML = ''
      const vue = await import('/node_modules/.vite/deps/vue.js')
      const { createI18n } = await import('/node_modules/.vite/deps/vue-i18n.js')
      const { messages } = await import('/src/i18n/messages.js')
      const { default: component } = await import('/src/components/BracketBoard.vue')
      stage2.swapped = null
      const app = vue.createApp({ render: () => vue.h(component, {
        matches: matches.slice(4, 6), entriesMap: Object.fromEntries(entries.map(entry => [entry.id, entry])), editableSlots: true,
        onSwapSlots: payload => { stage2.swapped = payload },
      }) })
      app.use(createI18n({ legacy: false, locale: 'ru', messages })).mount('#app')
      await vue.nextTick()
    }, { entries, matches })
    await p.setViewportSize({ width: 320, height: 568 })
    await p.locator('.match-card__row').nth(0).click()
    check(await p.locator('.match-card__row--selected').count() === 1, 'tap selects the first bracket slot')
    await p.locator('.match-card__row').nth(3).focus()
    await p.keyboard.press('Enter')
    const swapPayload = await p.evaluate(() => stage2.swapped)
    check(Boolean(swapPayload), `keyboard selects the destination and emits one bracket swap: ${JSON.stringify(swapPayload)}`)
    await p.waitForTimeout(100)
    const beforeResize = await p.locator('.infinite-canvas__content').getAttribute('style')
    await p.setViewportSize({ width: 390, height: 844 })
    await p.waitForTimeout(150)
    const afterResize = await p.locator('.infinite-canvas__content').getAttribute('style')
    check(beforeResize !== afterResize, 'auto-fit recalculates after the viewport changes')
    check(errors.length === 0, `No browser exceptions: ${errors.join('; ')}`)
    return { passed: checks.length, checks }
  } finally {
    await context.close()
  }
}
