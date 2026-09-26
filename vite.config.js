import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { siteOrigin } from './src/lib/seo.js'
import { localeMessages } from './scripts/vite-locale-messages.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const privateNames = Object.keys(env).filter(key => /PASSWORD|SECRET|SERVICE_ROLE|DATABASE|DB_/i.test(key))
  if (privateNames.length) throw new Error(`Private credentials must not use the public VITE_ prefix: ${privateNames.join(', ')}`)
  const origin = siteOrigin(loadEnv(mode, process.cwd(), ['SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL']))
  return {
    plugins: [vue(), localeMessages(), siteOriginHtml(origin)],
    // All translations use the Composition API; keep the message compiler for
    // runtime RU/EN/LT switching, omit unused legacy API and template helpers.
    define: { __VUE_I18N_FULL_INSTALL__: false, __VUE_I18N_LEGACY_API__: false, __SITE_ORIGIN__: JSON.stringify(origin) },
    server: { host: true, port: 5173 },
    // scripts/prerender.mjs reads the manifest to link the landing's CSS, then deletes it.
    build: { manifest: true },
  }
})

// Open Graph needs absolute URLs. SITE_URL (own domain) or Vercel's production domain;
// without either the tags stay relative, which most crawlers still resolve.
function siteOriginHtml(origin) {
  return {
    name: 'bracketa-site-origin',
    transformIndexHtml: html => html.replaceAll('__SITE_ORIGIN__', origin),
  }
}
