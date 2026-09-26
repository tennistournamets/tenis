// OAuth callback parameters that Supabase returns in the URL. The implicit flow puts
// tokens in the hash; the PKCE flow and redirect errors use the query string.
export const AUTH_HASH_PARAMS = [
  'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token',
  'expires_in', 'expires_at', 'token_type', 'type',
  'error', 'error_code', 'error_description',
]
export const AUTH_QUERY_PARAMS = ['code', 'sb_flow_id', 'error', 'error_code', 'error_description']

const MARKERS = ['access_token', 'refresh_token', 'provider_token', 'error_description', 'error_code']

// True when a route hash ("#access_token=...") carries an auth callback.
export function hasAuthCallbackHash(hash) {
  const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''))
  return MARKERS.some((key) => params.has(key))
}

// The app never uses `code`/`error_*` query keys itself, so their presence means a
// PKCE callback or an OAuth redirect error.
function hasAuthCallbackQuery(query) {
  if (!query) return false
  return ['code', 'sb_flow_id', 'error_code', 'error_description'].some((key) => key in query)
}

// Returns the hash without auth parameters ('' when nothing else is left).
export function stripAuthHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '')
  if (!raw) return ''
  const params = new URLSearchParams(raw)
  if (!MARKERS.some((key) => params.has(key))) return hash
  for (const key of AUTH_HASH_PARAMS) params.delete(key)
  const rest = params.toString()
  return rest ? `#${rest}` : ''
}

function stripAuthQuery(query) {
  const clean = { ...(query ?? {}) }
  for (const key of AUTH_QUERY_PARAMS) delete clean[key]
  return clean
}

/**
 * Router guard helper: vue-router copies the hash and query of the landing URL through
 * `redirect` records (/admin -> /admin/tournaments), so it writes the OAuth tokens back
 * into the address bar after supabase-js has already cleared them. Call this only after
 * the auth client has finished reading the URL; it returns a cleaned replacement
 * location, or null when the route carries no callback parameters.
 */
export function authCallbackCleanupLocation(to) {
  const dirtyHash = hasAuthCallbackHash(to?.hash)
  const dirtyQuery = hasAuthCallbackQuery(to?.query)
  if (!dirtyHash && !dirtyQuery) return null
  return {
    path: to.path,
    query: dirtyQuery ? stripAuthQuery(to.query) : to.query,
    hash: dirtyHash ? stripAuthHash(to.hash) : to.hash,
    replace: true,
  }
}

// Last line of defence for the real address bar (e.g. a navigation that was aborted).
export function scrubAuthCallbackFromLocation(win = globalThis.window) {
  if (!win?.location || !win.history?.replaceState) return false
  const url = new URL(win.location.href)
  const dirtyHash = hasAuthCallbackHash(url.hash)
  const query = Object.fromEntries(url.searchParams.entries())
  const dirtyQuery = hasAuthCallbackQuery(query)
  if (!dirtyHash && !dirtyQuery && url.hash !== '#') return false
  if (dirtyHash || url.hash === '#') url.hash = dirtyHash ? stripAuthHash(url.hash) : ''
  if (dirtyQuery) for (const key of AUTH_QUERY_PARAMS) url.searchParams.delete(key)
  win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash)
  return true
}
