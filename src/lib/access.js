// Access helpers: visibility modes, role capabilities shown to organizers and
// error codes raised by the admin-management RPCs.
import { scheduleError } from './schedule.js'

export const VISIBILITY_MODES = ['public', 'link', 'private', 'password']
/** Modes a brand-new tournament can start in; a password is set afterwards in the settings. */
export const CREATE_VISIBILITY_MODES = ['public', 'link', 'private']
export const ROLES = ['owner', 'editor', 'counter']

/** Mode of a tournament row; older rows without the column fall back to is_public. */
export function visibilityOf(tournament) {
  if (VISIBILITY_MODES.includes(tournament?.visibility)) return tournament.visibility
  return tournament?.is_public === false ? 'private' : 'link'
}

export function accessError(message, t, fallbackKey = 'errors.generic') {
  if (typeof message === 'string' && message.startsWith('access.')) return t(`access.errors.${message.slice('access.'.length)}`)
  return scheduleError(message, t, fallbackKey)
}

/** What each role may do; the server enforces the same split (is_tournament_admin vs can_live_score). */
export const ROLE_MATRIX = [
  { key: 'settings', owner: true, editor: true, counter: false },
  { key: 'entries', owner: true, editor: true, counter: false },
  { key: 'bracket', owner: true, editor: true, counter: false },
  { key: 'schedule', owner: true, editor: true, counter: false },
  { key: 'live', owner: true, editor: true, counter: true },
  { key: 'results', owner: true, editor: true, counter: true },
  { key: 'admins', owner: true, editor: true, counter: false },
  { key: 'owners', owner: true, editor: false, counter: false },
  { key: 'delete', owner: true, editor: false, counter: false },
]

/** Roles the current user may assign to someone else. */
export function assignableRoles(currentRole) {
  if (currentRole === 'owner') return ROLES
  if (currentRole === 'editor') return ['editor', 'counter']
  return []
}

/** Whether the current user may change or remove a membership with `targetRole`. */
export function canEditMembership(currentRole, targetRole) {
  if (currentRole === 'owner') return true
  return currentRole === 'editor' && targetRole !== 'owner'
}

const accessKey = slug => `champ_access_${slug}`

const CLIENT_ID_KEY = 'champ_client_id'

/**
 * Random id of this browser, sent with page-password attempts so the server
 * counts failures per visitor (together with the hashed IP) instead of per
 * page. Without storage a fresh id per call still works: the IP limit applies.
 */
export function browserClientId(storage = globalThis.localStorage, random = () => globalThis.crypto?.randomUUID?.()) {
  try {
    const stored = storage?.getItem(CLIENT_ID_KEY)
    if (stored && /^[A-Za-z0-9-]{8,64}$/.test(stored)) return stored
  } catch { /* storage blocked */ }
  const id = random() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  try { storage?.setItem(CLIENT_ID_KEY, id) } catch { /* private mode or quota */ }
  return id
}

/** Access grant for a password page, kept for this browser tab only. */
export function readAccessToken(slug, storage = globalThis.sessionStorage) {
  try {
    const raw = storage?.getItem(accessKey(slug))
    if (!raw) return null
    const grant = JSON.parse(raw)
    if (!grant?.token || !grant?.tournament_id) return null
    if (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now()) { storage.removeItem(accessKey(slug)); return null }
    return grant
  } catch {
    return null
  }
}

export function storeAccessToken(slug, grant, storage = globalThis.sessionStorage) {
  try { storage?.setItem(accessKey(slug), JSON.stringify({ tournament_id: grant.tournament_id, token: grant.token, expires_at: grant.expires_at })) } catch { /* private mode or quota */ }
}

export function clearAccessToken(slug, storage = globalThis.sessionStorage) {
  try { storage?.removeItem(accessKey(slug)) } catch { /* ignore */ }
}

export const isAccessExpiredError = error => /access\.tokenExpired/.test(String(error?.message || error || ''))

/** Search engines index only explicitly public tournaments. */
export function setRobotsMeta(indexable, documentTarget = globalThis.document) {
  if (!documentTarget?.head) return
  let meta = documentTarget.head.querySelector('meta[name="robots"][data-tournament]')
  if (indexable) {
    meta?.remove()
    return
  }
  if (!meta) {
    meta = documentTarget.createElement('meta')
    meta.setAttribute('name', 'robots')
    meta.setAttribute('data-tournament', '')
    documentTarget.head.appendChild(meta)
  }
  meta.setAttribute('content', 'noindex')
}
