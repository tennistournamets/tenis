// Static blog: content/blog/<lang>/<slug>.md -> ready HTML pages in dist/ (no JavaScript needed).
//   lt (default) /blog, /blog/<slug>      ru /ru/blog/...      en /en/blog/...
// Front matter: title, description, key (links translations of one article), date (YYYY-MM-DD).
// Run after `vite build` (see package.json "build"); vercel.json maps the clean URLs to the files.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import { DEFAULT_LOCALE, LOCALES, landingPath } from '../src/lib/localeRoute.js'
import { OG_IMAGE_PATH, SITE_NAME, escapeHtml, jsonLdScript } from '../src/lib/seo.js'

const root = fileURLToPath(new URL('..', import.meta.url))

export const BLOG_LABELS = {
  lt: { blog: 'Straipsniai', blogIntro: 'Patarimai, kaip surengti teniso, padelio ir futbolo turnyrus.', cta: 'Sukurti turnyrą nemokamai', ctaText: 'Registracija, tinklelis ir rezultatai tiesiogiai vienoje vietoje. Dalyviams paskyros nereikia.', more: 'Kiti straipsniai', read: 'Skaityti', home: 'Pradžia' },
  ru: { blog: 'Статьи', blogIntro: 'Советы, как провести турнир по теннису, паделу и футболу.', cta: 'Создать турнир бесплатно', ctaText: 'Регистрация, сетка и live-счёт в одном месте. Участникам не нужен аккаунт.', more: 'Другие статьи', read: 'Читать', home: 'Главная' },
  en: { blog: 'Guides', blogIntro: 'Practical advice on running tennis, padel and football tournaments.', cta: 'Create a tournament for free', ctaText: 'Registration, brackets and live scores in one place. Players need no account.', more: 'More guides', read: 'Read', home: 'Home' },
}

const INTL = { ru: 'ru-RU', en: 'en-GB', lt: 'lt-LT' }
const OG_LOCALE = { ru: 'ru_RU', en: 'en_US', lt: 'lt_LT' }

export function blogPath(locale, slug = '') {
  const base = locale === DEFAULT_LOCALE ? '/blog' : `/${locale}/blog`
  return slug ? `${base}/${slug}` : base
}

/** Minimal front matter: `key: value` lines between two `---` lines. */
export function parseArticle(source, { lang, slug }) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'))
  if (!match) throw new Error(`${lang}/${slug}: missing front matter`)
  const meta = Object.fromEntries(match[1].split('\n').filter(Boolean).map(line => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
  }))
  for (const field of ['title', 'description', 'key', 'date']) {
    if (!meta[field]) throw new Error(`${lang}/${slug}: front matter needs "${field}"`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Error(`${lang}/${slug}: date must be YYYY-MM-DD`)
  return { ...meta, lang, slug, path: blogPath(lang, slug), html: marked.parse(match[2], { async: false }) }
}

export function loadArticles(dir = join(root, 'content/blog')) {
  const articles = []
  for (const lang of LOCALES) {
    let files = []
    try { files = readdirSync(join(dir, lang)).filter(file => file.endsWith('.md')) } catch { continue }
    for (const file of files) {
      const slug = file.replace(/\.md$/, '')
      if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`${lang}/${file}: slug must be lowercase latin letters, digits and dashes`)
      articles.push(parseArticle(readFileSync(join(dir, lang, file), 'utf8'), { lang, slug }))
    }
  }
  return articles.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title))
}

function formatDate(date, lang) {
  return new Intl.DateTimeFormat(INTL[lang], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
}

const STYLE = `
:root { color-scheme: light; --bg: #F7F7F4; --surface: #FFFFFF; --text: #14201B; --muted: #5E6B64; --border: #E4E7E2; --primary: #0F7B4D; --primary-soft: #E7F4EC; --lime: #C6F24E; }
:root[data-theme="dark"] { color-scheme: dark; --bg: #101512; --surface: #171E1A; --text: #EEF2EE; --muted: #A3B0A8; --border: #28332D; --primary: #3DBE82; --primary-soft: #16281F; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.7 'Golos Text', system-ui, sans-serif; }
a { color: var(--primary); }
.wrap { max-width: 760px; margin: 0 auto; padding: 0 20px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 0; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; font: 800 1.25rem 'Onest', system-ui, sans-serif; letter-spacing: -0.02em; }
.top nav { display: flex; align-items: center; gap: 16px; font-size: .95rem; }
.top nav a { color: var(--muted); text-decoration: none; }
.btn { display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; border-radius: 12px; background: var(--primary); color: #fff !important; font-weight: 600; text-decoration: none; }
.crumbs { margin: 16px 0 0; font-size: .875rem; color: var(--muted); }
.crumbs a { color: var(--muted); }
h1, h2, h3 { font-family: 'Onest', system-ui, sans-serif; line-height: 1.2; letter-spacing: -0.02em; }
h1 { font-size: clamp(1.9rem, 5vw, 2.6rem); margin: 12px 0 8px; }
h2 { font-size: 1.45rem; margin: 2em 0 .5em; }
.meta { color: var(--muted); font-size: .9rem; margin: 0 0 24px; }
article img { max-width: 100%; }
table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: .95rem; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
.cta { margin: 40px 0; padding: 24px; border-radius: 16px; background: var(--primary-soft); border: 1px solid var(--border); }
.cta h2 { margin: 0 0 8px; font-size: 1.25rem; }
.cta p { margin: 0 0 16px; color: var(--muted); }
.cards { display: grid; gap: 14px; padding: 0; list-style: none; }
.cards li { padding: 18px 20px; border-radius: 16px; background: var(--surface); border: 1px solid var(--border); }
.cards a { color: var(--text); text-decoration: none; font: 700 1.15rem/1.3 'Onest', system-ui, sans-serif; }
.cards p { margin: 6px 0 0; color: var(--muted); font-size: .95rem; }
footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; margin-top: 48px; padding: 24px 0 40px; border-top: 1px solid var(--border); color: var(--muted); font-size: .875rem; }
footer nav { display: flex; gap: 14px; }
footer a { color: var(--muted); }
footer a[aria-current] { color: var(--text); font-weight: 600; }
`

const LOGO = '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect width="28" height="28" rx="8" fill="#0F7B4D"/><path d="M11 8H9.5A1.5 1.5 0 0 0 8 9.5v9A1.5 1.5 0 0 0 9.5 20H11" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M17 8h1.5A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5H17" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="14" r="2.2" fill="#C6F24E"/></svg>'
const LANGUAGE_NAMES = { lt: 'Lietuvių', en: 'English', ru: 'Русский' }

// Same theme rule as index.html: saved choice, else the system setting.
const THEME_SCRIPT = `<script>(function(){var t;try{t=localStorage.getItem('champ_theme')}catch(e){}if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t})()</script>`

function analyticsTag(env) {
  const id = String(env.VITE_UMAMI_WEBSITE_ID ?? '').trim()
  if (!id) return ''
  const src = String(env.VITE_UMAMI_SCRIPT_URL ?? '').trim() || 'https://cloud.umami.is/script.js'
  const domains = String(env.VITE_UMAMI_DOMAINS ?? '').trim()
  return `<script defer src="${escapeHtml(src)}" data-website-id="${escapeHtml(id)}"${domains ? ` data-domains="${escapeHtml(domains)}"` : ''}></script>`
}

function page({ lang, origin, title, description, path, type, alternates, jsonLd, body, env }) {
  const e = escapeHtml
  const url = `${origin}${path}`
  const hreflang = Object.entries(alternates)
    .map(([code, href]) => `<link rel="alternate" hreflang="${code}" href="${e(`${origin}${href}`)}">`)
  if (alternates[DEFAULT_LOCALE]) hreflang.push(`<link rel="alternate" hreflang="x-default" href="${e(`${origin}${alternates[DEFAULT_LOCALE]}`)}">`)
  const labels = BLOG_LABELS[lang]
  const langLinks = LOCALES.filter(code => alternates[code] || code === lang)
    .map(code => `<a href="${e(alternates[code] ?? blogPath(code))}" hreflang="${code}" lang="${code}"${code === lang ? ' aria-current="page"' : ''}>${LANGUAGE_NAMES[code]}</a>`)
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<link rel="canonical" href="${e(url)}">
${hreflang.join('\n')}
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="${OG_LOCALE[lang]}">
<meta property="og:url" content="${e(url)}">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:image" content="${e(`${origin}${OG_IMAGE_PATH}`)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@700;800&family=Golos+Text:wght@400;600&display=swap">
${THEME_SCRIPT}
<style>${STYLE}</style>
${jsonLdScript(jsonLd)}
${analyticsTag(env)}
</head>
<body>
<div class="wrap">
<header class="top">
<a class="brand" href="${landingPath(lang)}">${LOGO}${SITE_NAME}</a>
<nav><a href="${blogPath(lang)}">${e(labels.blog)}</a><a class="btn" href="${landingPath(lang)}?utm_source=blog&amp;utm_medium=header">${e(labels.cta)}</a></nav>
</header>
${body}
<footer><span>© ${new Date().getUTCFullYear()} ${SITE_NAME}</span><nav aria-label="Language / Язык / Kalba">${langLinks.join('')}</nav></footer>
</div>
</body>
</html>
`
}

function ctaBlock(lang, campaign) {
  const labels = BLOG_LABELS[lang]
  return `<aside class="cta"><h2>${escapeHtml(labels.cta)}</h2><p>${escapeHtml(labels.ctaText)}</p><a class="btn" href="${landingPath(lang)}?utm_source=blog&amp;utm_medium=article&amp;utm_campaign=${encodeURIComponent(campaign)}">${escapeHtml(labels.cta)} →</a></aside>`
}

function cards(list, lang) {
  const labels = BLOG_LABELS[lang]
  return `<ul class="cards">${list.map(item => `<li><a href="${item.path}">${escapeHtml(item.title)}</a><p>${escapeHtml(item.description)}</p><p><a href="${item.path}" aria-label="${escapeHtml(`${labels.read}: ${item.title}`)}" style="font:600 .9rem 'Golos Text',sans-serif;color:var(--primary)">${escapeHtml(labels.read)} →</a></p></li>`).join('')}</ul>`
}

export function articleHtml(article, articles, { origin = '', env = {} } = {}) {
  const labels = BLOG_LABELS[article.lang]
  const alternates = Object.fromEntries(articles.filter(a => a.key === article.key).map(a => [a.lang, a.path]))
  const related = articles.filter(a => a.lang === article.lang && a.key !== article.key).slice(0, 3)
  const url = `${origin}${article.path}`
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: article.title,
        description: article.description,
        datePublished: article.date,
        dateModified: article.updated || article.date,
        inLanguage: article.lang,
        mainEntityOfPage: url,
        url,
        image: `${origin}${OG_IMAGE_PATH}`,
        author: { '@type': 'Organization', name: SITE_NAME, url: `${origin}/` },
        publisher: { '@type': 'Organization', name: SITE_NAME, logo: { '@type': 'ImageObject', url: `${origin}/icon-512.png` } },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${origin}${landingPath(article.lang)}` },
          { '@type': 'ListItem', position: 2, name: labels.blog, item: `${origin}${blogPath(article.lang)}` },
          { '@type': 'ListItem', position: 3, name: article.title, item: url },
        ],
      },
    ],
  }
  const body = `<p class="crumbs"><a href="${landingPath(article.lang)}">${escapeHtml(labels.home)}</a> › <a href="${blogPath(article.lang)}">${escapeHtml(labels.blog)}</a></p>
<article>
<h1>${escapeHtml(article.title)}</h1>
<p class="meta"><time datetime="${article.date}">${formatDate(article.date, article.lang)}</time></p>
${article.html}
</article>
${ctaBlock(article.lang, article.key)}
${related.length ? `<h2>${escapeHtml(labels.more)}</h2>${cards(related, article.lang)}` : ''}`
  return page({
    lang: article.lang, origin, env, type: 'article', path: article.path, alternates, jsonLd, body,
    title: `${article.title} — ${SITE_NAME}`, description: article.description,
  })
}

export function indexHtml(lang, articles, { origin = '', env = {} } = {}) {
  const labels = BLOG_LABELS[lang]
  const list = articles.filter(a => a.lang === lang)
  const alternates = Object.fromEntries(LOCALES.filter(code => articles.some(a => a.lang === code)).map(code => [code, blogPath(code)]))
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: `${labels.blog} — ${SITE_NAME}`,
    description: labels.blogIntro,
    url: `${origin}${blogPath(lang)}`,
    inLanguage: lang,
    blogPost: list.map(a => ({ '@type': 'BlogPosting', headline: a.title, url: `${origin}${a.path}`, datePublished: a.date })),
  }
  const body = `<h1>${escapeHtml(labels.blog)}</h1>
<p class="meta">${escapeHtml(labels.blogIntro)}</p>
${cards(list, lang)}
${ctaBlock(lang, 'blog_index')}`
  return page({ lang, origin, env, type: 'website', path: blogPath(lang), alternates, jsonLd, body, title: `${labels.blog} — ${SITE_NAME}`, description: labels.blogIntro })
}

export function blogSitemap(articles, origin = '') {
  const e = escapeHtml
  const entry = (path, alternates, lastmod) => {
    const links = Object.entries(alternates).map(([code, href]) => `<xhtml:link rel="alternate" hreflang="${code}" href="${e(`${origin}${href}`)}"/>`).join('')
    return `  <url><loc>${e(`${origin}${path}`)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}${links}</url>`
  }
  const langs = LOCALES.filter(code => articles.some(a => a.lang === code))
  const indexAlternates = Object.fromEntries(langs.map(code => [code, blogPath(code)]))
  const urls = [
    ...langs.map(code => entry(blogPath(code), indexAlternates)),
    ...articles.map(a => entry(a.path, Object.fromEntries(articles.filter(x => x.key === a.key).map(x => [x.lang, x.path])), a.updated || a.date)),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`
}

/** Writes every blog page and blog/sitemap.xml into dist; returns the written paths. */
export function writeBlog(dist, { origin = '', env = {}, articles = loadArticles() } = {}) {
  const written = []
  const write = (path, html) => {
    const file = join(dist, `${path}.html`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, html)
    written.push(path)
  }
  for (const lang of LOCALES) {
    if (!articles.some(a => a.lang === lang)) continue
    write(`${blogPath(lang)}/index`, indexHtml(lang, articles, { origin, env }))
  }
  for (const article of articles) write(article.path, articleHtml(article, articles, { origin, env }))
  mkdirSync(join(dist, 'blog'), { recursive: true })
  writeFileSync(join(dist, 'blog/sitemap.xml'), blogSitemap(articles, origin))
  return written
}
