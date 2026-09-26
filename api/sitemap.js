import { fetchSitemapTournaments, sitemapXml, siteOrigin } from '../src/lib/seo.js'

export async function GET(request) {
  const origin = siteOrigin(process.env, request)
  const rows = await fetchSitemapTournaments(process.env)
  return new Response(sitemapXml(origin, rows), {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  })
}
