const VERSION = 1

function storage() {
  try { return globalThis.sessionStorage || null }
  catch { return null }
}

export function readSessionDraft(key) {
  const target = storage()
  if (!target || !key) return null
  try {
    const envelope = JSON.parse(target.getItem(key))
    if (!envelope || envelope.version !== VERSION || !envelope.value || typeof envelope.value !== 'object') return null
    return envelope.value
  } catch {
    try { target.removeItem(key) } catch { /* Storage may be unavailable. */ }
    return null
  }
}

export function writeSessionDraft(key, value) {
  const target = storage()
  if (!target || !key) return false
  try {
    target.setItem(key, JSON.stringify({ version: VERSION, value }))
    return true
  } catch { return false }
}

export function clearSessionDraft(key) {
  try { storage()?.removeItem(key) } catch { /* Storage may be unavailable. */ }
}

export function userDraftKey(scope, userId) {
  return userId ? `bracketa:${scope}:${userId}` : ''
}
