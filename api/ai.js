// AI for organizers (DeepSeek). The browser sends { task, input, context } with the user's
// Supabase access token; switches, rights and the daily limit are checked in the database
// (ai_begin_call) as that user before the model is asked. The key never leaves the server.
// Needs VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and DEEPSEEK_API_KEY.
import { askJson } from './_ai-deepseek.js'
import { AiError } from './_ai-errors.js'
import { userRpc } from './_ai-supabase.js'
import { TASKS } from './_ai-tasks.js'

export const MAX_INPUT = 30000
const MAX_BODY = 120000
const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'DEEPSEEK_API_KEY']

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const fail = (code, status) => json({ error: code }, status)

export function missingConfig(env) {
  return REQUIRED.filter(name => !String(env[name] ?? '').trim())
}

function bearer(request) {
  const match = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') ?? '')
  return match ? match[1] : null
}

async function readBody(request) {
  const text = await request.text()
  if (text.length > MAX_BODY) throw new AiError('ai.tooLong', 413)
  let body
  try { body = JSON.parse(text) } catch { throw new AiError('ai.badRequest', 400) }
  if (!body || typeof body !== 'object' || typeof body.task !== 'string') throw new AiError('ai.badRequest', 400)
  const input = typeof body.input === 'string' ? body.input.trim() : ''
  if (input.length > MAX_INPUT) throw new AiError('ai.tooLong', 413)
  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context) ? body.context : {}
  return { task: body.task, input, context }
}

export async function handleAi(request, { env = process.env, fetchImpl = globalThis.fetch, tasks = TASKS } = {}) {
  if (missingConfig(env).length) return fail('ai.notConfigured', 503)
  const token = bearer(request)
  if (!token) return fail('ai.auth', 401)

  let call = null
  let usage = null
  try {
    const { task: name, input, context } = await readBody(request)
    const task = Object.hasOwn(tasks, name) ? tasks[name] : null
    if (!task) throw new AiError('ai.badTask', 400)
    if (!input && !task.allowEmptyInput) throw new AiError('ai.empty', 400)
    const tournamentId = task.tournament ? String(context.tournamentId ?? '') || null : null

    call = await userRpc({ env, token, fetchImpl, name: 'ai_begin_call', args: { p_task: name, p_tournament_id: tournamentId } })
    const { system, user } = task.prompt({ input, context })
    const answer = await askJson({ env, fetchImpl, system, user, maxTokens: task.maxTokens, temperature: task.temperature })
    usage = answer.usage
    const result = task.check(answer.json, { input, context })
    await finish({ env, token, fetchImpl, call, ok: true, usage })
    return json({ result, remaining: call.remaining ?? null })
  } catch (error) {
    const known = error instanceof AiError
    const code = known ? error.code : 'ai.unavailable'
    if (!known || error.detail) console.error('[ai]', code, known ? error.detail : error)
    if (call) await finish({ env, token, fetchImpl, call, ok: false, usage: usage ?? error.usage, code })
    return fail(code, known ? error.status : 500)
  }
}

async function finish({ env, token, fetchImpl, call, ok, usage, code = null }) {
  await userRpc({
    env, token, fetchImpl, name: 'ai_finish_call',
    args: { p_id: call.id, p_ok: ok, p_tokens_in: usage?.in ?? null, p_tokens_out: usage?.out ?? null, p_error_code: code },
  }).catch(error => console.error('[ai] finish', error?.code ?? error))
}

export async function POST(request) {
  return handleAi(request)
}
