// Loaded by scripts/prerender.mjs through Vite's SSR loader: renders the whole App on the
// landing route for one locale. Supabase is stubbed by the loader, so no network is touched.
import { createSSRApp } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from 'vue/server-renderer'

import App from '../src/App.vue'
import HomeView from '../src/views/HomeView.vue'
import { messages } from '../src/i18n/messages'
import { LANDING_ROUTE_PATH, landingPath } from '../src/lib/localeRoute'

export async function renderLanding(locale) {
  const app = createSSRApp(App)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: LANDING_ROUTE_PATH, name: 'home', component: HomeView }],
  })
  app.use(createPinia())
  app.use(router)
  app.use(createI18n({ legacy: false, locale, fallbackLocale: 'en', messages }))
  await router.push(landingPath(locale))
  await router.isReady()
  return renderToString(app)
}
