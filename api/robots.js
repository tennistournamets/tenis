import { isProductionEnv, robotsTxt, siteOrigin } from '../src/lib/seo.js'

export function GET(request) {
  return new Response(robotsTxt(siteOrigin(process.env, request), { production: isProductionEnv(process.env) }), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=86400',
    },
  })
}
