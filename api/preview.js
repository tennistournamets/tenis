// Link preview for messengers: vercel.json sends crawler user agents on /tournaments/:slug here.
import { fetchPublicTournament, pickLocale, previewHtml, siteOrigin, tournamentMeta } from '../src/lib/seo.js'

export async function GET(request) {
  const slug = new URL(request.url).searchParams.get('slug') || ''
  const origin = siteOrigin(process.env, request)
  const row = await fetchPublicTournament(slug, process.env)
  const meta = tournamentMeta(row, { locale: pickLocale(request.headers.get('accept-language')), origin, slug })
  return new Response(previewHtml(meta), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Short edge cache: renamed tournaments show up within minutes.
      'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
      Vary: 'Accept-Language',
    },
  })
}
