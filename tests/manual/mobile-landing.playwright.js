// Step 3 acceptance against the real local Vue app; no external sign-in or writes.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open the local app first')
  const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  const p = await context.newPage()
  p.setDefaultTimeout(12000)
  const checks = [], errors = [], layouts = []
  const check = (ok, label) => { if (!ok) throw new Error(label); checks.push(label) }
  p.on('pageerror', e => errors.push(e.message))
  p.on('console', msg => { if (msg.text().includes('[intlify]')) errors.push(msg.text()) })
  await context.route('**/auth/v1/**', route => route.fulfill({ json: { user: null, session: null } }))
  await context.route('**/rest/v1/**', route => route.fulfill({ json: [] }))
  await p.addInitScript(() => {
    window.landingShifts = []
    window.landingDraws = 0
    for (const method of ['drawElements', 'drawArrays']) {
      const original = WebGL2RenderingContext.prototype[method]
      WebGL2RenderingContext.prototype[method] = function(...args) { landingDraws++; return original.apply(this, args) }
    }
    new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) landingShifts.push(e.value) }).observe({ type: 'layout-shift', buffered: true })
  })
  const geometry = () => p.evaluate(() => ({
    width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
    height: document.documentElement.scrollHeight,
    cta: document.querySelector('.landing-hero .cinema-button').getBoundingClientRect().toJSON(),
    sections: [...document.querySelectorAll('.landing-section')].map(el => Math.round(el.getBoundingClientRect().top + scrollY)),
  }))
  try {
    await p.goto(`${origin}/?no3d`)
    for (const locale of ['ru', 'en', 'lt']) {
      await p.evaluate(locale => localStorage.setItem('champ_locale', locale), locale)
      for (const width of [320, 390, 430, 768, 1280]) {
        await p.setViewportSize({ width, height: width === 320 ? 568 : 844 })
        await p.reload()
        await p.waitForSelector('.landing-hero__title')
        const metrics = await geometry()
        layouts.push({ locale, ...metrics })
        check(!metrics.overflow, `${locale}/${width}: no horizontal overflow`)
        check(metrics.cta.bottom < (width === 320 ? 568 : 844), `${locale}/${width}: primary action on first screen`)
        check(await p.locator('.landing3d canvas').count() === 0, `${locale}/${width}: no3d requests no canvas`)
        check(await p.locator('.landing-hero__note').first().innerText().then(text => text.includes('Google')), `${locale}/${width}: Google sign-in explained`)
        if (width <= 720) {
          check(await p.locator('[data-stage]:visible').count() === 2, `${locale}/${width}: only cup and bracket stages`)
          check(metrics.height < (width === 320 ? 5400 : 4900), `${locale}/${width}: compact page (${metrics.height}px)`)
        }
        if (locale === 'ru' && width === 390) {
          await p.screenshot({ path: 'output/playwright/mobile-step3-static.png', fullPage: true })
        }
      }
    }

    await p.setViewportSize({ width: 390, height: 844 })
    await p.evaluate(() => { localStorage.setItem('champ_locale', 'ru'); localStorage.setItem('champ_landing3d', 'on') })
    // Hold the async scene so geometry is measured before and after it mounts.
    let releaseScene
    const sceneGate = new Promise(resolve => { releaseScene = resolve })
    await p.route('**/LandingScene3D.vue*', async route => { await sceneGate; await route.continue() })
    await p.goto(origin, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.landing-hero__title')
    await p.evaluate(() => document.fonts.ready)
    const loading = await geometry()
    releaseScene()
    await p.waitForSelector('.landing--3d')
    const ready = await geometry()
    check(JSON.stringify(loading.sections) === JSON.stringify(ready.sections) && loading.height === ready.height, `loading 3D does not move page sections: ${JSON.stringify({ loading, ready })}`)
    check(await p.evaluate(() => landingShifts.reduce((a, b) => a + b, 0) < .02), 'initial layout shifts below .02')
    await p.unroute('**/LandingScene3D.vue*')
    await p.screenshot({ path: 'output/playwright/mobile-step3-3d.png' })

    await p.getByRole('switch').click()
    check(await p.locator('.landing3d canvas').count() === 0, 'switch releases WebGL canvas')
    const off = await geometry()
    check(off.height === ready.height && JSON.stringify(off.sections) === JSON.stringify(ready.sections), `switch preserves geometry: ${JSON.stringify({ ready, off })}`)
    await p.reload()
    check(await p.getByRole('switch').getAttribute('aria-checked') === 'false', 'animation choice persists after reload')
    check(await p.evaluate(() => !performance.getEntriesByType('resource').some(r => /LandingScene3D|three\.module|three\.js/.test(r.name))), 'saved off choice skips 3D download')
    await p.getByRole('switch').click()
    await p.waitForSelector('.landing--3d')
    check(await p.evaluate(() => localStorage.getItem('champ_landing3d')) === 'on', 'animation can be enabled again')
    await p.locator('#chapter-2').scrollIntoViewIfNeeded()
    await p.screenshot({ path: 'output/playwright/mobile-step3-bracket.png' })
    await p.locator('#features').scrollIntoViewIfNeeded()
    check(!await p.evaluate(() => [...document.querySelectorAll('[data-stage]')].some(el => { const r = el.getBoundingClientRect(); return r.width && r.height && r.top < innerHeight && r.bottom > 0 })), 'features are a text-only section')
    await p.waitForTimeout(250)
    const idleDraws = await p.evaluate(() => landingDraws)
    await p.waitForTimeout(250)
    check(await p.evaluate(() => landingDraws) === idleDraws, 'GPU rendering stops outside the two mobile stages')
    await p.evaluate(() => window.scrollTo(0, 0))
    await p.waitForFunction(count => landingDraws > count, idleDraws)
    check(true, 'GPU rendering resumes when the cup returns to view')
    await p.setViewportSize({ width: 844, height: 390 })
    await p.waitForSelector('.landing--3d')
    check(await p.locator('.landing3d canvas').count() === 1 && !(await geometry()).overflow, 'orientation change keeps one canvas without overflow')
    await p.setViewportSize({ width: 390, height: 844 })
    await p.waitForSelector('.landing--3d')

    // Test the UI's pending guard and failure recovery without opening Google.
    await p.evaluate(() => {
      const auth = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('auth')
      window.signInCalls = 0
      auth.signInWithGoogle = () => { signInCalls++; return new Promise((_, reject) => { window.rejectSignIn = reject }) }
    })
    await p.locator('.landing-hero .cinema-button').click()
    check(await p.locator('.cinema-button:disabled').count() === 2 && await p.locator('.cinema-login').isDisabled(), 'all sign-in controls disabled while pending')
    check((await p.locator('.landing-hero .cinema-button').innerText()).includes('Открываем Google'), 'pending label names Google')
    await p.evaluate(() => { document.querySelector('.landing-hero .cinema-button').click(); rejectSignIn(new Error('fixture')) })
    await p.waitForSelector('.cinema-error')
    check(await p.evaluate(() => signInCalls) === 1, 'repeated tap cannot start duplicate sign-in')
    check(await p.locator('.landing-hero .cinema-button').isEnabled(), 'sign-in failure allows retry')

    await p.emulateMedia({ reducedMotion: 'reduce' })
    await p.waitForSelector('.landing--paused')
    check(await p.getByRole('switch').isDisabled() && await p.locator('.landing3d canvas').count() === 0, 'system reduced motion removes animation')
    await p.reload()
    check(await p.evaluate(() => !performance.getEntriesByType('resource').some(r => /LandingScene3D|three\.module|three\.js/.test(r.name))), 'reduced motion skips 3D download on reload')
    await p.emulateMedia({ reducedMotion: 'no-preference' })
    await p.waitForSelector('.landing--3d')
    await p.evaluate(() => document.querySelector('.landing3d canvas').dispatchEvent(new Event('webglcontextlost', { cancelable: true })))
    check(await p.locator('.landing3d canvas').count() === 0 && await p.locator('.landing-hero .landing-still').isVisible(), 'WebGL context loss keeps readable artwork and controls')

    await p.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } }))
    await p.reload()
    check(await p.getByRole('switch').isDisabled(), 'save-data setting disables animation')
    check(await p.evaluate(() => !performance.getEntriesByType('resource').some(r => /LandingScene3D|three\.module|three\.js/.test(r.name))), 'save-data skips 3D download')
    await p.emulateMedia({ colorScheme: 'dark' })
    await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.scrollTo(0, 0) })
    await p.screenshot({ path: 'output/playwright/mobile-step3-dark.png' })
    for (const failure of ['chunk', 'webgl']) {
      const fallbackContext = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
      try {
        const fallback = await fallbackContext.newPage()
        fallback.on('pageerror', error => errors.push(error.message))
        if (failure === 'chunk') await fallback.route('**/LandingScene3D.vue*', route => route.abort())
        else await fallback.addInitScript(() => {
          const original = HTMLCanvasElement.prototype.getContext
          HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return String(kind).startsWith('webgl') ? null : original.call(this, kind, ...args) }
        })
        await fallback.goto(origin)
        await fallback.waitForFunction(() => document.querySelector('#motion-note')?.textContent.includes('недоступно'))
        check(await fallback.locator('.landing-hero .landing-still').isVisible() && await fallback.locator('.landing-hero .cinema-button').isEnabled(), `${failure} failure preserves artwork and primary action`)
        check(await fallback.locator('.landing3d canvas').count() === 0, `${failure} failure leaves no canvas`)
      } finally { await fallbackContext.close() }
    }
    check(errors.length === 0, `no runtime or translation errors: ${errors.join('; ')}`)
    return { passed: checks.length, checks, layouts, errors }
  } catch (error) {
    throw new Error(`${error.message}; last completed check: ${checks.at(-1)}`)
  } finally { await context.close() }
}
