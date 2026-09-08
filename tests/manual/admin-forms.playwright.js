// Run on a local Vite page via playwright_cli.sh -s=admin11 run-code --filename=tests/manual/admin-forms.playwright.js
// Real Vue forms and parent view; all persistence and Realtime are replaced with
// deterministic in-browser fixtures. This script never writes a real tournament.
async page => {
  const origin = await page.evaluate(() => location.origin)
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open the local Vite page first')
  page.setDefaultTimeout(10000)
  const checks = []
  const check = (value, name) => { if (!value) throw new Error(name); checks.push(name) }
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/rest/v1/**', route => route.fulfill({ json: [] }))
  await page.goto(`${origin}/`)
  await page.evaluate(async () => {
    document.querySelector('#app').__vue_app__?.unmount()
    const dependencyUrl = name => performance.getEntriesByType('resource').find(entry => entry.name.includes(`/node_modules/.vite/deps/${name}.js?v=`))?.name || `/node_modules/.vite/deps/${name}.js`
    const vue = await import(dependencyUrl('vue'))
    const { createI18n } = await import(dependencyUrl('vue-i18n'))
    const { createRouter, createMemoryHistory } = await import(dependencyUrl('vue-router'))
    const { createPinia } = await import(dependencyUrl('pinia'))
    const { messages } = await import('/src/i18n/messages.js')
    const { supabase } = await import('/src/lib/supabase.js')
    const { useAuthStore } = await import('/src/stores/auth.js')
    const { hasUnsavedChanges } = await import('/src/lib/unsavedChanges.js')
    const { settleConfirm } = await import('/src/lib/confirmDialog.js')
    const { default: ConfirmDialog } = await import('/src/components/ConfirmDialog.vue')
    const clone = value => JSON.parse(JSON.stringify(value))
    const base = { id: 'admin-forms', slug: 'admin-forms', name: 'Form Cup', description: '', category: 'singles', sport: 'tennis',
      format: 'single_elimination', status: 'registration_open', set_format: 'best_of_3', settings_revision: 1,
      scoring_config: {}, doubles_pairing_mode: 'pre_agreed', is_public: true }
    window.af = { vue, app: null, i18n: createI18n({ legacy: false, locale: 'ru', messages }), clone, base,
      calls: [], mode: '', tournament: clone(base), role: 'owner', hasUnsavedChanges, settleConfirm, refreshes: 0 }
    af.snapshot = () => ({ tournament: clone(af.tournament), entries: [], matches: [], sets: [], live: [], groups: [], standings: [], group_standings: {} })
    supabase.rpc = async (name, args) => {
      if (name === 'get_tournament_sync_state') { af.refreshes++; return { data: af.snapshot(), error: null } }
      if (name === 'get_my_tournament_role') return { data: af.role, error: null }
      if (name === 'get_tournament_admins_with_email') return { data: [], error: null }
      af.calls.push({ name, args: clone(args) })
      if (af.mode === 'delay') await new Promise(resolve => { af.resolve = resolve })
      if (af.mode === 'fail') return { data: null, error: { message: 'Not allowed' } }
      return { data: { ...af.tournament, ...args.p_patch, settings_revision: args.p_expected_revision + 1 }, error: null }
    }
    supabase.from = table => ({
      insert: rows => {
        af.calls.push({ table, action: 'insert', rows: clone(rows) })
        if (table === 'entries') return { select: () => ({ single: async () => {
          if (af.mode === 'delay') await new Promise(resolve => { af.resolve = resolve })
          if (af.mode === 'throw') throw new Error('Network unavailable')
          if (af.mode === 'duplicate') return { data: null, error: { code: '23505', message: 'duplicate key' } }
          return { data: { id: 'new-entry' }, error: null }
        } }) }
        return Promise.resolve({ error: af.mode === 'members-fail' ? { message: 'Member insert denied' } : null })
      },
      delete: () => ({ eq: async (key, id) => { af.calls.push({ table, action: 'delete', key, id }); return { error: null } } }),
    })
    supabase.channel = () => {
      const channel = { on: () => channel, subscribe: () => channel }
      return channel
    }
    supabase.removeChannel = async () => 'ok'
    af.mount = async (file, props = {}) => {
      af.app?.unmount(); af.settleConfirm(false)
      af.calls = []; af.mode = ''; af.saved = 0; af.role = 'owner'; af.tournament = clone(base)
      af.props = vue.reactive({ tournament: clone(af.tournament), matches: [], canManage: true, busy: false,
        refresh: async () => { af.props.tournament = clone(af.tournament) },
        'onUpdate:busy': value => { af.props.busy = value },
        'onUpdate:saving': value => { af.saving = value },
        onSaved: data => {
          af.saved++
          if (data && data.settings_revision >= af.props.tournament.settings_revision) {
            af.tournament = clone(data); af.props.tournament = clone(data)
          }
        }, ...props })
      const { default: component } = await import(`/src/${file}.vue`)
      const pinia = createPinia()
      const auth = useAuthStore(pinia); auth.ready = true; auth.user = { id: 'fixture-owner' }
      const router = createRouter({ history: createMemoryHistory(), routes: [
        { path: '/', component: { render: () => null } },
        { path: '/admin', name: 'admin-tournaments', component: { render: () => null } },
        { path: '/tournaments/:slug', name: 'public-tournament', component: { render: () => null } },
      ] })
      af.app = vue.createApp({ render: () => vue.h('div', [vue.h(component, af.props), vue.h(ConfirmDialog)]) })
      af.app.use(af.i18n).use(pinia).use(router).mount('#app')
      await vue.nextTick()
    }
  })

  await page.evaluate(() => af.mount('components/admin/TournamentSettingsForm'))
  const saveSettings = page.locator('.admin-settings-card__footer .btn--primary')
  check(await saveSettings.isDisabled() && !await page.evaluate(() => af.hasUnsavedChanges()), 'Settings: pristine snapshot has no draft')
  await page.locator('#adm-name').fill('My local name')
  check(await page.evaluate(() => af.hasUnsavedChanges()), 'Settings: child registers unsaved changes')
  await page.evaluate(() => { af.tournament = { ...af.tournament, name: 'Remote name', settings_revision: 2 }; af.props.tournament = af.clone(af.tournament) })
  check(await page.locator('#adm-name').inputValue() === 'My local name' && await saveSettings.isDisabled(), 'Settings: remote revision preserves draft and disables stale save')
  await page.locator('.admin-settings-card [role=status] button').click()
  await page.locator('.confirm-dialog .btn--ghost').click()
  check(await page.locator('#adm-name').inputValue() === 'My local name', 'Settings: cancelling reload preserves draft')
  await page.locator('.admin-settings-card [role=status] button').click()
  await page.locator('.confirm-dialog .btn--danger').click()
  await page.waitForFunction(() => document.querySelector('#adm-name').value === 'Remote name')
  check(!await page.evaluate(() => af.hasUnsavedChanges()), 'Settings: confirmed reload adopts current snapshot and clears draft')
  await page.locator('#adm-name').fill('Retry name')
  await page.evaluate(() => { af.mode = 'fail' })
  await saveSettings.click()
  await page.locator('.admin-settings-card [role=alert]').waitFor()
  check(await page.locator('#adm-name').inputValue() === 'Retry name' && !await saveSettings.isDisabled(), 'Settings: denied save keeps editable draft')
  await page.evaluate(() => { af.mode = 'delay'; af.calls = [] })
  await saveSettings.click()
  check(await page.locator('#adm-name').isDisabled() && await page.evaluate(() => af.saving && af.calls[0].args.p_expected_revision === 2), 'Settings: in-flight save locks fields and retains baseline revision')
  await page.evaluate(() => { af.tournament = { ...af.tournament, name: 'Newest name', settings_revision: 4 }; af.props.tournament = af.clone(af.tournament); af.resolve() })
  await page.waitForFunction(() => !af.saving)
  check(await page.locator('#adm-name').inputValue() === 'Newest name' && !await page.evaluate(() => af.hasUnsavedChanges()), 'Settings: newer realtime snapshot wins over delayed save response')

  await page.evaluate(() => af.mount('components/admin/TournamentSettingsForm', { matches: [{ id: 'existing-match', score_revision: 7 }] }))
  await page.locator('#adm-cat').selectOption('doubles')
  await saveSettings.click()
  await page.locator('.confirm-dialog .btn--ghost').click()
  check(await page.evaluate(() => af.calls.length === 0), 'Settings: cancelling category reset performs no write')
  await saveSettings.click()
  await page.locator('.confirm-dialog .btn--danger').click()
  await page.waitForFunction(() => af.saved === 1)
  check(await page.evaluate(() => af.calls[0].args.p_expected_matches[0].revision === 7 && !('slug' in af.calls[0].args.p_patch)), 'Settings: category reset preserves expected match versions and immutable slug')

  await page.evaluate(() => af.mount('components/admin/TournamentSettingsForm', { tournament: { ...af.base, status: 'in_progress' } }))
  check(!await page.locator('#adm-name').isDisabled() && !await page.locator('#adm-desc').isDisabled(), 'Settings: active tournament name and description remain editable')
  check(await page.locator('#adm-cat').isDisabled() && await page.locator('#adm-status').isDisabled(), 'Settings: active tournament structure and status remain locked')
  check(!await page.locator('#adm-contact-phone').isDisabled() && await page.locator('#adm-publish-contact').isDisabled(), 'Settings: organizer contact remains editable and unpublished without a value')
  await page.locator('#adm-contact-phone').fill(' +370 600 00000 ')
  await page.locator('#adm-publish-contact').check()
  await page.locator('.admin-settings-card__footer .btn--primary').click()
  check(await page.evaluate(() => af.calls[0].args.p_patch.contact_phone === '+370 600 00000' && af.calls[0].args.p_patch.publish_contact === true), 'Settings: explicit contact publication is saved with normalized public details')

  for (const locale of ['ru', 'en', 'lt']) {
    await page.evaluate(locale => { af.i18n.global.locale.value = locale }, locale)
    await page.evaluate(() => af.mount('components/admin/ManualEntryForm'))
    await page.locator('#adm-add-entry-trigger').click()
    await page.locator('#adm-add-m1').fill('Player one')
    await page.locator('#adm-add-contact').fill('invalid-contact')
    await page.locator('.admin-add-entry button[type=submit]').click()
    check(await page.locator('.admin-add-entry [role=alert]').innerText() === await page.evaluate(() => af.i18n.global.t('registrationForm.invalidContact')) && await page.evaluate(() => af.calls.length === 0), `${locale}: invalid manual contact is translated and never written`)
  }
  await page.locator('#adm-add-contact').fill('person@example.test')
  await page.evaluate(() => { af.mode = 'duplicate' })
  await page.locator('.admin-add-entry button[type=submit]').click()
  check(await page.locator('.admin-add-entry [role=alert]').innerText() === await page.evaluate(() => af.i18n.global.t('admin.addEntryDuplicateContact')) && await page.locator('#adm-add-m1').inputValue() === 'Player one', 'Manual entry: duplicate keeps draft and displays specific error')
  await page.evaluate(() => { af.mode = 'throw' })
  await page.locator('.admin-add-entry button[type=submit]').click()
  check(await page.locator('.admin-add-entry [role=alert]').innerText() === 'Network unavailable' && !await page.locator('#adm-add-m1').isDisabled(), 'Manual entry: thrown network error releases busy lock and preserves input')
  await page.evaluate(() => { af.mode = 'members-fail'; af.calls = [] })
  await page.locator('.admin-add-entry button[type=submit]').click()
  check(await page.evaluate(() => af.calls.some(call => call.table === 'entries' && call.action === 'delete') && af.saved === 0) && await page.locator('#adm-add-m1').inputValue() === 'Player one', 'Manual entry: member failure removes incomplete entry and retains draft')
  await page.evaluate(() => { af.props.tournament = { ...af.props.tournament, category: 'doubles', doubles_pairing_mode: 'pre_agreed' } })
  check(await page.locator('#adm-add-m2').getAttribute('required') !== null, 'Manual entry: agreed doubles require both members')
  await page.locator('#adm-add-m2').fill('Player two')
  await page.locator('#adm-add-contact').fill('')
  await page.evaluate(() => { af.mode = 'delay'; af.calls = [] })
  await page.locator('.admin-add-entry button[type=submit]').click()
  check(await page.locator('#adm-add-m1').isDisabled() && await page.evaluate(() => af.hasUnsavedChanges()), 'Manual entry: pending save locks fields and blocks departure')
  await page.evaluate(() => af.resolve())
  await page.waitForFunction(() => af.saved === 1 && !af.props.busy)
  check(await page.evaluate(() => af.calls[0].rows.phone_or_email.endsWith('@local.tenis') && af.calls[1].rows.length === 2 && !af.hasUnsavedChanges()) && await page.locator('#adm-add-m1').inputValue() === '', 'Manual entry: success persists both members, creates optional contact and clears draft')
  await page.locator('#adm-add-m1').fill('Unsaved player')
  await page.evaluate(() => { af.props.tournament = { ...af.props.tournament, status: 'in_progress' } })
  check(await page.locator('#adm-add-m1').inputValue() === 'Unsaved player' && await page.locator('#adm-add-m1').isDisabled(), 'Manual entry: tournament start keeps visible draft and locks edits')

  await page.evaluate(() => { af.i18n.global.locale.value = 'ru'; return af.mount('views/AdminTournamentView', { id: 'admin-forms' }) })
  await page.locator('#adm-add-entry-trigger').click()
  await page.locator('#adm-add-m1').fill('Parent entry draft')
  await page.locator('#tab-settings').click()
  await page.locator('#adm-name').fill('Parent settings draft')
  await page.evaluate(() => { af.tournament = { ...af.tournament, name: 'Parent remote name', settings_revision: 2 }; window.dispatchEvent(new Event('online')) })
  await page.locator('.admin-settings-card [role=status] button').waitFor()
  check(await page.locator('#adm-name').inputValue() === 'Parent settings draft', 'Parent: snapshot refresh reaches extracted settings without overwriting draft')
  await page.evaluate(() => { af.role = 'counter'; window.dispatchEvent(new Event('online')) })
  await page.locator('#tab-settings').waitFor({ state: 'hidden' })
  check(await page.evaluate(() => af.hasUnsavedChanges()), 'Parent: permission change keeps hidden drafts registered')
  await page.evaluate(() => { af.role = 'owner'; window.dispatchEvent(new Event('online')) })
  await page.locator('#tab-settings').click()
  check(await page.locator('#adm-name').inputValue() === 'Parent settings draft', 'Parent: restoring permission retains settings draft')
  await page.locator('#tab-entries').click()
  check(await page.locator('#adm-add-m1').inputValue() === 'Parent entry draft', 'Parent: tabs and permission changes retain participant draft')
  await page.locator('#adm-add-m1').fill('')
  await page.locator('#tab-settings').click()
  await page.locator('.admin-settings-card [role=status] button').click()
  await page.locator('.confirm-dialog .btn--danger').click()
  await page.waitForFunction(() => document.querySelector('#adm-name').value === 'Parent remote name')
  await page.locator('#adm-name').fill('Parent saved name')
  await page.evaluate(() => { af.mode = 'delay'; af.calls = [] })
  await saveSettings.click()
  await page.locator('#tab-entries').click()
  check(await page.locator('#adm-add-m1').isDisabled(), 'Parent: settings save propagates busy lock to participant form')
  await page.evaluate(() => document.querySelector('.admin-add-entry form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  check(await page.evaluate(() => af.calls.length === 1), 'Parent: participant submission cannot overlap pending settings save')
  await page.evaluate(() => af.resolve())
  await page.waitForFunction(() => document.querySelector('#adm-tournament-title').textContent === 'Parent saved name')
  check(!await page.locator('#adm-add-m1').isDisabled(), 'Parent: saved settings update overview and release action lock')
  await page.evaluate(() => { af.app.unmount(); af.settleConfirm(false) })
  check(!await page.evaluate(() => af.hasUnsavedChanges()), 'Unmount: both forms unregister departure guards')
  check(errors.length === 0, `No browser exceptions: ${errors.join('; ')}`)
  await page.unrouteAll({ behavior: 'wait' })
  await page.goto(`${origin}/`)
  return { passed: checks.length, checks }
}
