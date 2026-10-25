// Calls the server AI function (api/ai.js) as the signed-in organizer. Errors carry a code
// (`ai.limit`, `ai.disabled`, ...) that errorMessage() translates through src/i18n/ai.js.
import { supabase } from './supabase'
import { TEXT_MAX } from './aiFileText'

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
      // Longer text is cut here, as the field warns (the server refuses it whole).
      body: JSON.stringify({ task, input: String(input).slice(0, TEXT_MAX), context }),
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
