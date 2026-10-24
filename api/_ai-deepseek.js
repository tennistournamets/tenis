// One chat completion in JSON mode. DeepSeek's API is OpenAI-compatible:
// https://api-docs.deepseek.com/ (JSON mode needs the word "json" in the prompt).
import { AiError } from './_ai-errors.js'

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
export const DEFAULT_MODEL = 'deepseek-chat'

export async function askJson({ env, fetchImpl, system, user, maxTokens = 4000, temperature = 0.2, timeoutMs = 50000 }) {
  let response
  try {
    response = await fetchImpl(DEEPSEEK_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL || DEFAULT_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new AiError('ai.timeout', 504)
    throw new AiError('ai.unavailable', 502, String(error?.message ?? error))
  }

  if (!response.ok) {
    const detail = `DeepSeek HTTP ${response.status} ${(await response.text()).slice(0, 200)}`
    // 401: wrong key, 402: balance is empty. Both are the operator's problem, not the user's.
    if (response.status === 401 || response.status === 402) throw new AiError('ai.notConfigured', 503, detail)
    if (response.status === 429) throw new AiError('ai.busy', 503, detail)
    throw new AiError('ai.unavailable', 502, detail)
  }

  const body = await response.json().catch(() => null)
  const choice = body?.choices?.[0]
  const usage = { in: body?.usage?.prompt_tokens ?? null, out: body?.usage?.completion_tokens ?? null }
  if (choice?.finish_reason === 'length') throw Object.assign(new AiError('ai.tooLong', 422), { usage })
  let json = null
  try { json = JSON.parse(choice?.message?.content ?? '') } catch { json = null }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw Object.assign(new AiError('ai.badResponse', 502), { usage })
  return { json, usage }
}
