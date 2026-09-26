// Post-build step: writes the landing page as ready HTML for each language so crawlers
// that do not run JavaScript (Bing, Yandex, AI assistants) see its text and head tags.
//   dist/index.html  landing, lt (default)      dist/en.html, dist/ru.html  landing, en/ru
//   dist/app.html    empty SPA shell for the app routes listed in vercel.json
//   dist/404.html    the same shell, noindex; Vercel serves it with HTTP 404 for any other path
//   dist/blog/…, dist/ru/blog/…, dist/en/blog/…  static articles from content/blog (scripts/blog.mjs)
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer, loadEnv } from 'vite'
import { installPrerenderGlobals } from './prerender-env.mjs'
import { DEFAULT_LOCALE, LOCALES, landingPath } from '../src/lib/localeRoute.js'
import { landingHead, replaceHeadBlock, shellHead, siteOrigin } from '../src/lib/seo.js'
import { writeBlog } from './blog.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = `${root}dist/`
const supabaseModule = `${root}src/lib/supabase.js`

// The landing never talks to Supabase during render; the stub keeps env vars optional.
const stubSupabase = {
  name: 'prerender-stub-supabase',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!/\/supabase(\.js)?$/.test(source) || !importer) return null
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    return resolved?.id === supabaseModule ? '\0supabase-stub' : null
  },
  load(id) {
    if (id !== '\0supabase-stub') return null
    return `const unavailable = () => { throw new Error('Supabase is not available during prerender') }
export const supabase = new Proxy({}, { get: () => new Proxy(unavailable, { get: () => unavailable }) })`
  },
}

export async function renderLandingPages() {
  installPrerenderGlobals()
  const vite = await createServer({
    root,
    configFile: `${root}vite.config.js`,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    // SSR loading needs no browser dependency pre-bundling.
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [stubSupabase],
  })
  try {
    const { renderLanding } = await vite.ssrLoadModule('/scripts/prerender-entry.js')
    const pages = {}
    for (const locale of LOCALES) pages[locale] = await renderLanding(locale)
    return pages
  } finally {
    await vite.close()
  }
}

/**
 * Stylesheets and JS chunks of HomeView plus the locale's messages chunk, so the ready HTML
 * is styled before the route loads and the app starts without a request waterfall.
 */
export function landingAssets(manifest, locale) {
  const key = Object.keys(manifest).find(name => name.endsWith('src/views/HomeView.vue'))
  if (!key) throw new Error('HomeView is missing from the Vite manifest')
  const css = new Set()
  const js = new Set()
  const visit = (name, seen = new Set()) => {
    if (seen.has(name) || !manifest[name]) return
    seen.add(name)
    const chunk = manifest[name]
    // The entry's own CSS and JS are already in index.html.
    if (!chunk.isEntry) {
      for (const file of chunk.css ?? []) css.add(file)
      js.add(chunk.file)
    }
    for (const next of chunk.imports ?? []) visit(next, seen)
  }
  visit(key)
  const messages = manifest[`virtual:bracketa-locale/${locale}`]
  if (!messages) throw new Error(`Locale chunk for ${locale} is missing from the Vite manifest`)
  js.add(messages.file)
  return [
    ...[...css].map(file => `<link rel="stylesheet" href="/${file}">`),
    ...[...js].map(file => `<link rel="modulepreload" crossorigin href="/${file}">`),
  ].join('\n    ')
}

export function landingDocument(template, { locale, origin, appHtml, assets }) {
  const withHead = replaceHeadBlock(template, `${landingHead(locale, origin)}\n    ${assets}`)
  return withHead
    .replace(/<html lang="[^"]*"/, `<html lang="${locale}"`)
    .replace('<div id="app"></div>', `<div id="app">${appHtml}</div>`)
}

async function main() {
  const env = loadEnv('production', root, ['SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VITE_UMAMI_'])
  const origin = siteOrigin({ ...process.env, ...env })
  const template = readFileSync(`${dist}index.html`, 'utf8')
  if (!template.includes('<div id="app"></div>')) throw new Error('dist/index.html is already prerendered; run vite build first')
  const manifestPath = `${dist}.vite/manifest.json`
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const pages = await renderLandingPages()

  writeFileSync(`${dist}app.html`, replaceHeadBlock(template, shellHead(origin)))
  writeFileSync(`${dist}404.html`, replaceHeadBlock(template, `${shellHead(origin)}\n    <meta name="robots" content="noindex">`))
  for (const locale of LOCALES) {
    const file = locale === DEFAULT_LOCALE ? 'index.html' : `${locale}.html`
    writeFileSync(`${dist}${file}`, landingDocument(template, { locale, origin, appHtml: pages[locale], assets: landingAssets(manifest, locale) }))
    console.log(`prerender: ${landingPath(locale)} -> dist/${file}`)
  }
  const articles = writeBlog(dist, { origin, env: { ...process.env, ...env } })
  console.log(`blog: ${articles.length} pages -> dist/blog, dist/<lang>/blog`)
  // The manifest is a build artifact only; don't publish it.
  rmSync(`${dist}.vite`, { recursive: true, force: true })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
