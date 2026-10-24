// Voice input for organizers: the browser posts a short recording (body = audio, its type in
// Content-Type) with the user's Supabase token; ai_begin_call('voice') checks the switches,
// rights and the daily limit as that user, then Groq Whisper turns speech into text.
// Query: ?lang=lt|ru|en (UI language) and ?tournament=<id> when recorded inside a tournament.
// Needs VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and GROQ_API_KEY.
import { audioExtension, transcribe } from './_ai-groq.js'
import { AiError } from './_ai-errors.js'
import { userRpc } from './_ai-supabase.js'

// Two minutes of Opus speech is about 1 MB; Vercel accepts request bodies up to 4.5 MB.
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024
const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'GROQ_API_KEY']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
const fail = (code, status) => json({ error: code }, status)

export function missingConfig(env) {
  return REQUIRED.filter(name => !String(env[name] ?? '').trim())
}

export async function handleTranscribe(request, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (missingConfig(env).length) return fail('ai.notConfigured', 503)
  const token = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) return fail('ai.auth', 401)

  let call = null
  let seconds = null
  try {
    const url = new URL(request.url)
    const tournament = url.searchParams.get('tournament')
    if (tournament && !UUID.test(tournament)) throw new AiError('ai.badRequest', 400)
    const type = request.headers.get('content-type') ?? ''
    if (!audioExtension(type)) throw new AiError('ai.badRequest', 400)
    const audio = await request.arrayBuffer()
    if (!audio.byteLength) throw new AiError('ai.empty', 400)
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new AiError('ai.tooLong', 413)

    call = await userRpc({ env, token, fetchImpl, name: 'ai_begin_call', args: { p_task: 'voice', p_tournament_id: tournament || null } })
    const result = await transcribe({ env, fetchImpl, audio, type, language: url.searchParams.get('lang') })
    seconds = result.seconds
    if (!result.text) throw new AiError('ai.noSpeech', 422)
    await finish({ env, token, fetchImpl, call, ok: true, seconds })
    return json({ text: result.text, remaining: call.remaining ?? null })
  } catch (error) {
    const known = error instanceof AiError
    const code = known ? error.code : 'ai.unavailable'
    if (!known || error.detail) console.error('[transcribe]', code, known ? error.detail : error)
    if (call) await finish({ env, token, fetchImpl, call, ok: false, seconds, code })
    return fail(code, known ? error.status : 500)
  }
}

// Voice rows keep the seconds of audio in tokens_in.
async function finish({ env, token, fetchImpl, call, ok, seconds, code = null }) {
  await userRpc({
    env, token, fetchImpl, name: 'ai_finish_call',
    args: { p_id: call.id, p_ok: ok, p_tokens_in: seconds, p_tokens_out: null, p_error_code: code },
  }).catch(error => console.error('[transcribe] finish', error?.code ?? error))
}

export async function POST(request) {
  return handleTranscribe(request)
}
