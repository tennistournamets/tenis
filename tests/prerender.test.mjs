import assert from 'node:assert/strict'
import { test } from 'node:test'
import { landingAssets, landingDocument, renderLandingPages } from '../scripts/prerender.mjs'
import { messages } from './helpers/messages.mjs'

const text = html => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

test('the landing renders to HTML in every language with its own text', { timeout: 60000 }, async () => {
  const pages = await renderLandingPages()
  for (const locale of ['ru', 'en', 'lt']) {
    const body = text(pages[locale])
    const hero = messages[locale].home.cinematic
    assert.ok(body.includes(hero.title), `${locale}: hero title`)
    assert.ok(body.includes(hero.storyTitle.split('\n')[0]), `${locale}: story section`)
    assert.ok(body.includes(messages[locale].home.features.liveScore.title), `${locale}: features`)
    assert.ok(body.split(' ').length > 300, `${locale}: substantial text`)
    for (const href of ['href="/"', 'href="/en"', 'href="/ru"']) assert.ok(pages[locale].includes(href), `${locale}: ${href}`)
  }
  assert.ok(!text(pages.lt).includes(messages.ru.home.cinematic.title))
})

test('ready landing documents carry the language, head tags, styles and markup', () => {
  const manifest = {
    'index.html': { file: 'assets/index-1.js', isEntry: true, css: ['assets/index-1.css'], imports: [] },
    'src/views/HomeView.vue': { file: 'assets/HomeView-2.js', isDynamicEntry: true, css: ['assets/HomeView-2.css'], imports: ['index.html', '_LandingStill-3.js'] },
    '_LandingStill-3.js': { file: 'assets/LandingStill-3.js', css: ['assets/LandingStill-3.css'] },
    'virtual:bracketa-locale/lt': { file: 'assets/lt-4.js', isDynamicEntry: true },
  }
  const assets = landingAssets(manifest, 'lt')
  assert.ok(assets.includes('<link rel="modulepreload" crossorigin href="/assets/lt-4.js">'))
  assert.throws(() => landingAssets(manifest, 'en'), /Locale chunk/)
  assert.ok(assets.includes('<link rel="stylesheet" href="/assets/HomeView-2.css">'))
  assert.ok(assets.includes('<link rel="stylesheet" href="/assets/LandingStill-3.css">'))
  assert.ok(assets.includes('<link rel="modulepreload" crossorigin href="/assets/HomeView-2.js">'))
  assert.ok(!assets.includes('index-1'), 'entry assets are already in the template')
  assert.throws(() => landingAssets({}, 'lt'), /HomeView/)

  const template = '<!doctype html><html lang="ru"><head><!-- seo:start --><title>Bracketa</title><!-- seo:end --></head><body><div id="app"></div></body></html>'
  const html = landingDocument(template, { locale: 'lt', origin: 'https://bracketa.lt', appHtml: '<main>Jūsų turnyras</main>', assets })
  assert.ok(html.includes('<html lang="lt"'))
  assert.ok(html.includes('<link rel="canonical" href="https://bracketa.lt/" data-landing>'), 'Lithuanian lives at the root')
  assert.ok(html.includes('<div id="app"><main>Jūsų turnyras</main></div>'))
  assert.ok(html.includes('HomeView-2.css'))
  assert.equal(html.match(/<title>/g).length, 1)
})
