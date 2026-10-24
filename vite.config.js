import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { siteOrigin } from './src/lib/seo.js'
import { localeMessages } from './scripts/vite-locale-messages.js'
import { OCR_BASE, ocrAssets } from './scripts/vite-ocr-assets.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const privateNames = Object.keys(env).filter(key => /PASSWORD|SECRET|SERVICE_ROLE|DATABASE|DB_/i.test(key))
  if (privateNames.length) throw new Error(`Private credentials must not use the public VITE_ prefix: ${privateNames.join(', ')}`)
  const origin = siteOrigin(loadEnv(mode, process.cwd(), ['SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL']))
  return {
    plugins: [vue(), localeMessages(), siteOriginHtml(origin), devAi(mode), ocrAssets()],
    // All translations use the Composition API; keep the message compiler for
    // runtime RU/EN/LT switching, omit unused legacy API and template helpers.
    define: { __VUE_I18N_FULL_INSTALL__: false, __VUE_I18N_LEGACY_API__: false, __SITE_ORIGIN__: JSON.stringify(origin), __OCR_BASE__: JSON.stringify(OCR_BASE) },
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

// `npm run dev` has no Vercel runtime: serve the AI functions locally. Their server-only keys
// (DEEPSEEK_API_KEY, GROQ_API_KEY) are read from .env here and never reach the bundle, which
// only sees VITE_*.
const DEV_FUNCTIONS = { '/api/ai': ['/api/ai.js', 'handleAi'], '/api/transcribe': ['/api/transcribe.js', 'handleTranscribe'] }

function devAi(mode) {
  return {
    name: 'bracketa-dev-ai',
    apply: 'serve',
    configureServer(server) {
      const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (!Object.hasOwn(DEV_FUNCTIONS, path)) return next()
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' }
        if (req.headers.authorization) headers.Authorization = req.headers.authorization
        const [file, handler] = DEV_FUNCTIONS[path]
        const module = await server.ssrLoadModule(file)
        const response = await module[handler](new Request(`http://localhost${req.url}`, { method: 'POST', headers, body: Buffer.concat(chunks) }), { env })
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
  }
}
