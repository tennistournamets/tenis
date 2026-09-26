// Product analytics via Umami (cookieless, no consent banner). Off unless
// VITE_UMAMI_WEBSITE_ID is set. Page views are sent by hand, not by Umami's auto-tracking,
// so OAuth callback tokens (hash / ?code=) and other query values never leave the browser:
// only the path, with admin ids collapsed, and utm_* parameters are reported.
// Event data carries no personal fields (names, contacts), only sport/format/step codes.

const DEFAULT_SCRIPT_URL = 'https://cloud.umami.is/script.js'
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
const ID_PARAMS = ['id']

let queue = []
let enabled = false
let firstView = true

function umami(win) {
  return typeof win?.umami?.track === 'function' ? win.umami : null
}

function flush(win) {
  const api = umami(win)
  if (!api) return
  const pending = queue
  queue = []
  for (const send of pending) send(api)
}

function send(action, win = globalThis.window) {
  if (!enabled) return
  // An ad blocker may keep the script from ever loading; don't grow without bound.
  if (queue.length >= 50) queue.shift()
  queue.push(action)
  flush(win)
}

/** Injects the tracker once. Returns false when analytics is not configured. */
export function initAnalytics(env = import.meta.env, doc = globalThis.document, win = globalThis.window) {
  const websiteId = String(env?.VITE_UMAMI_WEBSITE_ID ?? '').trim()
  if (!websiteId || !doc?.head || enabled) return enabled
  const script = doc.createElement('script')
  script.defer = true
  script.src = String(env.VITE_UMAMI_SCRIPT_URL ?? '').trim() || DEFAULT_SCRIPT_URL
  script.dataset.websiteId = websiteId
  script.dataset.autoTrack = 'false'
  const domains = String(env.VITE_UMAMI_DOMAINS ?? '').trim()
  if (domains) script.dataset.domains = domains
  script.addEventListener('load', () => flush(win))
  doc.head.appendChild(script)
  enabled = true
  return true
}

/** Path + utm_* only; admin tournament ids become ":id" so reports group by page. */
export function pageUrl(route) {
  let path = route?.path || '/'
  for (const name of ID_PARAMS) {
    const value = route?.params?.[name]
    if (typeof value === 'string' && value) path = path.split(value).join(`:${name}`)
  }
  const search = new URLSearchParams()
  for (const key of UTM_KEYS) {
    const value = route?.query?.[key]
    if (typeof value === 'string' && value) search.set(key, value.slice(0, 100))
  }
  const query = search.toString()
  return query ? `${path}?${query}` : path
}

/** External referrer without its query (it may carry search terms or tokens). */
export function cleanReferrer(referrer, ownOrigin) {
  try {
    const url = new URL(referrer)
    if (url.origin === ownOrigin) return ''
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

export function trackPageview(route, win = globalThis.window) {
  const url = pageUrl(route)
  const title = String(route?.name ?? '')
  const referrer = firstView ? cleanReferrer(win?.document?.referrer, win?.location?.origin) : ''
  firstView = false
  send(api => api.track(props => ({ ...props, url, title, referrer })), win)
}

/** Custom event, e.g. track('tournament_created', { sport: 'padel' }). */
export function track(name, data, win = globalThis.window) {
  send(api => (data ? api.track(name, data) : api.track(name)), win)
}

// Test hook.
export function resetAnalytics() {
  queue = []
  enabled = false
  firstView = true
}
