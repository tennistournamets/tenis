// YouTube broadcast link of a match (matches.stream_url, set via set_match_stream).
// The pattern mirrors matches_stream_url_ck / set_match_stream in the schema.
export const STREAM_URL_PATTERN = /^https:\/\/(((www|m)\.)?youtube\.com|youtu\.be)\/[^\s]+$/
export const STREAM_URL_MAX = 500

// What the organizer pasted -> the link the server accepts: '' clears it,
// null means it is not a YouTube link. A missing or http scheme becomes https.
export function normalizeStreamUrl(input) {
  const value = String(input ?? '').trim()
  if (!value) return ''
  const withScheme = /^https?:\/\//i.test(value) ? value.replace(/^http:/i, 'https:') : `https://${value}`
  const url = withScheme.replace(/^https:\/\/([^/?#]+)/i, (_, host) => `https://${host.toLowerCase()}`)
  return url.length <= STREAM_URL_MAX && STREAM_URL_PATTERN.test(url) ? url : null
}

// Only a stored link that still matches the pattern is ever rendered as a link.
export function matchStreamUrl(match) {
  const url = match?.stream_url
  return typeof url === 'string' && STREAM_URL_PATTERN.test(url) ? url : ''
}

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/
const EMBED_ORIGIN = 'https://www.youtube-nocookie.com/embed/'

// The player URL for the phone split view, or '' when the link names no video
// (e.g. youtube.com/@club/live): such a link only opens YouTube itself.
export function youtubeEmbedUrl(input) {
  const link = typeof input === 'string' && STREAM_URL_PATTERN.test(input) ? input : ''
  if (!link) return ''
  let url
  try { url = new URL(link) } catch { return '' }
  const parts = url.pathname.split('/').filter(Boolean)
  let id = ''
  if (url.hostname === 'youtu.be') id = parts[0] || ''
  else if (parts[0] === 'watch') id = url.searchParams.get('v') || ''
  else if (['live', 'embed', 'shorts', 'v'].includes(parts[0])) id = parts[1] || ''
  else if (parts[0] === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || '') && parts[2] === 'live') {
    return `${EMBED_ORIGIN}live_stream?channel=${parts[1]}&autoplay=1&playsinline=1`
  }
  return VIDEO_ID.test(id) ? `${EMBED_ORIGIN}${id}?autoplay=1&playsinline=1&rel=0` : ''
}

// Phones (portrait, or landscape with a short screen) watch inside the page,
// the score above the player; wider screens open YouTube in a new tab.
export const STREAM_SPLIT_QUERY = '(max-width: 720px), (pointer: coarse) and (max-height: 520px)'
