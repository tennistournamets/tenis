// Per-tournament link-preview image. Private/password tournaments (not visible to anon)
// and lookup failures redirect to the static brand image.
import { readFile } from 'node:fs/promises'
import { ImageResponse } from '@vercel/og'
import { fetchPublicTournament, siteOrigin, OG_IMAGE_HEIGHT, OG_IMAGE_PATH, OG_IMAGE_WIDTH } from '../src/lib/seo.js'
import { DEFAULT_LOCALE, isLocale } from '../src/lib/localeRoute.js'
import { tournamentCard } from './_og-card.js'

const fonts = Promise.all([
  readFile(new URL('./_fonts/Onest-600.ttf', import.meta.url)),
  readFile(new URL('./_fonts/Onest-800.ttf', import.meta.url)),
]).then(([semibold, bold]) => [
  { name: 'Onest', data: semibold, weight: 600, style: 'normal' },
  { name: 'Onest', data: bold, weight: 800, style: 'normal' },
])

export async function GET(request) {
  const params = new URL(request.url).searchParams
  const lang = params.get('lang')
  const locale = isLocale(lang) ? lang : DEFAULT_LOCALE
  const row = await fetchPublicTournament(params.get('slug') || '', process.env)
  if (!row) return Response.redirect(`${siteOrigin(process.env, request)}${OG_IMAGE_PATH}`, 302)
  return new ImageResponse(tournamentCard(row, locale), {
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    fonts: await fonts,
    headers: {
      // The URL carries the row version (?v=), so a long edge cache is safe.
      'Cache-Control': 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400',
    },
  })
}
