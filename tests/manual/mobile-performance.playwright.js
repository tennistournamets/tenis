// Open scripts/serve-performance.mjs in Playwright CLI, then run this file.
// Synthetic public tournament, no database writes. 5 cold navigations, fixed
// mobile viewport + CPU/network throttles. API responses take a fixed 150 ms.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Use the local performance server')
  page.setDefaultTimeout(60000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150,
    downloadThroughput: 200000, uploadThroughput: 93750, connectionType: 'cellular3g' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    localStorage.clear(); localStorage.setItem('champ_locale', 'ru')
    // Fix the 2D data-saving tier; the optional 3D tier is checked separately.
    Object.defineProperty(navigator, 'connection', { configurable: true,
      value: { effectiveType: '3g', downlink: 1.6, saveData: true } })
    window.perfCheck = { lcp: 0, longTasks: [], ready: 0, live: 0, updated: 0 }
    new PerformanceObserver(list => { for (const e of list.getEntries()) perfCheck.lcp = e.startTime })
      .observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver(list => { for (const e of list.getEntries()) perfCheck.longTasks.push(e.duration) })
      .observe({ type: 'longtask', buffered: true })
    new MutationObserver(() => {
      if (!perfCheck.ready && document.querySelector('.mobile-match__actions .btn--primary, .match-card__live')) perfCheck.ready = performance.now()
      if (!perfCheck.live && document.querySelector('.live-scoreboard')) perfCheck.live = performance.now()
      if (!perfCheck.updated && document.querySelector('.live-scoreboard__point')?.textContent === '15') perfCheck.updated = performance.now()
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
  await page.routeWebSocket('**/realtime/**', socket => socket.close())
  let revision = 0
  const requests = []
  const fixture = () => {
    const entries = Array.from({ length: 16 }, (_, i) => ({ id: `entry-${i}`, status: 'approved',
      display_name: `Игрок ${i + 1}`, entry_members: [{ member_name: `Игрок ${i + 1}` }] }))
    const matches = []
    for (let round = 1; round <= 4; round++) {
      for (let n = 0; n < 2 ** (4 - round); n++) matches.push({ id: `match-${round}-${n}`,
        tournament_id: 'perf-cup', stage: 'winners', round_number: round, match_number: n + 1,
        side_a_entry_id: round === 1 ? `entry-${n * 2}` : null,
        side_b_entry_id: round === 1 ? `entry-${n * 2 + 1}` : null,
        status: round === 1 ? 'ready' : 'pending', side_a_score: null, side_b_score: null })
    }
    return { tournament: { id: 'perf-cup', slug: 'perf-cup', name: 'Мобильный кубок',
      sport: 'tennis', category: 'singles', format: 'single_elimination', set_format: 'best_of_3',
      status: 'in_progress', is_public: true, scoring_config: {} }, entries, matches, sets: [],
      live: [{ id: 'live-perf', match_id: 'match-1-0', status: 'active', revision,
        state: { points: { a: revision, b: 0 }, games: { a: 0, b: 0 }, sets: [], winner: null } }],
      groups: [], standings: [], group_standings: {} }
  }
  await page.route('**/rest/v1/**', async route => {
    requests.push(route.request().url().split('/rest/v1/')[1].split('?')[0])
    await page.waitForTimeout(150)
    await route.fulfill({ json: route.request().url().includes('/rpc/get_tournament_sync_state') ? fixture() : { id: 'perf-cup' } })
  })
  const errors = []
  const onError = e => errors.push(e.message)
  page.on('pageerror', onError)
  const runs = []
  try {
    for (let run = 0; run < 5; run++) {
      revision = 0; requests.length = 0
      await cdp.send('Network.clearBrowserCache')
      await page.goto(`${origin}/tournaments/perf-cup`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.mobile-match__actions .btn--primary, .match-card__live')
      await page.waitForTimeout(200)
      const initial = await page.evaluate(() => ({ ...perfCheck,
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
        js: performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).map(r => ({ file: r.name.split('/').pop(), encoded: r.encodedBodySize, decoded: r.decodedBodySize })),
        overflow: document.documentElement.scrollWidth > innerWidth }))
      const initialRequests = [...requests]
      await page.evaluate(() => { perfCheck.click = performance.now(); document.querySelector('.mobile-match__actions .btn--primary, .match-card__live').click() })
      await page.waitForSelector('.live-scoreboard')
      const beforeUpdate = requests.length
      revision = 1
      await page.evaluate(() => { perfCheck.updateSent = performance.now(); window.dispatchEvent(new Event('online')) })
      await page.waitForFunction(() => perfCheck.updated > 0)
      const live = await page.evaluate(() => ({ openMs: perfCheck.live - perfCheck.click,
        refreshMs: perfCheck.updated - perfCheck.updateSent,
        overflow: document.documentElement.scrollWidth > innerWidth,
        scene2d: Boolean(document.querySelector('.rally__scene')),
        js: performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).map(r => ({ file: r.name.split('/').pop(), encoded: r.encodedBodySize, decoded: r.decodedBodySize })) }))
      runs.push({ initial, initialRequests, live, refreshRequests: requests.slice(beforeUpdate) })
      if (run === 4) await page.screenshot({ path: `output/playwright/step11-mobile-${origin.split(':').pop()}.png` })
    }
    // Check the affordable 3D tier separately: tabular score stays visible
    // while the optional scene loads. Frame rate here describes this desktop
    // GPU under CPU throttling, not a physical phone's GPU.
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      navigator.connection.saveData = false
      perfCheck.sceneClick = performance.now()
      document.querySelector('.mobile-match__actions .btn--primary, .match-card__live').click()
    })
    await page.waitForSelector('.live-scoreboard')
    const scoreWhileLoading = await page.locator('.live-scoreboard__point').first().innerText()
    const canvas = await page.waitForSelector('.rally3d__canvas canvas', { timeout: 15000 }).catch(() => null)
    const threeD = await page.evaluate(async available => {
      const readyMs = performance.now() - perfCheck.sceneClick
      const frames = []
      if (available) await new Promise(resolve => {
        let start, previous
        function frame(now) {
          if (previous) frames.push(now - previous)
          start ??= now; previous = now
          if (now - start >= 2000) resolve()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      })
      return { available, readyMs, frames, fallback2d: Boolean(document.querySelector('.rally__scene')),
        js: performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).map(r => ({ file: r.name.split('/').pop(), encoded: r.encodedBodySize, decoded: r.decodedBodySize })),
        overflow: document.documentElement.scrollWidth > innerWidth }
    }, Boolean(canvas))
    threeD.scoreWhileLoading = scoreWhileLoading
    await page.screenshot({ path: `output/playwright/step11-mobile-3d-${origin.split(':').pop()}.png` })
    await page.keyboard.press('Escape')
    threeD.removedOnClose = await page.locator('.rally3d__canvas canvas').count() === 0
    // Simulate an unavailable GPU; the real modal must retain its 2D score view.
    await page.evaluate(() => {
      const getContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
        return String(kind).startsWith('webgl') ? null : getContext.call(this, kind, ...args)
      }
      document.querySelector('.mobile-match__actions .btn--primary, .match-card__live').click()
    })
    await page.waitForSelector('.rally__scene')
    threeD.noWebglFallback = await page.locator('.live-scoreboard__point').first().innerText() === '15'
    const translations = []
    for (const [option, title] of [['EN English', 'Live scoreboard'], ['LT Lietuvių', 'Live švieslentė'], ['RU Русский', 'Live-табло']]) {
      await page.keyboard.press('Escape')
      await page.locator('.lang-dropdown__trigger').click()
      await page.getByRole('option', { name: option }).click()
      await page.locator('.mobile-match__actions .btn--primary, .match-card__live').click()
      await page.waitForSelector('.live-scoreboard')
      translations.push({ option, correct: await page.locator('.live-modal h2').innerText() === title })
    }
    if (errors.length || translations.some(result => !result.correct) || !threeD.noWebglFallback || !threeD.removedOnClose) {
      throw new Error(`LIVE production check failed: ${JSON.stringify({ errors, translations, threeD })}`)
    }
    return { browser: (await cdp.send('Browser.getVersion')).product,
      profile: { viewport: '390x844', cpuSlowdown: 4, networkMbps: 1.6, latencyMs: 150, apiDelayMs: 150, gzip: true, rendering: '2d', samples: 5 }, runs, threeD, translations, errors }
  } finally {
    page.removeListener('pageerror', onError)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await cdp.detach()
    await page.goto('about:blank')
    await page.unroute('**/rest/v1/**')
  }
}
