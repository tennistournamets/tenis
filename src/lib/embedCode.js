// Snippet an organizer pastes into a club website (see public/embed.js). The plain link is part
// of the code on purpose: it stays in the club's HTML, where search engines count it.
import { escapeHtml } from './seo.js'
import { DEFAULT_LOCALE } from './localeRoute.js'

export function embedSnippet({ origin, slug, name, linkText, locale }) {
  const url = `${origin}/tournaments/${encodeURIComponent(slug)}`
  const lang = locale && locale !== DEFAULT_LOCALE ? ` data-lang="${escapeHtml(locale)}"` : ''
  return [
    `<div data-bracketa-tournament="${escapeHtml(slug)}"${lang}><a href="${escapeHtml(url)}">${escapeHtml(linkText || name || 'Bracketa')}</a></div>`,
    `<script src="${escapeHtml(origin)}/embed.js" async></script>`,
  ].join('\n')
}

export function embedPreviewUrl(origin, slug) {
  return `${origin}/embed/${encodeURIComponent(slug)}`
}
