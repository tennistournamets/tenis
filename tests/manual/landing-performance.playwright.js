// Run against scripts/serve-performance.mjs after npm run build.
// Cold production loads, 3 samples per mode, 390x844, CPU x4, 1.6 Mbps / 150 ms.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open the local production preview')
  // Keep the launcher idle so only the measured page uses the GPU.
  await page.goto('about:blank')
  const runs = [], errors = []
  for (const mode of ['on', 'off']) {
    for (let sample = 0; sample < 3; sample++) {
      const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
      const p = await context.newPage()
      const cdp = await context.newCDPSession(p)
      p.on('pageerror', error => errors.push(error.message))
      try {
        await cdp.send('Network.enable')
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
        await cdp.send('Network.clearBrowserCache')
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 93750, connectionType: 'cellular3g' })
        await p.addInitScript(mode => {
          localStorage.setItem('champ_locale', 'ru')
          localStorage.setItem('champ_landing3d', mode)
          Object.defineProperty(navigator, 'connection', { configurable: true, value: { effectiveType: '3g', downlink: 1.6, saveData: false } })
          window.landingPerf = { lcp: 0, shifts: 0, longTasks: [], sceneReady: 0 }
          new PerformanceObserver(list => { for (const e of list.getEntries()) landingPerf.lcp = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true })
          new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) landingPerf.shifts += e.value }).observe({ type: 'layout-shift', buffered: true })
          new PerformanceObserver(list => { for (const e of list.getEntries()) landingPerf.longTasks.push(e.duration) }).observe({ type: 'longtask', buffered: true })
          new MutationObserver(() => {
            if (!landingPerf.sceneReady && document.querySelector('.landing--3d')) landingPerf.sceneReady = performance.now()
          }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] })
        }, mode)
        await p.goto(origin, { waitUntil: 'domcontentloaded' })
        await p.waitForTimeout(10000)
        const data = await p.evaluate(() => ({ ...landingPerf,
          fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
          height: document.documentElement.scrollHeight,
          overflow: document.documentElement.scrollWidth > innerWidth,
          js: performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).map(r => ({ file: r.name.split('/').pop(), encoded: r.encodedBodySize })),
          canvas: Boolean(document.querySelector('.landing3d canvas')),
          ctaBottom: document.querySelector('.landing-hero .cinema-button').getBoundingClientRect().bottom,
        }))
        if (data.canvas !== (mode === 'on') || data.overflow || data.shifts > .02 || !data.fcp || data.ctaBottom > 844) throw new Error(`Production ${mode}: ${JSON.stringify(data)}`)
        if (mode === 'off' && data.js.some(r => /three\.module|LandingScene3D/.test(r.file))) throw new Error('Off mode downloaded 3D')
        runs.push({ mode, sample, ...data })
        if (sample === 2) await p.screenshot({ path: `output/playwright/mobile-step3-production-${mode}.png` })
      } finally { await context.close() }
    }
  }
  if (errors.length) throw new Error(errors.join('; '))
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  const summary = Object.fromEntries(['on', 'off'].map(mode => {
    const samples = runs.filter(run => run.mode === mode)
    return [mode, {
      fcp: median(samples.map(s => s.fcp)), lcp: median(samples.map(s => s.lcp)),
      sceneReady: median(samples.map(s => s.sceneReady)), shifts: median(samples.map(s => s.shifts)),
      longTasksMs: median(samples.map(s => s.longTasks.reduce((a, b) => a + b, 0))),
      jsBytes: median(samples.map(s => s.js.reduce((a, b) => a + b.encoded, 0))), height: samples[0].height,
    }]
  }))
  return { profile: 'Chromium touch emulation; 390x844/DPR2; CPU x4; 1.6 Mbps / 150ms; gzip; 10s observation; 3 cold samples/mode', summary, runs, errors }
}
