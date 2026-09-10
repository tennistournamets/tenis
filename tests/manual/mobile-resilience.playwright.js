// Mobile Step 5 resilience acceptance.
// Run with:
//   playwright_cli.sh -s=mobile-step5 run-code --filename=tests/manual/mobile-resilience.playwright.js
//
// The scenario mounts real Vue views/components, but replaces Supabase REST,
// Auth and Realtime with deterministic in-browser fixtures. It never writes
// tournament data to the configured backend.
async page => {
  const sourceOrigin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(sourceOrigin)) {
    throw new Error('Open the local Vite page first')
  }

  const context = await page.context().browser().newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  })
  const p = await context.newPage()
  p.setDefaultTimeout(12000)

  const results = []
  const failures = []
  const pageErrors = []
  const interceptedSupabase = []
  let sequence = 0

  function report(ok, label, detail = '') {
    const result = { number: ++sequence, ok: Boolean(ok), label, detail: detail ? String(detail) : '' }
    results.push(result)
    if (!result.ok) failures.push(result)
    console.log(`${result.number}. ${result.ok ? 'PASS' : 'FAIL'} — ${label}${result.detail ? `: ${result.detail}` : ''}`)
    return result.ok
  }

  async function section(label, task) {
    try {
      await task()
    } catch (error) {
      report(false, label, error?.stack || error?.message || error)
    }
  }

  p.on('pageerror', error => pageErrors.push(error.message))

  await context.route('**/auth/v1/**', route => {
    interceptedSupabase.push({ kind: 'auth', method: route.request().method(), url: route.request().url() })
    return route.fulfill({ json: { user: null, session: null } })
  })
  await context.route('**/rest/v1/**', route => {
    interceptedSupabase.push({ kind: 'rest', method: route.request().method(), url: route.request().url() })
    return route.fulfill({ json: [] })
  })
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/realtime/**', socket => {
      interceptedSupabase.push({ kind: 'realtime', method: 'WS', url: socket.url?.() || 'realtime' })
      socket.close()
    })
  }

  const installHarness = async () => p.evaluate(async () => {
    document.querySelector('#app')?.__vue_app__?.unmount()
    const root = document.querySelector('#app')
    if (!root) throw new Error('Missing #app root')
    root.innerHTML = ''

    const dependencyUrl = name => performance.getEntriesByType('resource')
      .find(entry => entry.name.includes(`/node_modules/.vite/deps/${name}.js?v=`))?.name
      || `/node_modules/.vite/deps/${name}.js`
    const vue = await import(dependencyUrl('vue'))
    const { createI18n } = await import(dependencyUrl('vue-i18n'))
    const { createMemoryHistory, createRouter, createWebHistory } = await import(dependencyUrl('vue-router'))
    const { createPinia } = await import(dependencyUrl('pinia'))
    const { messages } = await import('/src/i18n/messages.js')
    const { supabase } = await import('/src/lib/supabase.js')
    const { useAuthStore } = await import('/src/stores/auth.js')
    const { settleConfirm } = await import('/src/lib/confirmDialog.js')
    const { default: ConfirmDialog } = await import('/src/components/ConfirmDialog.vue')

    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
    const state = window.mr = {
      vue,
      createI18n,
      createMemoryHistory,
      createRouter,
      createWebHistory,
      createPinia,
      messages,
      supabase,
      useAuthStore,
      settleConfirm,
      ConfirmDialog,
      clone,
      app: null,
      router: null,
      online: true,
      rpcCalls: [],
      restCalls: [],
      channels: [],
      emitted: [],
      liveMode: 'success',
      pointMode: 'success',
      scoreMode: 'success',
      releaseLive: null,
      releasePoint: null,
      releaseScore: null,
    }

    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => state.online,
    })

    state.setOnline = online => {
      state.online = Boolean(online)
      window.dispatchEvent(new Event(state.online ? 'online' : 'offline'))
    }

    state.liveState = revision => ({
      id: 'fixture-live',
      match_id: 'live-match',
      status: 'active',
      revision,
      sides_swapped: false,
      sides_auto: true,
      history: [],
      state: {
        points: { a: 0, b: 0 },
        games: { a: 0, b: 0 },
        setsWon: { a: 0, b: 0 },
        sets: [],
        currentSet: 1,
        isTiebreak: false,
        tiebreakPoints: { a: 0, b: 0 },
        requiredSets: 2,
        winner: null,
      },
    })

    state.publicSnapshot = {
      tournament: {
        id: 'public-cup', slug: 'public-cup', name: 'Resilience Cup', description: '',
        category: 'singles', sport: 'tennis', format: 'single_elimination', status: 'in_progress',
        set_format: 'best_of_3', scoring_config: {}, settings_revision: 1, is_public: true,
      },
      entries: [
        { id: 'public-a', status: 'approved', display_name: 'Alpha', entry_members: [{ member_name: 'Alpha', member_order: 1 }] },
        { id: 'public-b', status: 'approved', display_name: 'Beta', entry_members: [{ member_name: 'Beta', member_order: 1 }] },
      ],
      matches: [{
        id: 'public-match', tournament_id: 'public-cup', stage: 'winners', round_number: 1,
        match_number: 1, side_a_entry_id: 'public-a', side_b_entry_id: 'public-b',
        status: 'ready', winner_entry_id: null, score_revision: 0,
      }],
      sets: [],
      live: [],
      groups: [], standings: [], group_standings: {},
    }
    state.publicSnapshot.live = [{ ...state.liveState(3), id: 'public-live', match_id: 'public-match' }]

    state.adminSnapshot = {
      tournament: {
        id: 'admin-cup', slug: 'admin-cup', name: 'Admin Resilience Cup', description: '',
        category: 'singles', sport: 'tennis', format: 'single_elimination', status: 'in_progress',
        set_format: 'best_of_3', scoring_config: {}, settings_revision: 1, is_public: true,
        doubles_pairing_mode: 'pre_agreed',
      },
      entries: [
        { id: 'admin-a', status: 'approved', display_name: 'Gamma', entry_members: [{ id: 'member-a', member_name: 'Gamma', member_order: 1 }] },
        { id: 'admin-b', status: 'approved', display_name: 'Delta', entry_members: [{ id: 'member-b', member_name: 'Delta', member_order: 1 }] },
      ],
      matches: [{
        id: 'admin-match', tournament_id: 'admin-cup', stage: 'winners', round_number: 1,
        match_number: 1, side_a_entry_id: 'admin-a', side_b_entry_id: 'admin-b',
        status: 'ready', winner_entry_id: null, score_revision: 0,
      }],
      sets: [],
      live: [],
      groups: [], standings: [], group_standings: {},
    }
    state.adminSnapshot.live = [{ ...state.liveState(4), id: 'admin-live', match_id: 'admin-match' }]

    supabase.rpc = async (name, args = {}) => {
      state.rpcCalls.push({ name, args: clone(args) })

      if (name === 'get_tournament_sync_state') {
        const snapshot = args.p_tournament_id === 'admin-cup' ? state.adminSnapshot : state.publicSnapshot
        return { data: clone(snapshot), error: null }
      }
      if (name === 'get_my_tournament_role') return { data: 'owner', error: null }
      if (name === 'get_tournament_admins_with_email') return { data: [], error: null }

      if (name === 'start_live_match') {
        if (state.liveMode === 'throw') throw new Error('START_NETWORK_REJECTED')
        if (state.liveMode === 'error') return { data: null, error: { message: 'START_DENIED' } }
        if (state.liveMode === 'delay') await new Promise(resolve => { state.releaseLive = resolve })
        return { data: state.liveState(1), error: null }
      }
      if (name === 'record_point') {
        if (state.pointMode === 'throw') throw new Error('POINT_NETWORK_REJECTED')
        if (state.pointMode === 'error') return { data: null, error: { message: 'scoringFlow.liveConflict' } }
        if (state.pointMode === 'delay') await new Promise(resolve => { state.releasePoint = resolve })
        const next = state.liveState(Number(args.p_expected_revision || 0) + 1)
        next.history = [{ side: args.p_side }]
        next.state.points[args.p_side] = 1
        return { data: next, error: null }
      }
      if (name === 'stop_live_match') {
        const next = state.liveState(Number(args.p_expected_revision || 0) + 1)
        next.status = 'stopped'
        return { data: next, error: null }
      }
      if (name === 'set_live_sides') return { data: state.liveState(2), error: null }

      if (name === 'update_football_result' || name === 'update_match_sets') {
        if (state.scoreMode === 'throw') throw new Error('SCORE_NETWORK_REJECTED')
        if (state.scoreMode === 'delay') await new Promise(resolve => { state.releaseScore = resolve })
        if (state.scoreMode === 'correction') return { data: null, error: { message: 'scoringFlow.downstreamStarted' } }
        return { data: { revision: Number(args.p_expected_revision || 0) + 1 }, error: null }
      }
      if (name === 'get_match_correction_preview') return {
        data: { blocked_live: false, reseed_playoff: false, matches: [], token: 'fixture-token' },
        error: null,
      }
      if (name === 'apply_match_correction') return { data: null, error: null }
      if (name === 'preview_match_result_correction') return { data: { impacts: [] }, error: null }
      if (name === 'apply_match_result_correction') return { data: null, error: null }
      if (name === 'create_tournament') return { data: 'created-fixture', error: null }
      throw new Error(`Unexpected fixture RPC: ${name}`)
    }

    supabase.from = table => {
      const query = {
        select() { return query },
        insert() { return query },
        update() { return query },
        delete() { return query },
        eq(key, value) {
          state.restCalls.push({ table, key, value })
          query.lastKey = key
          query.lastValue = value
          return query
        },
        async maybeSingle() {
          if (table === 'tournaments' && query.lastKey === 'slug') {
            const visible = query.lastValue === state.publicSnapshot.tournament.slug
            return { data: visible ? { id: state.publicSnapshot.tournament.id } : null, error: null }
          }
          return { data: null, error: null }
        },
        async single() { return { data: null, error: null } },
        then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve) },
      }
      return query
    }

    supabase.channel = name => {
      const channel = {
        name,
        removed: false,
        on() { return channel },
        subscribe(callback) { callback?.('SUBSCRIBED'); return channel },
      }
      state.channels.push(channel)
      return channel
    }
    supabase.removeChannel = async channel => { channel.removed = true; return 'ok' }

    state.routes = () => [
      { path: '/', name: 'fixture-home', component: { render: () => null } },
      { path: '/fixture', name: 'fixture', component: { render: () => null } },
      { path: '/tournaments/:slug', name: 'public-tournament', component: { render: () => null } },
      { path: '/admin/tournaments', name: 'admin-tournaments', component: { render: () => null } },
      { path: '/admin/tournaments/new', name: 'admin-tournament-new', component: { render: () => null } },
      { path: '/admin/tournaments/:id', name: 'admin-tournament', component: { render: () => null } },
      { path: '/admin/settings', name: 'admin-settings', component: { render: () => null } },
    ]

    state.unmount = () => {
      state.settleConfirm(false)
      state.app?.unmount()
      state.app = null
      state.router?.options?.history?.destroy?.()
      state.router = null
      root.innerHTML = ''
    }

    state.authFor = (pinia, userId = 'fixture-owner') => {
      const auth = state.useAuthStore(pinia)
      auth.$patch({
        ready: true,
        user: { id: userId, email: `${userId}@example.test`, user_metadata: {} },
        session: { user: { id: userId } },
        tournamentRoles: ['owner'],
        tournamentRolesLoaded: true,
        playerContextLoaded: true,
      })
      auth.init = async () => {}
      auth.loadTournamentRoles = async () => {}
      auth.loadPlayerContext = async () => {}
      state.currentAuth = auth
      return auth
    }

    state.mount = async ({ file, props = {}, path = '/', webHistory = false, appOwnsConfirm = false, userId = 'fixture-owner' }) => {
      state.unmount()
      state.emitted = []
      const component = (await import(`/src/${file}.vue`)).default
      const historyFactory = webHistory ? state.createWebHistory : state.createMemoryHistory
      if (webHistory) window.history.replaceState(null, '', path)
      const router = state.createRouter({ history: historyFactory(), routes: state.routes() })
      if (!webHistory) await router.push(path)
      const pinia = state.createPinia()
      state.authFor(pinia, userId)
      const i18n = state.createI18n({ legacy: false, locale: 'ru', messages: state.messages })
      const render = () => appOwnsConfirm
        ? state.vue.h(component, props)
        : state.vue.h(state.vue.Fragment, [state.vue.h(component, props), state.vue.h(state.ConfirmDialog)])
      const app = state.vue.createApp({ render })
      app.use(i18n).use(pinia).use(router).mount(root)
      await router.isReady()
      await state.vue.nextTick()
      state.app = app
      state.router = router
      state.i18n = i18n
      return router.currentRoute.value.fullPath
    }

    state.mountWizard = () => state.mount({
      file: 'views/AdminTournamentCreateView',
      path: '/admin/tournaments/new',
    })

    state.mountScore = ({ id, revision = 7, a = null, b = null, userId = 'fixture-owner' }) => state.mount({
      file: 'components/MatchScoreModal',
      userId,
      props: {
        match: {
          id,
          tournament_id: 'score-cup',
          side_a_entry_id: 'score-a',
          side_b_entry_id: 'score-b',
          side_a_score: a,
          side_b_score: b,
          side_a_pens: null,
          side_b_pens: null,
          status: 'ready',
          score_revision: revision,
        },
        entriesMap: {
          'score-a': { id: 'score-a', display_name: 'One', entry_members: [{ member_name: 'One', member_order: 1 }] },
          'score-b': { id: 'score-b', display_name: 'Two', entry_members: [{ member_name: 'Two', member_order: 1 }] },
        },
        family: 'goals',
        canEditFinal: true,
        canLiveScore: true,
        onClose: () => state.emitted.push('close'),
        onSaved: () => state.emitted.push('saved'),
        onStartLive: match => state.emitted.push(`start:${match.id}`),
      },
    })

    state.mountLive = ({ liveScore = null, canStopLive = true } = {}) => state.mount({
      file: 'components/LiveScoringModal',
      props: {
        match: {
          id: 'live-match', tournament_id: 'live-cup', side_a_entry_id: 'live-a',
          side_b_entry_id: 'live-b', status: 'ready', score_revision: 0,
        },
        liveScore: clone(liveScore),
        teamA: 'Left team',
        teamB: 'Right team',
        canStopLive,
        onChanged: () => state.emitted.push('changed'),
        onClose: () => state.emitted.push('close'),
      },
    })

    state.mountApp = () => state.mount({
      file: 'App',
      path: '/fixture',
      appOwnsConfirm: true,
    })

    state.mountPublic = path => state.mount({
      file: 'views/PublicTournamentView',
      props: { slug: 'public-cup' },
      path,
      webHistory: true,
    })

    state.mountAdmin = path => state.mount({
      file: 'views/AdminTournamentView',
      props: { id: 'admin-cup' },
      path,
      webHistory: true,
    })
  })

  try {
    await p.goto(`${sourceOrigin}/?no3d`)
    await installHarness()
    await p.evaluate(() => sessionStorage.clear())

    await section('Wizard draft reload and discard', async () => {
      await p.evaluate(() => mr.mountWizard())
      await p.waitForSelector('.wizard')
      await p.waitForTimeout(50)
      await p.locator('.wizard__foot .btn--primary').click()
      await p.waitForSelector('.wizard__sport-pill')
      await p.locator('.wizard__foot .btn--primary').click()
      await p.waitForSelector('#create-name')
      await p.locator('#create-name').fill('Recovered Mobile Cup')
      await p.locator('#create-phone').fill('+370 600 00000')
      const wizardKey = 'bracketa:create-tournament:fixture-owner'
      await p.waitForFunction(key => Boolean(sessionStorage.getItem(key)), wizardKey)
      report(
        await p.evaluate(key => {
          const saved = JSON.parse(sessionStorage.getItem(key))?.value
          return saved?.step === 3 && saved?.form?.name === 'Recovered Mobile Cup' && saved?.form?.contact_phone === '+370 600 00000'
        }, wizardKey),
        'Wizard stores the current step and form in versioned sessionStorage',
      )

      // A real document reload clears every Vue instance while preserving this
      // tab's sessionStorage. Reinstall only the deterministic fixture afterward.
      await p.reload({ waitUntil: 'domcontentloaded' })
      await installHarness()
      await p.evaluate(() => mr.mountWizard())
      await p.waitForSelector('#create-name')
      report(
        await p.locator('#create-name').inputValue() === 'Recovered Mobile Cup'
          && await p.locator('#create-phone').inputValue() === '+370 600 00000'
          && await p.locator('.wizard__draft[role=status]').isVisible(),
        'Wizard restores step 3 and private form fields after a document reload',
      )
      await p.locator('.wizard__draft button').click()
      await p.waitForSelector('.picker-grid')
      report(
        await p.locator('#create-name').count() === 0
          && !await p.evaluate(key => sessionStorage.getItem(key), wizardKey),
        'Explicit wizard discard returns to step 1 and clears the stored draft',
      )
    })

    await section('Per-match score draft recovery', async () => {
      const keyA = 'bracketa:match-score:fixture-owner:score-cup:match-a'
      const keyB = 'bracketa:match-score:fixture-owner:score-cup:match-b'
      await p.evaluate(() => mr.mountScore({ id: 'match-a', revision: 7 }))
      await p.locator('.msm-goals input').nth(0).fill('2')
      await p.locator('.msm-goals input').nth(1).fill('1')
      await p.waitForFunction(key => Boolean(sessionStorage.getItem(key)), keyA)

      await p.evaluate(() => mr.mountScore({ id: 'match-b', revision: 7 }))
      await p.locator('.msm-goals input').nth(0).fill('4')
      await p.locator('.msm-goals input').nth(1).fill('3')
      await p.waitForFunction(key => Boolean(sessionStorage.getItem(key)), keyB)
      report(
        await p.evaluate(([a, b]) => {
          const left = JSON.parse(sessionStorage.getItem(a))?.value?.input?.goals
          const right = JSON.parse(sessionStorage.getItem(b))?.value?.input?.goals
          return String(left?.a) === '2' && String(left?.b) === '1'
            && String(right?.a) === '4' && String(right?.b) === '3'
        }, [keyA, keyB]),
        'Two match drafts use independent keys and retain independent scores',
      )

      await p.evaluate(() => mr.mountScore({ id: 'match-a', revision: 7 }))
      report(
        await p.locator('.msm-goals input').nth(0).inputValue() === '2'
          && await p.locator('.msm-goals input').nth(1).inputValue() === '1'
          && await p.locator('.msm-restored[role=status]').isVisible(),
        'Match score draft restores when match id, family and score revision still match',
      )

      await p.evaluate(() => mr.mountScore({ id: 'match-a', revision: 7, userId: 'second-operator' }))
      report(
        await p.locator('.msm-goals input').nth(0).inputValue() === ''
          && await p.locator('.msm-goals input').nth(1).inputValue() === ''
          && await p.locator('.msm-restored').count() === 0,
        'A different signed-in operator cannot restore another account’s match draft',
      )

      await p.evaluate(() => mr.mountScore({ id: 'match-a', revision: 8 }))
      report(
        await p.locator('.msm-goals input').nth(0).inputValue() === ''
          && await p.locator('.msm-goals input').nth(1).inputValue() === ''
          && await p.locator('.msm-restored').count() === 0
          && !await p.evaluate(key => sessionStorage.getItem(key), keyA),
        'A newer server score revision rejects and removes the stale local draft',
      )

      const switchKey = 'bracketa:match-score:fixture-owner:score-cup:session-switch'
      await p.evaluate(() => mr.mountScore({ id: 'session-switch', revision: 3 }))
      await p.locator('.msm-goals input').nth(0).fill('6')
      await p.waitForFunction(key => Boolean(sessionStorage.getItem(key)), switchKey)
      await p.evaluate(() => mr.currentAuth.$patch({
        user: { id: 'second-operator', email: 'second-operator@example.test', user_metadata: {} },
        session: { user: { id: 'second-operator' } },
      }))
      await p.waitForFunction(() => mr.emitted.includes('close'))
      const switchedDrafts = await p.evaluate(key => ({
        previous: JSON.parse(sessionStorage.getItem(key))?.value?.input?.goals?.a,
        next: sessionStorage.getItem('bracketa:match-score:second-operator:score-cup:session-switch'),
      }), switchKey)
      report(
        await p.locator('.msm-goals input').nth(0).inputValue() === ''
          && String(switchedDrafts.previous) === '6'
          && !switchedDrafts.next,
        'Changing accounts while the score editor is open closes it without moving or exposing the previous draft',
        JSON.stringify(switchedDrafts),
      )

      await p.evaluate(() => mr.mountScore({ id: 'confirm-switch', revision: 3 }))
      await p.locator('.msm-goals input').nth(0).fill('1')
      await p.locator('.msm-actions .btn--ghost').click()
      await p.waitForSelector('.confirm-dialog')
      await p.evaluate(() => {
        mr.currentAuth.$patch({
          user: { id: 'second-operator', email: 'second-operator@example.test', user_metadata: {} },
          session: { user: { id: 'second-operator' } },
        })
        mr.settleConfirm(true)
      })
      await p.waitForTimeout(50)
      report(
        await p.evaluate(() => !mr.emitted.some(event => event.startsWith('start:'))),
        'Changing accounts while discard confirmation is open cannot start LIVE in the new session',
      )

      await p.evaluate(() => {
        mr.scoreMode = 'correction'
        mr.rpcCalls = []
        return mr.mountScore({ id: 'correction-switch', revision: 3 })
      })
      await p.locator('.msm-goals input').nth(0).fill('2')
      await p.locator('.msm-goals input').nth(1).fill('1')
      await p.locator('.msm-actions .btn--primary').click()
      await p.waitForSelector('.confirm-dialog--details')
      await p.evaluate(() => {
        mr.currentAuth.$patch({
          user: { id: 'second-operator', email: 'second-operator@example.test', user_metadata: {} },
          session: { user: { id: 'second-operator' } },
        })
        mr.settleConfirm(true)
      })
      await p.waitForTimeout(50)
      report(
        await p.evaluate(() => !mr.rpcCalls.some(call => call.name === 'apply_match_correction')),
        'Changing accounts during correction review prevents applying the old operator’s correction',
      )
      await p.evaluate(() => { mr.scoreMode = 'success' })
    })

    await section('Single-flight final score save', async () => {
      await p.evaluate(() => {
        mr.scoreMode = 'delay'
        mr.rpcCalls = []
        return mr.mountScore({ id: 'double-save', revision: 2 })
      })
      await p.locator('.msm-goals input').nth(0).fill('3')
      await p.locator('.msm-goals input').nth(1).fill('0')
      await p.locator('.msm-actions .btn--primary').evaluate(button => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await p.waitForFunction(() => mr.rpcCalls.some(call => call.name === 'update_football_result'))
      report(
        await p.evaluate(() => mr.rpcCalls.filter(call => call.name === 'update_football_result').length === 1)
          && await p.locator('.msm-actions .btn--primary').isDisabled(),
        'Rapid double submit starts at most one final-score mutation and locks the form in flight',
      )
      await p.evaluate(() => mr.releaseScore?.())
      await p.waitForFunction(() => mr.emitted.includes('saved'))
    })

    await section('Offline live scoring and deferred start', async () => {
      await p.evaluate(() => {
        mr.rpcCalls = []
        mr.setOnline(false)
        return mr.mountLive({ liveScore: mr.liveState(5) })
      })
      await p.waitForSelector('.live-modal [role=alert]')
      await p.locator('.live-tap').first().evaluate(button => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await p.waitForTimeout(60)
      report(
        await p.evaluate(() => !mr.rpcCalls.some(call => ['record_point', 'set_live_sides', 'stop_live_match'].includes(call.name)))
          && await p.locator('.live-tap').first().isDisabled(),
        'Offline active LIVE disables controls and performs no point, side or stop mutation',
      )

      await p.evaluate(() => {
        mr.setOnline(true)
        mr.pointMode = 'delay'
        mr.rpcCalls = []
        return mr.mountLive({ liveScore: mr.liveState(5) })
      })
      await p.locator('.live-tap').first().evaluate(button => {
        for (let index = 0; index < 3; index += 1) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await p.waitForFunction(() => mr.rpcCalls.filter(call => call.name === 'record_point').length === 1)
      await p.evaluate(() => {
        mr.setOnline(false)
        mr.releasePoint?.()
      })
      await p.waitForFunction(() => document.querySelector('.live-modal__cancelled')?.textContent?.includes('2'))
      report(
        await p.evaluate(() => mr.rpcCalls.filter(call => call.name === 'record_point').length === 1)
          && await p.locator('.live-modal__cancelled[role=alert]').isVisible(),
        'A connection drop cancels queued taps explicitly and reports how many were not sent',
      )
      await p.evaluate(() => { mr.pointMode = 'success' })

      await p.evaluate(() => {
        mr.setOnline(true)
        mr.pointMode = 'error'
        mr.rpcCalls = []
        return mr.mountLive({ liveScore: mr.liveState(8) })
      })
      await p.locator('.live-tap').first().evaluate(button => {
        for (let index = 0; index < 3; index += 1) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await p.waitForFunction(() => document.querySelector('.live-modal__cancelled')?.textContent?.includes('3'))
      const rpcErrorCancelsQueue = await p.evaluate(() => mr.rpcCalls.filter(call => call.name === 'record_point').length === 1)

      await p.evaluate(() => {
        mr.pointMode = 'throw'
        mr.rpcCalls = []
        return mr.mountLive({ liveScore: mr.liveState(8) })
      })
      await p.locator('.live-tap').first().evaluate(button => {
        for (let index = 0; index < 2; index += 1) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await p.waitForFunction(() => document.querySelector('.live-modal__cancelled')?.textContent?.includes('2'))
      report(
        rpcErrorCancelsQueue
          && await p.evaluate(() => mr.rpcCalls.filter(call => call.name === 'record_point').length === 1)
          && await p.locator('.live-modal__cancelled[role=alert]').isVisible(),
        'RPC conflicts and rejected point requests cancel every accepted queued tap with a visible count',
      )
      await p.evaluate(() => { mr.pointMode = 'success' })

      await p.evaluate(() => {
        mr.rpcCalls = []
        return mr.mountLive({ liveScore: mr.liveState(9) })
      })
      await p.evaluate(() => mr.currentAuth.$patch({
        user: { id: 'second-operator', email: 'second-operator@example.test', user_metadata: {} },
        session: { user: { id: 'second-operator' } },
      }))
      await p.waitForFunction(() => mr.emitted.includes('close'))
      await p.locator('.live-tap').first().evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await p.waitForTimeout(30)
      report(
        await p.locator('.live-tap').first().isDisabled()
          && await p.evaluate(() => !mr.rpcCalls.some(call => ['record_point', 'set_live_sides', 'stop_live_match', 'start_live_match'].includes(call.name))),
        'Changing accounts closes LIVE and blocks scoring actions from the previous session',
      )

      await p.evaluate(() => {
        mr.rpcCalls = []
        mr.setOnline(false)
        return mr.mountLive({ liveScore: null })
      })
      await p.waitForSelector('.live-modal [role=alert]')
      await p.waitForTimeout(60)
      report(
        await p.evaluate(() => mr.rpcCalls.filter(call => call.name === 'start_live_match').length === 0),
        'Opening LIVE while offline queues intent without calling start RPC',
      )
      await p.evaluate(() => mr.setOnline(true))
      await p.waitForFunction(() => mr.rpcCalls.filter(call => call.name === 'start_live_match').length === 1)
      await p.waitForTimeout(80)
      report(
        await p.evaluate(() => mr.rpcCalls.filter(call => call.name === 'start_live_match').length === 1),
        'Returning online retries the deferred LIVE start exactly once',
      )
    })

    await section('Rejected and repeated live start', async () => {
      await p.evaluate(() => {
        mr.setOnline(true)
        mr.liveMode = 'throw'
        mr.rpcCalls = []
        return mr.mountLive({ liveScore: null })
      })
      await p.waitForSelector('.live-modal .error-text[role=alert]')
      const resume = p.locator('.live-modal__footer .btn').filter({ hasText: await p.evaluate(() => mr.i18n.global.t('scoringFlow.resume')) })
      report(
        await resume.isEnabled()
          && await p.locator('.live-modal .error-text').innerText() !== ''
          && await p.locator('.live-modal__status').innerText() === await p.evaluate(() => mr.i18n.global.t('live.notStarted')),
        'Rejected LIVE start shows an error, a truthful status and releases the loading lock',
      )

      await p.evaluate(() => {
        mr.liveMode = 'delay'
        mr.rpcCalls = []
      })
      await resume.evaluate(button => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await p.waitForFunction(() => mr.rpcCalls.some(call => call.name === 'start_live_match'))
      report(
        await p.evaluate(() => mr.rpcCalls.filter(call => call.name === 'start_live_match').length === 1),
        'Rapid double resume starts at most one LIVE mutation',
      )
      await p.evaluate(() => mr.releaseLive?.())
      await p.waitForSelector('.live-modal__badge')
    })

    await section('Global offline status', async () => {
      await p.evaluate(() => {
        mr.setOnline(false)
        return mr.mountApp()
      })
      await p.waitForSelector('.app-offline-banner[role=status]')
      report(
        await p.locator('.app-offline-banner').isVisible()
          && await p.locator('.app-offline-banner').innerText() === await p.evaluate(() => mr.i18n.global.t('sync.offline')),
        'The application displays a localized global offline banner',
      )
      await p.evaluate(() => mr.setOnline(true))
      await p.locator('.app-offline-banner').waitFor({ state: 'hidden' })
      report(true, 'The global offline banner clears after the online event')
    })

    await section('Public LIVE URL and browser Back', async () => {
      await p.evaluate(() => {
        mr.setOnline(true)
        mr.rpcCalls = []
        return mr.mountPublic('/tournaments/public-cup')
      })
      await p.waitForSelector('[data-match-id="public-match"]')
      await p.locator('[data-match-id="public-match"] .btn--primary').click()
      await p.waitForFunction(() => new URL(location.href).searchParams.get('live') === 'public-match')
      report(
        await p.locator('dialog[open] .live-modal').count() === 1,
        'Opening the public LIVE overlay writes its match id into the real URL',
      )
      await p.goBack({ waitUntil: 'commit' })
      await p.waitForFunction(() => !new URL(location.href).searchParams.has('live'))
      await p.locator('dialog[open]').waitFor({ state: 'hidden' })
      report(
        await p.evaluate(() => location.pathname === '/tournaments/public-cup'),
        'Browser Back closes the public LIVE overlay without leaving the tournament',
      )

      await p.evaluate(() => mr.mountPublic('/tournaments/public-cup?view=overview&live=public-match#bracket'))
      await p.waitForSelector('dialog[open] .live-modal')
      report(
        await p.evaluate(() => new URL(location.href).searchParams.get('live') === 'public-match'),
        'A public LIVE deep link restores the overlay after a fresh mount',
      )
      await p.locator('dialog[open] .modal-close').click()
      await p.waitForFunction(() => !new URL(location.href).searchParams.has('live'))
      report(
        await p.locator('dialog[open]').count() === 0
          && await p.evaluate(() => new URL(location.href).searchParams.get('view') === 'overview' && location.hash === '#bracket'),
        'Closing a restored public overlay removes its URL state and preserves the surface and hash',
      )
    })

    await section('Admin score URL and browser Back', async () => {
      await p.evaluate(() => {
        mr.setOnline(true)
        mr.rpcCalls = []
        return mr.mountAdmin('/admin/tournaments/admin-cup#bracket')
      })
      await p.waitForSelector('[data-match-id="admin-match"]')
      await p.locator('.mobile-score-center [data-match-id="admin-match"] .btn--primary').first().click()
      await p.waitForFunction(() => {
        const url = new URL(location.href)
        return url.searchParams.get('match') === 'admin-match' && url.searchParams.get('score') === 'live'
      })
      report(
        await p.locator('dialog[open] .live-modal').count() === 1,
        'Opening the admin LIVE overlay writes match and mode into the real URL',
      )
      await p.goBack({ waitUntil: 'commit' })
      await p.waitForFunction(() => !new URL(location.href).searchParams.has('match'))
      await p.locator('dialog[open]').waitFor({ state: 'hidden' })
      report(
        await p.evaluate(() => location.pathname === '/admin/tournaments/admin-cup' && location.hash === '#bracket'),
        'Browser Back closes the admin scoring overlay without leaving the tournament',
      )

      await p.evaluate(() => mr.mountAdmin('/admin/tournaments/admin-cup?surface=overview&match=admin-match&score=live#bracket'))
      await p.waitForSelector('dialog[open] .live-modal')
      report(
        await p.evaluate(() => {
          const url = new URL(location.href)
          return url.searchParams.get('match') === 'admin-match' && url.searchParams.get('score') === 'live'
        }),
        'An admin scoring deep link restores the permitted LIVE overlay after a fresh mount',
      )
      await p.locator('dialog[open] .modal-close').click()
      await p.waitForFunction(() => !new URL(location.href).searchParams.has('match') && !new URL(location.href).searchParams.has('score'))
      report(
        await p.locator('dialog[open]').count() === 0
          && await p.evaluate(() => new URL(location.href).searchParams.get('surface') === 'overview' && location.hash === '#bracket'),
        'Closing a restored admin overlay removes score parameters and preserves the surface and hash',
      )
    })

    report(pageErrors.length === 0, 'No uncaught browser exceptions', pageErrors.join('; '))
    report(
      interceptedSupabase.every(request => !['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)),
      'No real Supabase mutation request escaped the in-browser fixtures',
      interceptedSupabase.filter(request => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)).map(request => request.url).join(', '),
    )
  } catch (error) {
    report(false, 'Scenario execution completed', error?.stack || error?.message || error)
  } finally {
    try { await p.evaluate(() => window.mr?.unmount?.()) } catch { /* page may already be closed */ }
    await context.close()
  }

  if (failures.length) {
    const transcript = results.map(item => (
      `${item.number}. ${item.ok ? 'PASS' : 'FAIL'} — ${item.label}${item.detail ? `: ${item.detail}` : ''}`
    )).join('\n')
    throw new Error(`${failures.length} resilience check(s) failed:\n${transcript}`)
  }
  return { passed: results.length, checks: results.map(item => `${item.number}. PASS — ${item.label}`) }
}
