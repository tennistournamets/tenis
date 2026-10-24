// Calls the server AI function (api/ai.js) as the signed-in organizer. Errors carry a code
// (`ai.limit`, `ai.disabled`, ...) that errorMessage() translates through src/i18n/ai.js.
import { supabase } from './supabase'

export class AiCallError extends Error {
  constructor(code) {
    super(code)
    this.name = 'AiCallError'
    this.code = code
  }
}

/** `{ result, remaining }` from the model, checked on the server; throws AiCallError. */
export async function callAi(task, { input = '', context = {}, signal } = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new AiCallError('ai.auth')
  let response
  try {
    response = await fetch('/api/ai', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, input, context }),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new AiCallError('ai.network')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || body.error) throw new AiCallError(body?.error || 'ai.unavailable')
  return body
}
