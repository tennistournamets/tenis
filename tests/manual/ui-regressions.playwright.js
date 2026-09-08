// Run via playwright_cli.sh -s=step9 run-code --filename=tests/manual/ui-regressions.playwright.js
// Open a Vite page at 127.0.0.1 first. Uses real Vue components with synthetic RPC
// responses; all REST traffic is intercepted. No working tournament is written.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open the local Vite page first')
  page.setDefaultTimeout(10000)
  const checks = []
  const check = (value, name) => { if (!value) throw new Error(name); checks.push(name) }
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/rest/v1/**', route => route.fulfill({ json: { id: 'ui-step9' } }))
  await page.goto(`${origin}/`)
  await page.evaluate(async () => {
    document.querySelector('#app').__vue_app__?.unmount()
    const vue = await import('/node_modules/.vite/deps/vue.js')
    const { createI18n } = await import('/node_modules/.vite/deps/vue-i18n.js')
    const { createRouter, createMemoryHistory } = await import('/node_modules/.vite/deps/vue-router.js')
    const { messages } = await import('/src/i18n/messages.js')
    const { supabase } = await import('/src/lib/supabase.js')
    const i18n = createI18n({ legacy: false, locale: 'ru', messages })
    const initialState = { points: { a: 0, b: 0 }, games: { a: 0, b: 0 }, sets: [], winner: null }
    window.ui = { vue, i18n, app: null, calls: [], mode: '', initialState, refreshes: 0,
      match: { id: 'match-step9', tournament_id: 'ui-step9', side_a_entry_id: 'a', side_b_entry_id: 'b',
        side_a_score: null, side_b_score: null, score_revision: 0, status: 'ready', round_number: 1, match_number: 1 },
      tournament: { id: 'ui-step9', slug: 'ui-step9', name: 'UI Step 9', category: 'singles', sport: 'tennis', format: 'single_elimination', status: 'registration_open', is_public: true },
      live: { id: 'live-step9', match_id: 'match-step9', revision: 0, sides_swapped: true, sides_auto: false, status: 'stopped', state: initialState },
    }
    supabase.rpc = async (name, args) => {
      ui.calls.push({ name, args })
      if (name === 'start_live_match' && ui.delayStart) await new Promise(resolve => { ui.startResolve = resolve })
      if (ui.mode === 'delay') await new Promise(resolve => { ui.resolve = resolve })
      if (ui.mode === 'fail') return { data: null, error: { message: 'Not allowed' } }
      if (name === 'start_live_match') ui.live = { ...ui.live, status: 'active', revision: ui.live.revision + 1 }
      if (name === 'set_live_sides') ui.live = { ...ui.live, sides_swapped: args.p_swapped ?? ui.live.sides_swapped, sides_auto: args.p_auto ?? ui.live.sides_auto }
      if (name === 'get_tournament_sync_state') {
        ui.refreshes += 1
        return { data: { tournament: { ...ui.tournament }, entries: [], matches: [], sets: [], live: [], groups: [], standings: [], group_standings: {} }, error: null }
      }
      return { data: { ...ui.live }, error: null }
    }
    ui.mount = async (file, props = {}) => {
      ui.app?.unmount()
      ui.calls = []; ui.mode = ''
      document.querySelector('#app').innerHTML = ''
      const { default: component } = await import(`/src/${file}.vue`)
      ui.props = vue.reactive(props)
      const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] })
      ui.app = vue.createApp({ render: () => vue.h(component, ui.props) })
      ui.app.use(i18n).use(router).mount('#app')
      await vue.nextTick()
      return document.body.innerText
    }
  })
  await page.evaluate(() => ui.mount('components/LanguageSwitcher'))
  await page.locator('.lang-dropdown__trigger').focus()
  await page.keyboard.press('Enter')
  check(await page.locator('[role=option]').count() === 3, 'Language: Enter opens all three options')
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
  check(await page.evaluate(() => ui.i18n.global.locale.value === 'en' && document.activeElement.classList.contains('lang-dropdown__trigger') && localStorage.getItem('champ_locale') === 'en'), 'Language: arrows + Enter select and restore focus, persist locale')
  await page.keyboard.press('Space'); await page.keyboard.press('End'); await page.keyboard.press('Space')
  check(await page.evaluate(() => ui.i18n.global.locale.value === 'lt'), 'Language: Space + End selects Lithuanian')
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Home'); await page.keyboard.press('Escape')
  check(await page.locator('[role=option]').count() === 0 && await page.evaluate(() => ui.i18n.global.locale.value === 'lt'), 'Language: Escape closes without changing language')
  await page.keyboard.press('Enter'); await page.keyboard.press('Tab')
  check(await page.locator('[role=option]').count() === 0, 'Language: Tab leaves and closes popup')
  await page.locator('.lang-dropdown__trigger').click()
  await page.getByRole('option', { name: 'RU Русский' }).click()
  check(await page.evaluate(() => ui.i18n.global.locale.value === 'ru'), 'Language: mouse selection still works')
  await page.evaluate(() => {
    const before = document.createElement('button'), after = document.createElement('button')
    before.id = 'before-language'; after.id = 'after-language'
    before.textContent = 'Before'; after.textContent = 'After'
    document.querySelector('#app').prepend(before); document.querySelector('#app').append(after)
  })
  await page.locator('.lang-dropdown__trigger').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab')
  check(await page.locator('#after-language').evaluate(el => el === document.activeElement), 'Language: Tab moves to the next control')
  await page.locator('.lang-dropdown__trigger').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Tab')
  check(await page.locator('#before-language').evaluate(el => el === document.activeElement), 'Language: Shift+Tab moves to the previous control')

  for (const locale of ['ru', 'en', 'lt']) {
    await page.evaluate(locale => { ui.i18n.global.locale.value = locale }, locale)
    await page.evaluate(() => ui.mount('components/CopyTournamentLink', { slug: 'cup / 2026' }))
    if (await page.evaluate(() => typeof navigator.share === 'function')) {
      check(await page.getByRole('button', { name: await page.evaluate(() => ui.i18n.global.t('share.qrShare')) }).count() === 1, `${locale}: native mobile share action is available`)
    }
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }))
    await page.locator('.copy-link button[aria-live]').click()
    check(await page.getByRole('alert').innerText() === await page.evaluate(() => ui.i18n.global.t('share.copyFailed')), `${locale}: missing Clipboard displays translated failure`)
    await page.locator('.copy-link input').focus()
    check(await page.locator('.copy-link input').evaluate(el => el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.endsWith('/tournaments/cup%20%2F%202026')), `${locale}: full manual link is selected`)
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } }))
    await page.locator('.copy-link button[aria-live]').click()
    check(await page.getByRole('alert').count() === 1 && await page.locator('.copy-link button[aria-live]').innerText() === await page.evaluate(() => ui.i18n.global.t('share.copyLink')), `${locale}: denied Clipboard never reports copied`)
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: url => new Promise(resolve => { ui.copiedUrl = url; ui.copyResolve = resolve }) } }))
    await page.locator('.copy-link button[aria-live]').click()
    check(await page.locator('.copy-link button[aria-live]').isDisabled(), `${locale}: copy waits for API completion`)
    await page.evaluate(() => ui.copyResolve())
    await page.waitForFunction(() => document.querySelector('.copy-link button[aria-live]')?.textContent.trim() === ui.i18n.global.t('share.copied'))
    check(await page.getByRole('alert').count() === 0, `${locale}: confirmed copy clears failure`)

    for (const file of ['components/FootballScoreEditor', 'components/MatchScoreModal']) {
      await page.evaluate(file => ui.mount(file, file.endsWith('FootballScoreEditor') ? { matches: [ui.match] } : { match: ui.match, family: 'goals', canEditFinal: true }), file)
      const inputs = page.locator('input[type=number]')
      const save = page.getByRole('button', { name: await page.evaluate(() => ui.i18n.global.t('scoringFlow.finish')), exact: true })
      await save.click()
      check(await page.evaluate(() => ui.calls.length === 0), `${locale} ${file}: empty goals send no result`)
      await inputs.nth(0).fill('0'); await save.click()
      check(await page.evaluate(() => ui.calls.length === 0), `${locale} ${file}: one empty side sends no result`)
      await inputs.nth(1).fill('0'); await save.click()
      check(await page.evaluate(() => ui.calls.some(c => c.name === 'update_football_result' && c.args.p_a_goals === 0 && c.args.p_b_goals === 0)), `${locale} ${file}: explicit zero-zero is submitted`)
    }
  }

  await page.evaluate(() => ui.mount('components/CopyTournamentLink', { slug: 'step9-actual-clipboard' }))
  await page.evaluate(() => { delete navigator.clipboard })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.copy-link button[aria-live]').click()
  check(await page.evaluate(async () => (await navigator.clipboard.readText()).endsWith('/tournaments/step9-actual-clipboard')), 'Clipboard: native browser clipboard contains the exact link')
  await page.context().clearPermissions()
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
    ui.closed = false
    return ui.mount('components/TournamentQrModal', { slug: 'step9-qr', name: 'Step 9', onClose: () => { ui.closed = true } })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.copy-link button[aria-live]').click()
  check(await page.getByRole('alert').count() === 1, 'QR: failed copying offers manual fallback')
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'QR: fallback fits a 390px mobile viewport')
  await page.screenshot({ path: 'output/playwright/step9-clipboard-mobile.png' })
  await page.locator('.copy-link input').focus(); await page.keyboard.press('Escape')
  check(await page.evaluate(() => ui.closed), 'QR: Escape from manual copy field still closes the modal')
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.evaluate(() => { ui.i18n.global.locale.value = 'ru'; return ui.mount('views/PublicTournamentView', { slug: 'ui-step9' }) })
  await page.waitForSelector('form')
  await page.locator('input[autocomplete=name]').fill('Step Nine Player')
  await page.locator('input[autocomplete=email]').fill('step9@example.test')
  await page.locator('form button[type=submit]').click()
  await page.waitForSelector('form .alert--success')
  const refreshes = await page.evaluate(() => ui.refreshes)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.waitForFunction(before => ui.refreshes > before, refreshes)
  for (const locale of ['ru', 'en', 'lt']) {
    await page.evaluate(locale => { ui.i18n.global.locale.value = locale }, locale)
    check(await page.locator('form .alert--success').innerText() === await page.evaluate(() => ui.i18n.global.t('registrationForm.success')), `${locale}: registration success survives parent snapshot refresh and language changes`)
  }

  await page.evaluate(() => ui.mount('components/LiveScoringModal', { match: ui.match, liveScore: ui.live, teamA: 'Alpha', teamB: 'Beta' }))
  await page.getByRole('button', { name: await page.evaluate(() => ui.i18n.global.t('scoringFlow.resume')) }).click()
  check(await page.evaluate(() => !ui.calls.some(c => c.name === 'set_live_sides')), 'LIVE: resuming saved session does not reset orientation')
  check(!(await page.locator('.live-sides input').isChecked()) && await page.locator('.live-tap__name').first().innerText() === 'Beta', 'LIVE: saved swapped/manual orientation is restored')
  await page.evaluate(() => { ui.mode = 'fail' })
  await page.locator('.live-sides label').click()
  await page.waitForFunction(() => !document.querySelector('.live-sides input').disabled)
  check(!(await page.locator('.live-sides input').isChecked()), 'LIVE: rejected orientation change restores checkbox')
  check(await page.getByRole('alert').count() === 1, 'LIVE: rejected side write displays an accessible error')
  await page.evaluate(() => { ui.mode = 'delay' })
  await page.locator('.live-sides__swap').click()
  check(await page.locator('.live-sides__swap').isDisabled() && await page.locator('.live-tap').first().isDisabled(), 'LIVE: pending side write prevents overlapping writes')
  await page.evaluate(() => { ui.mode = ''; ui.resolve() })
  await page.waitForFunction(() => !document.querySelector('.live-sides__swap').disabled)
  check(await page.locator('.live-tap__name').first().innerText() === 'Alpha', 'LIVE: confirmed manual swap is displayed')
  await page.evaluate(() => ui.mount('components/LiveScoringModal', { match: ui.match, liveScore: ui.live, teamA: 'Alpha', teamB: 'Beta' }))
  check(await page.locator('.live-tap__name').first().innerText() === 'Alpha' && !(await page.locator('.live-sides input').isChecked()), 'LIVE: reopening preserves confirmed sides and auto preference')
  await page.evaluate(() => ui.mount('components/LiveScoringModal', { match: ui.match, teamA: 'Alpha', teamB: 'Beta', liveScore: {
    ...ui.live, status: 'finished', state: { ...ui.initialState, winner: 'a', games: { a: 6, b: 0 }, sets: [
      { side_a_games: 6, side_b_games: 0 }, { side_a_games: 6, side_b_games: 0 },
    ] },
  } }))
  check((await page.locator('.live-board__sets').allTextContents()).map(s => s.trim()).join('|') === '6 6|0 0', 'LIVE: final set is rendered exactly once')
  await page.evaluate(() => {
    ui.live = { ...ui.live, status: 'active', sides_swapped: false, sides_auto: true, state: ui.initialState }
    ui.delayStart = true
    return ui.mount('components/LiveScoringModal', { match: ui.match, teamA: 'Alpha', teamB: 'Beta' })
  })
  await page.locator('.live-sides__swap').click(); await page.locator('.live-sides label').click()
  check(!(await page.locator('.live-sides input').isChecked()) && await page.locator('.live-tap__name').first().innerText() === 'Beta', 'LIVE: court choices are usable while the first start is pending')
  await page.evaluate(() => { ui.delayStart = false; ui.startResolve() })
  await page.waitForFunction(() => ui.calls.some(c => c.name === 'set_live_sides'))
  check(await page.evaluate(() => ui.live.sides_swapped && !ui.live.sides_auto), 'LIVE: pending court choices are saved after the first start')
  check(errors.length === 0, `No uncaught browser errors: ${errors.join('; ')}`)
  await page.evaluate(() => ui.app?.unmount())
  await page.unroute('**/rest/v1/**')
  await page.goto(`${origin}/`)
  return { passed: checks.length, checks }
}
