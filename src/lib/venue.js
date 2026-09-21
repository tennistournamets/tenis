// The venue of a tournament: a written address plus an optional point, and the
// route links the public page hands to the viewer's navigator.

const COORD = String.raw`(-?\d{1,3}(?:\.\d+)?)`

// The shapes people actually paste: a Google Maps link, an Apple or Yandex
// link, a "geo:" URI, or the two numbers on their own.
const PATTERNS = [
  new RegExp(String.raw`[@!]${COORD}[,!]${COORD}`), //  …/@54.68,25.27  |  …!3d54.68!4d25.27 (handled below too)
  new RegExp(String.raw`[?&](?:q|ll|daddr|destination|sll|center|point)=${COORD}(?:%2C|,)\s*${COORD}`, 'i'),
  new RegExp(String.raw`geo:${COORD},${COORD}`, 'i'),
  new RegExp(String.raw`^\s*${COORD}\s*[,;]\s*${COORD}\s*$`),
]

/** Yandex writes longitude first; its links are recognised separately. */
const YANDEX_LL = new RegExp(String.raw`[?&]ll=${COORD}(?:%2C|,)${COORD}`, 'i')

function point(lat, lng) {
  // Number(null) is 0, which would put an unset venue in the Gulf of Guinea.
  if (lat == null || lng == null || lat === '' || lng === '') return null
  const latitude = Number(lat)
  const longitude = Number(lng)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { lat: Math.round(latitude * 1e6) / 1e6, lng: Math.round(longitude * 1e6) / 1e6 }
}

/**
 * Reads a point out of whatever was pasted: a maps link or a plain "lat, lng".
 * Returns null when nothing usable is there.
 */
export function parseVenuePoint(value) {
  const text = String(value ?? '').trim()
  if (!text) return null

  // Google's "!3d<lat>!4d<lng>" pair is the most precise part of a place link.
  const google3d = text.match(new RegExp(String.raw`!3d${COORD}!4d${COORD}`))
  if (google3d) return point(google3d[1], google3d[2])

  if (/yandex\./i.test(text)) {
    const yandex = text.match(YANDEX_LL)
    if (yandex) return point(yandex[2], yandex[1])
  }

  for (const pattern of PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      const found = point(match[1], match[2])
      if (found) return found
    }
  }
  return null
}

export function formatVenuePoint(venue) {
  const found = point(venue?.lat, venue?.lng)
  return found ? `${found.lat}, ${found.lng}` : ''
}

export function hasVenue(tournament) {
  return Boolean(tournament?.venue_address || (tournament?.venue_lat != null && tournament?.venue_lng != null))
}

/** What the route links aim at: the exact point when there is one, else the address. */
function destination(tournament) {
  const found = point(tournament?.venue_lat, tournament?.venue_lng)
  if (found) return { query: `${found.lat},${found.lng}`, point: found }
  const address = String(tournament?.venue_address ?? '').trim()
  return address ? { query: address, point: null } : null
}

/**
 * Route links for the navigators people have. Google works everywhere and comes
 * first; Apple Maps is offered only where it exists.
 */
export function venueRouteLinks(tournament, { platform = '' } = {}) {
  const target = destination(tournament)
  if (!target) return []
  const q = encodeURIComponent(target.query)
  const links = [
    { id: 'google', url: `https://www.google.com/maps/dir/?api=1&destination=${q}` },
  ]
  if (/mac|iphone|ipad|ipod/i.test(platform)) {
    links.push({ id: 'apple', url: `https://maps.apple.com/?daddr=${q}` })
  }
  links.push({ id: 'yandex', url: target.point
    ? `https://yandex.ru/maps/?rtext=~${target.point.lat},${target.point.lng}&rtt=auto`
    : `https://yandex.ru/maps/?text=${q}` })
  if (target.point) {
    links.push({ id: 'waze', url: `https://waze.com/ul?ll=${target.point.lat},${target.point.lng}&navigate=yes` })
  }
  return links
}

/** A single link for compact places (a card, a list row). */
export function venueRouteUrl(tournament, options = {}) {
  return venueRouteLinks(tournament, options)[0]?.url || ''
}

export function currentPlatform() {
  if (typeof navigator === 'undefined') return ''
  return navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
}
