import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import i18n, { i18nReady } from './i18n'
import { initAnalytics } from './lib/analytics'
import './styles.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(i18n)

initAnalytics()
// A prerendered landing (scripts/prerender.mjs) stays on screen until its route is resolved,
// then Vue renders the same markup over it; otherwise mount right away.
// Messages of the active language arrive as a separate chunk before the first render.
const prerendered = document.getElementById('app')?.firstElementChild
const ready = prerendered ? Promise.all([i18nReady, router.isReady()]) : i18nReady
ready.catch(error => console.error('startup:', error)).finally(() => app.mount('#app'))
