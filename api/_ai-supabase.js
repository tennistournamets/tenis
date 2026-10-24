// Supabase RPC as the signed-in organizer: the anon key identifies the project, the user's
// access token identifies the caller, so auth.uid() and every policy apply as in the browser.
import { normalizeOrigin } from '../src/lib/seo.js'
import { AiError, DB_CODES } from './_ai-errors.js'

export async function userRpc({ env, token, fetchImpl, name, args }) {
  const response = await fetchImpl(new URL(`/rest/v1/rpc/${name}`, normalizeOrigin(env.VITE_SUPABASE_URL)), {
    method: 'POST',
    headers: {
      apikey: env.VITE_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  if (response.ok) return body
  const message = String(body?.message ?? '')
  if (Object.hasOwn(DB_CODES, message)) throw new AiError(message, DB_CODES[message])
  // An expired or foreign token is rejected by PostgREST before the function runs.
  if (response.status === 401 || /JWT/i.test(message)) throw new AiError('ai.auth', 401)
  throw new AiError('ai.unavailable', 502, `${name}: HTTP ${response.status} ${text.slice(0, 200)}`)
}
