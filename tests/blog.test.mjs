import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { articleHtml, blogPath, blogSitemap, indexHtml, loadArticles, parseArticle, writeBlog } from '../scripts/blog.mjs'
import { LOCALES } from '../src/lib/localeRoute.js'
import { robotsTxt } from '../src/lib/seo.js'

const articles = loadArticles()

test('every article has valid front matter and exists in every language', () => {
  assert.ok(articles.length >= 9)
  const byKey = Object.groupBy(articles, article => article.key)
  for (const [key, group] of Object.entries(byKey)) {
    assert.deepEqual(group.map(a => a.lang).sort(), [...LOCALES].sort(), `${key} is translated to all languages`)
  }
  for (const article of articles) {
    assert.ok(article.description.length <= 170, `${article.lang}/${article.slug}: description fits a search snippet`)
    assert.ok(article.title.length <= 90, `${article.lang}/${article.slug}: title length`)
    assert.match(article.html, /<h2>/, `${article.lang}/${article.slug}: has sections`)
  }
})

test('blog URLs: Lithuanian at /blog, other languages under their prefix', () => {
  assert.equal(blogPath('lt'), '/blog')
  assert.equal(blogPath('ru', 'x'), '/ru/blog/x')
  assert.equal(blogPath('en', 'x'), '/en/blog/x')
})

test('front matter is required and validated', () => {
  assert.throws(() => parseArticle('no front matter', { lang: 'lt', slug: 'x' }), /front matter/)
  assert.throws(() => parseArticle('---\ntitle: T\n---\nBody', { lang: 'lt', slug: 'x' }), /needs "description"/)
  assert.throws(() => parseArticle('---\ntitle: T\ndescription: D\nkey: k\ndate: 26.09.2026\n---\nBody', { lang: 'lt', slug: 'x' }), /YYYY-MM-DD/)
  const ok = parseArticle('---\ntitle: A: B\ndescription: D\nkey: k\ndate: 2026-09-26\n---\n## Hi\n', { lang: 'ru', slug: 'x' })
  assert.equal(ok.title, 'A: B', 'a colon inside the value is kept')
  assert.equal(ok.path, '/ru/blog/x')
})

test('an article page carries canonical, translations, JSON-LD, the call to action and related guides', () => {
  const article = articles.find(a => a.key === 'bracket-16' && a.lang === 'lt')
  const html = articleHtml(article, articles, { origin: 'https://bracketa.lt' })
  assert.ok(html.includes('<html lang="lt">'))
  assert.ok(html.includes(`<link rel="canonical" href="https://bracketa.lt${article.path}">`))
  for (const lang of ['ru', 'en', 'x-default']) assert.ok(html.includes(`hreflang="${lang}"`), lang)
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1])
  assert.deepEqual(ld['@graph'].map(node => node['@type']), ['BlogPosting', 'BreadcrumbList'])
  assert.equal(ld['@graph'][0].inLanguage, 'lt')
  assert.ok(html.includes('utm_source=blog&amp;utm_medium=article&amp;utm_campaign=bracket-16'))
  assert.equal((html.match(/<ul class="cards">/g) || []).length, 1, 'related guides')
  assert.ok(!html.includes('<script type="module"'), 'no app bundle on a blog page')
  const withAnalytics = articleHtml(article, articles, { origin: 'https://bracketa.lt', env: { VITE_UMAMI_WEBSITE_ID: 'site-1' } })
  assert.ok(withAnalytics.includes('data-website-id="site-1"'))
})

test('the index lists only its language and the sitemap links every translation', () => {
  const ru = indexHtml('ru', articles, { origin: 'https://bracketa.lt' })
  assert.equal((ru.match(/href="\/ru\/blog\/[a-z0-9-]+"/g) || []).length / 2, articles.filter(a => a.lang === 'ru').length)
  assert.ok(!ru.includes('href="/en/blog/how-to'))
  const xml = blogSitemap(articles, 'https://bracketa.lt')
  assert.equal((xml.match(/<url>/g) || []).length, articles.length + LOCALES.length)
  assert.ok(xml.includes('<loc>https://bracketa.lt/blog/kaip-surengti-padelio-turnyra</loc><lastmod>2026-09-26</lastmod>'))
  assert.match(robotsTxt('https://bracketa.lt'), /Sitemap: https:\/\/bracketa.lt\/blog\/sitemap.xml/)
})

test('writeBlog puts pages where vercel.json looks for them', () => {
  const dist = mkdtempSync(join(tmpdir(), 'blog-'))
  try {
    const written = writeBlog(dist, { origin: 'https://bracketa.lt', articles })
    assert.ok(written.includes('/blog/index'))
    assert.ok(written.includes('/ru/blog/index'))
    assert.match(readFileSync(join(dist, 'blog/kaip-surengti-padelio-turnyra.html'), 'utf8'), /<h1>Kaip surengti padelio turnyrą/)
    assert.match(readFileSync(join(dist, 'en/blog/how-to-run-a-padel-tournament.html'), 'utf8'), /<html lang="en">/)
    assert.match(readFileSync(join(dist, 'blog/sitemap.xml'), 'utf8'), /<urlset/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
