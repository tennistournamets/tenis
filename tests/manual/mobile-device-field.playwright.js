// Mobile Step 6 device-profile acceptance. Run once in WebKit with an iPhone
// device profile and once in Chrome with an Android device profile. The test
// mounts real Vue scoring components, intercepts every backend route and never
// writes to Supabase.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open local Vite first')

  const engine = page.context().browser().browserType().name()
  const context = await page.context().browser().newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: engine === 'webkit' ? 3 : 2.75,
    reducedMotion: 'reduce',
    locale: 'ru-RU',
  })
  const p = await context.newPage()
  p.setDefaultTimeout(12000)

  const checks = []
  const errors = []
  const escapedMutations = []
  const check = (condition, label, detail = '') => {
    const result = { ok: Boolean(condition), label, detail: detail ? String(detail) : '' }
    checks.push(result)
    console.log(`${result.ok ? 'PASS' : 'FAIL'} — ${label}${result.detail ? `: ${result.detail}` : ''}`)
    return result.ok
  }

  p.on('pageerror', error => errors.push(error.message))
  await context.route('**/auth/v1/**', route => route.fulfill({ json: { user: null, session: null } }))
  await context.route('**/rest/v1/**', route => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(route.request().method())) {
      escapedMutations.push(`${route.request().method()} ${route.request().url()}`)
    }
    return route.fulfill({ json: [] })
  })
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/realtime/**', socket => socket.close())
  }

  const measure = () => p.evaluate(() => {
    const box = element => {
      const rect = element.getBoundingClientRect()
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height }
    }
    const viewport = window.visualViewport
    const backdrop = document.querySelector('.modal-backdrop')
    const modal = document.querySelector('.modal-dialog')
    const backdropStyle = getComputedStyle(backdrop)
    return {
      viewport: {
        top: viewport?.offsetTop || 0,
        left: viewport?.offsetLeft || 0,
        width: viewport?.width || innerWidth,
        height: viewport?.height || innerHeight,
      },
      backdrop: box(backdrop),
      backdropPadding: {
        top: Number.parseFloat(backdropStyle.paddingTop),
        right: Number.parseFloat(backdropStyle.paddingRight),
        bottom: Number.parseFloat(backdropStyle.paddingBottom),
        left: Number.parseFloat(backdropStyle.paddingLeft),
      },
      modal: box(modal),
      documentWidth: document.documentElement.scrollWidth,
      innerWidth,
      backdropOverflow: backdrop.scrollWidth > backdrop.clientWidth + 1,
    }
  })

  const fitsVisualViewport = geometry => {
    const viewportRight = geometry.viewport.left + geometry.viewport.width
    const viewportBottom = geometry.viewport.top + geometry.viewport.height
    return geometry.backdrop.left >= geometry.viewport.left - 1
      && geometry.backdrop.right <= viewportRight + 1
      && geometry.backdrop.top >= geometry.viewport.top - 1
      && geometry.backdrop.bottom <= viewportBottom + 1
      && geometry.modal.left >= geometry.viewport.left - 1
      && geometry.modal.right <= viewportRight + 1
      && geometry.modal.top >= geometry.viewport.top - 1
      && geometry.modal.bottom <= viewportBottom + 1
  }

  try {
    await p.goto(`${origin}/?no3d`, { waitUntil: 'domcontentloaded' })
    await p.evaluate(async () => {
      document.querySelector('#app')?.__vue_app__?.unmount()
      const root = document.querySelector('#app')
      root.innerHTML = ''
      const dependencyUrl = name => performance.getEntriesByType('resource')
        .find(entry => entry.name.includes(`/node_modules/.vite/deps/${name}.js?v=`))?.name
        || `/node_modules/.vite/deps/${name}.js`
      const vue = await import(dependencyUrl('vue'))
      const { createI18n } = await import(dependencyUrl('vue-i18n'))
      const { createPinia } = await import(dependencyUrl('pinia'))
      const { messages } = await import('/src/i18n/messages.js')
      const { supabase } = await import('/src/lib/supabase.js')
      const { useAuthStore } = await import('/src/stores/auth.js')

      const state = window.field = {
        vue,
        createI18n,
        createPinia,
        messages,
        supabase,
        useAuthStore,
        app: null,
        rpcCalls: [],
        revision: 4,
        emitted: [],
      }

      state.liveState = () => ({
        id: 'field-live',
        match_id: 'field-match',
        status: 'active',
        revision: state.revision,
        sides_swapped: false,
        sides_auto: true,
        history: state.revision > 4 ? [{ side: 'a' }] : [],
        state: {
          points: { a: Math.max(0, state.revision - 4), b: 0 },
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

      supabase.rpc = async (name, args = {}) => {
        state.rpcCalls.push({ name, args: JSON.parse(JSON.stringify(args)) })
        if (name === 'record_point') {
          state.revision += 1
          return { data: state.liveState(), error: null }
        }
        if (name === 'set_live_sides' || name === 'start_live_match' || name === 'stop_live_match') {
          state.revision += 1
          return { data: state.liveState(), error: null }
        }
        throw new Error(`Unexpected fixture RPC: ${name}`)
      }

      state.mount = async (file, props) => {
        state.app?.unmount()
        root.innerHTML = ''
        state.emitted = []
        const component = (await import(`/src/components/${file}.vue`)).default
        const pinia = createPinia()
        const auth = useAuthStore(pinia)
        auth.$patch({
          ready: true,
          user: { id: 'field-counter', email: 'counter@example.test', user_metadata: {} },
          session: { user: { id: 'field-counter' } },
        })
        const i18n = createI18n({ legacy: false, locale: 'ru', messages })
        state.app = vue.createApp(component, {
          ...props,
          onClose: () => state.emitted.push('close'),
          onChanged: () => state.emitted.push('changed'),
          onSaved: () => state.emitted.push('saved'),
        })
        state.app.use(i18n).use(pinia).mount(root)
        await vue.nextTick()
      }

      state.mountLive = (teamA, teamB) => state.mount('LiveScoringModal', {
        match: {
          id: 'field-match',
          tournament_id: 'field-cup',
          side_a_entry_id: 'field-a',
          side_b_entry_id: 'field-b',
          status: 'ready',
          score_revision: 0,
        },
        liveScore: state.liveState(),
        teamA,
        teamB,
        canStopLive: true,
      })

      state.mountScore = (teamA, teamB) => state.mount('MatchScoreModal', {
        match: {
          id: 'field-football',
          tournament_id: 'field-cup',
          side_a_entry_id: 'field-a',
          side_b_entry_id: 'field-b',
          side_a_score: null,
          side_b_score: null,
          side_a_pens: null,
          side_b_pens: null,
          status: 'ready',
          score_revision: 0,
        },
        entriesMap: {
          'field-a': { id: 'field-a', display_name: teamA, entry_members: [{ member_name: teamA, member_order: 1 }] },
          'field-b': { id: 'field-b', display_name: teamB, entry_members: [{ member_name: teamB, member_order: 1 }] },
        },
        family: 'goals',
        canEditFinal: true,
      })
    })

    const longA = 'Александра Международная Академия Турнирного Спорта Вильнюса'
    const longB = 'Объединённая Команда Северного Района имени Чемпионов Города'
    await p.evaluate(() => {
      document.documentElement.style.setProperty('--safe-area-top', '59px')
      document.documentElement.style.setProperty('--safe-area-right', '0px')
      document.documentElement.style.setProperty('--safe-area-bottom', '34px')
      document.documentElement.style.setProperty('--safe-area-left', '0px')
    })
    await p.evaluate(([teamA, teamB]) => field.mountLive(teamA, teamB), [longA, longB])
    await p.waitForSelector('.live-modal')
    await p.waitForFunction(() => document.querySelector('.live-tap')?.getBoundingClientRect().height >= 68)

    const viewportMeta = await p.locator('meta[name=viewport]').getAttribute('content')
    check(viewportMeta.includes('viewport-fit=cover'), 'Viewport opts into iPhone safe-area geometry')
    check(await p.evaluate(() => CSS.supports('padding-top: env(safe-area-inset-top)')), 'Browser supports safe-area environment variables')

    let geometry = await measure()
    check(fitsVisualViewport(geometry), 'Portrait scoring modal stays inside the visual viewport', JSON.stringify(geometry))
    check(geometry.backdropPadding.top >= 75 && geometry.backdropPadding.bottom >= 50, 'Scoring modal keeps content outside simulated iPhone safe areas', JSON.stringify(geometry.backdropPadding))
    check(geometry.documentWidth <= geometry.innerWidth + 1 && !geometry.backdropOverflow, 'Long team names do not create horizontal page overflow')
    const touchTargets = await p.locator('.live-tap, .live-sides__swap, .modal-close').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect()
      return { className: element.className, width: rect.width, height: rect.height }
    }))
    check(touchTargets.every(target => target.width >= 43.5 && target.height >= 43.5), 'Primary LIVE controls keep 44 × 44 px touch targets', JSON.stringify(touchTargets))
    check(await p.locator('.live-tap').nth(0).innerText() === longA && await p.locator('.live-tap').nth(1).innerText() === longB, 'Clamped visual labels retain the complete accessible team text')

    await p.locator('.live-tap').first().tap()
    await p.waitForFunction(() => field.rpcCalls.filter(call => call.name === 'record_point').length === 1)
    check(await p.locator('.live-board__points').first().innerText() === '15', 'A real touch event records one point and refreshes the score')
    await p.screenshot({ path: `output/playwright/mobile-device-qa/${engine}-portrait-live.png` })

    await p.setViewportSize({ width: 844, height: 390 })
    await p.evaluate(() => {
      document.documentElement.style.setProperty('--safe-area-top', '0px')
      document.documentElement.style.setProperty('--safe-area-right', '47px')
      document.documentElement.style.setProperty('--safe-area-bottom', '21px')
      document.documentElement.style.setProperty('--safe-area-left', '47px')
      window.dispatchEvent(new Event('orientationchange'))
    })
    await p.waitForTimeout(80)
    geometry = await measure()
    check(fitsVisualViewport(geometry), 'Landscape scoring modal follows the changed visual viewport', JSON.stringify(geometry))
    check(geometry.documentWidth <= geometry.innerWidth + 1 && !geometry.backdropOverflow, 'Landscape LIVE has no horizontal page overflow')
    await p.locator('.live-tap').last().scrollIntoViewIfNeeded()
    check(await p.locator('.live-tap').last().isVisible(), 'Both scoring sides remain reachable after rotation')
    await p.screenshot({ path: `output/playwright/mobile-device-qa/${engine}-landscape-live.png` })

    await p.setViewportSize({ width: 390, height: 844 })
    await p.evaluate(() => {
      document.documentElement.style.setProperty('--safe-area-top', '59px')
      document.documentElement.style.setProperty('--safe-area-right', '0px')
      document.documentElement.style.setProperty('--safe-area-bottom', '0px')
      document.documentElement.style.setProperty('--safe-area-left', '0px')
    })
    await p.evaluate(([teamA, teamB]) => field.mountScore(teamA, teamB), [longA, longB])
    await p.waitForSelector('.msm-goals input')
    await p.waitForFunction(() => document.querySelector('.msm-grid__input')?.getBoundingClientRect().width <= 53)
    await p.setViewportSize({ width: 390, height: 430 })
    await p.locator('.msm-goals input').nth(3).focus()
    await p.locator('.msm-goals input').nth(3).scrollIntoViewIfNeeded()
    await p.waitForTimeout(80)
    geometry = await measure()
    const focused = await p.locator('.msm-goals input').nth(3).evaluate(element => {
      const rect = element.getBoundingClientRect()
      const viewport = window.visualViewport
      return {
        active: element === document.activeElement,
        top: rect.top,
        bottom: rect.bottom,
        viewportTop: viewport?.offsetTop || 0,
        viewportBottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight),
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      }
    })
    check(fitsVisualViewport(geometry), 'Score editor follows a keyboard-height visual viewport', JSON.stringify(geometry))
    check(focused.active && focused.top >= focused.viewportTop - 1 && focused.bottom <= focused.viewportBottom + 1, 'Focused score field remains visible above the simulated keyboard', JSON.stringify(focused))
    check(focused.fontSize >= 16, 'Numeric score input avoids automatic iOS text zoom', `${focused.fontSize}px`)
    await p.screenshot({ path: `output/playwright/mobile-device-qa/${engine}-keyboard-score.png` })

    await p.setViewportSize({ width: 390, height: 844 })
    await p.evaluate(([teamA, teamB]) => field.mountLive(teamA, teamB), [longA, longB])
    await p.waitForSelector('.live-tap')
    await p.waitForFunction(() => document.querySelector('.live-tap')?.getBoundingClientRect().height >= 68)
    const beforeOffline = await p.evaluate(() => field.rpcCalls.length)
    await context.setOffline(true)
    await p.waitForFunction(() => document.querySelector('.live-tap')?.disabled === true)
    await p.locator('.live-tap').first().evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await p.waitForTimeout(60)
    check(await p.evaluate(count => field.rpcCalls.length === count, beforeOffline), 'A browser-level network loss blocks score mutations')
    check(await p.locator('.live-modal [role=alert]').isVisible(), 'A browser-level network loss is announced inside LIVE')
    await context.setOffline(false)
    await p.waitForFunction(() => document.querySelector('.live-tap')?.disabled === false)
    await p.locator('.live-tap').last().tap()
    await p.waitForFunction(count => field.rpcCalls.length === count + 1, beforeOffline)
    check(true, 'Scoring becomes available again after the browser reconnects')

    const frameSample = await p.evaluate(() => new Promise(resolve => {
      const intervals = []
      let previous = 0
      const started = performance.now()
      const tick = now => {
        if (previous) intervals.push(now - previous)
        previous = now
        if (now - started >= 1000) {
          const sorted = [...intervals].sort((a, b) => a - b)
          resolve({
            frames: intervals.length,
            median: sorted[Math.floor(sorted.length * 0.5)] || 0,
            p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
          })
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }))
    check(frameSample.frames >= 20 && frameSample.p95 < 100, 'LIVE remains responsive during a one-second frame sample', JSON.stringify(frameSample))

    check(errors.length === 0, 'No uncaught browser exceptions', errors.join('; '))
    check(escapedMutations.length === 0, 'No real backend mutation escaped the fixtures', escapedMutations.join('; '))
  } finally {
    await context.setOffline(false).catch(() => {})
    await context.close()
  }

  const failures = checks.filter(item => !item.ok)
  if (failures.length) {
    throw new Error(`${failures.length} device-profile check(s) failed:\n${checks.map(item => `${item.ok ? 'PASS' : 'FAIL'} — ${item.label}${item.detail ? `: ${item.detail}` : ''}`).join('\n')}`)
  }

  return {
    engine,
    passed: checks.length,
    checks: checks.map(item => item.label),
  }
}
