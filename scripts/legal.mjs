// Static legal pages: content/legal/<lang>/<doc>.md -> dist/<path>.html, same template as the blog.
//   lt (default) /privacy, /terms      ru /ru/privacy, /ru/terms      en /en/privacy, /en/terms
// Front matter: title, description, updated (YYYY-MM-DD). Every document exists in every language.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import { LEGAL_DOCS, LOCALES, landingPath, legalPath } from '../src/lib/localeRoute.js'
import { SITE_NAME, escapeHtml } from '../src/lib/seo.js'
import { BLOG_LABELS, formatDate, page } from './blog.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

export function parseLegal(source, { lang, doc }) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'))
  if (!match) throw new Error(`legal ${lang}/${doc}: missing front matter`)
  const meta = Object.fromEntries(match[1].split('\n').filter(Boolean).map(line => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
  }))
  for (const field of ['title', 'description', 'updated']) {
    if (!meta[field]) throw new Error(`legal ${lang}/${doc}: front matter needs "${field}"`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.updated)) throw new Error(`legal ${lang}/${doc}: updated must be YYYY-MM-DD`)
  return { ...meta, lang, doc, path: legalPath(lang, doc), html: marked.parse(match[2], { async: false }) }
}

export function loadLegal(dir = join(root, 'content/legal')) {
  return LOCALES.flatMap(lang => LEGAL_DOCS.map(doc => parseLegal(readFileSync(join(dir, lang, `${doc}.md`), 'utf8'), { lang, doc })))
}

export function legalHtml(item, { origin = '', env = {} } = {}) {
  const labels = BLOG_LABELS[item.lang]
  const alternates = Object.fromEntries(LOCALES.map(code => [code, legalPath(code, item.doc)]))
  const url = `${origin}${item.path}`
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: item.title,
    description: item.description,
    url,
    inLanguage: item.lang,
    dateModified: item.updated,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${origin}/` },
  }
  const body = `<p class="crumbs"><a href="${landingPath(item.lang)}">${escapeHtml(labels.home)}</a></p>
<article>
<h1>${escapeHtml(item.title)}</h1>
<p class="meta">${escapeHtml(labels.updated)}: <time datetime="${item.updated}">${formatDate(item.updated, item.lang)}</time></p>
${item.html}
</article>`
  return page({
    lang: item.lang, origin, env, type: 'website', path: item.path, alternates, jsonLd, body,
    title: `${item.title} — ${SITE_NAME}`, description: item.description,
  })
}

/** Writes every legal page into dist; returns the written paths. */
export function writeLegal(dist, { origin = '', env = {}, items = loadLegal() } = {}) {
  for (const item of items) {
    const file = join(dist, `${item.path}.html`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, legalHtml(item, { origin, env }))
  }
  return items.map(item => item.path)
}
