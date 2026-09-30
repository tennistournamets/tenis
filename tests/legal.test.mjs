import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { articleHtml, loadArticles } from '../scripts/blog.mjs'
import { legalHtml, loadLegal, parseLegal, writeLegal } from '../scripts/legal.mjs'
import { buildEmail } from '../api/_email.js'
import { LEGAL_DOCS, LOCALES, legalPath } from '../src/lib/localeRoute.js'

const items = loadLegal()
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))

// vercel.json "source" patterns use path-to-regexp; the ones here are plain params with alternations.
function rewrite(path) {
  for (const rule of vercel.rewrites) {
    if (rule.has) continue
    const names = []
    const pattern = rule.source.replace(/:(\w+)(\([^)]*\))?/g, (_, name, group) => { names.push(name); return group ?? '([^/]+)' })
    const match = new RegExp(`^${pattern}$`).exec(path)
    if (!match) continue
    return names.reduce((dest, name, i) => dest.replace(`:${name}`, match[i + 1]), rule.destination)
  }
  return null
}

test('privacy policy and terms exist in every language with the operator and contact', () => {
  assert.equal(items.length, LOCALES.length * LEGAL_DOCS.length)
  for (const item of items) {
    assert.match(item.html, /<h2>/, `${item.lang}/${item.doc}: has sections`)
    assert.ok(item.html.includes('tennis.tournamets@gmail.com'), `${item.lang}/${item.doc}: contact`)
    assert.ok(item.html.includes('Dmitrij Panasiuk'), `${item.lang}/${item.doc}: operator`)
    assert.ok(item.description.length <= 170, `${item.lang}/${item.doc}: description length`)
  }
  for (const item of items.filter(i => i.doc === 'privacy')) {
    assert.ok(item.html.includes('vdai.lrv.lt'), `${item.lang}: supervisory authority`)
  }
})

test('legal URLs follow the language prefix rule and resolve through vercel.json', () => {
  assert.equal(legalPath('lt', 'privacy'), '/privacy')
  assert.equal(legalPath('ru', 'terms'), '/ru/terms')
  assert.equal(legalPath('en', 'privacy'), '/en/privacy')
  for (const item of items) assert.equal(rewrite(item.path), `${item.path}.html`)
  assert.equal(rewrite('/de/privacy'), null)
})

test('front matter is required', () => {
  assert.throws(() => parseLegal('no front matter', { lang: 'lt', doc: 'privacy' }), /front matter/)
  assert.throws(() => parseLegal('---\ntitle: T\ndescription: D\nupdated: 1.10.2026\n---\n## A\n', { lang: 'lt', doc: 'privacy' }), /YYYY-MM-DD/)
})

test('a legal page carries canonical, translations and the update date', () => {
  const ru = items.find(i => i.lang === 'ru' && i.doc === 'privacy')
  const html = legalHtml(ru, { origin: 'https://braketa.top' })
  assert.match(html, /<html lang="ru">/)
  assert.ok(html.includes('<link rel="canonical" href="https://braketa.top/ru/privacy">'))
  assert.ok(html.includes('hreflang="lt" href="https://braketa.top/privacy"'))
  assert.ok(html.includes('hreflang="x-default" href="https://braketa.top/privacy"'))
  assert.ok(html.includes('<time datetime="2026-10-01">'))
})

test('blog pages and participant emails link to the legal pages', () => {
  const articles = loadArticles()
  const lt = articleHtml(articles.find(a => a.lang === 'lt'), articles, { origin: 'https://braketa.top' })
  assert.ok(lt.includes('<a href="/privacy">Privatumo politika</a>'))
  assert.ok(lt.includes('<a href="/terms">Naudojimo sąlygos</a>'))
  const email = buildEmail({ kind: 'registration_received', locale: 'en', entry_name: 'Ann', tournament_name: 'Cup', tournament_slug: 'cup' }, 'https://braketa.top')
  assert.ok(email.html.includes('https://braketa.top/en/privacy'))
  assert.ok(email.text.includes('Privacy policy: https://braketa.top/en/privacy'))
})

test('writeLegal puts pages where vercel.json looks for them', () => {
  const dist = mkdtempSync(join(tmpdir(), 'legal-'))
  try {
    const written = writeLegal(dist, { origin: 'https://braketa.top', items })
    assert.deepEqual(written.sort(), items.map(i => i.path).sort())
    assert.match(readFileSync(join(dist, 'privacy.html'), 'utf8'), /<h1>Privatumo politika<\/h1>/)
    assert.match(readFileSync(join(dist, 'en/terms.html'), 'utf8'), /<h1>Terms of use<\/h1>/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
