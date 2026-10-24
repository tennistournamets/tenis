// Speech to text with Groq's hosted Whisper (OpenAI-compatible audio API):
// https://console.groq.com/docs/speech-to-text
import { AiError } from './_ai-errors.js'

export const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
export const DEFAULT_WHISPER_MODEL = 'whisper-large-v3-turbo'
const LANGUAGES = ['lt', 'ru', 'en']
// Words Whisper should spell as the app does; a prompt only nudges the spelling.
const VOCABULARY = 'Bracketa, tenisas, padelis, turnyras, kortas, Americano, Mexicano, King of the Court, теннис, падел, турнир, корт, tennis, padel, tournament, court.'

const EXTENSIONS = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' }
export const audioExtension = type => EXTENSIONS[String(type ?? '').split(';')[0].trim().toLowerCase()] ?? null

/** { text, seconds } for one recording; `language` is the UI language, a hint, not a filter. */
export async function transcribe({ env, fetchImpl, audio, type, language, timeoutMs = 30000 }) {
  const extension = audioExtension(type)
  if (!extension) throw new AiError('ai.badRequest', 400)
  const form = new FormData()
  form.append('file', new Blob([audio], { type }), `speech.${extension}`)
  form.append('model', env.GROQ_WHISPER_MODEL || DEFAULT_WHISPER_MODEL)
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0')
  form.append('prompt', VOCABULARY)
  if (LANGUAGES.includes(language)) form.append('language', language)

  let response
  try {
    response = await fetchImpl(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new AiError('ai.timeout', 504)
    throw new AiError('ai.unavailable', 502, String(error?.message ?? error))
  }
  if (!response.ok) {
    const detail = `Groq HTTP ${response.status} ${(await response.text()).slice(0, 200)}`
    if (response.status === 401 || response.status === 403) throw new AiError('ai.notConfigured', 503, detail)
    if (response.status === 413) throw new AiError('ai.tooLong', 413, detail)
    if (response.status === 429) throw new AiError('ai.busy', 503, detail)
    throw new AiError('ai.unavailable', 502, detail)
  }
  const body = await response.json().catch(() => null)
  const text = String(body?.text ?? '').replace(/\s+/g, ' ').trim()
  const seconds = Number.isFinite(Number(body?.duration)) ? Math.ceil(Number(body.duration)) : null
  return { text, seconds }
}
