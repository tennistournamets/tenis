// Voice input: a short recording (MediaRecorder) turned into text by api/transcribe.js
// (Groq Whisper). Errors carry codes like the other AI calls (`ai.mic`, `ai.noSpeech`, ...).
import { AiCallError } from './ai'
import { supabase } from './supabase'

export const VOICE_MAX_SECONDS = 120
// Speech languages Whisper is asked for (it mistakes Lithuanian for Russian when left to guess).
export const VOICE_LANGUAGES = ['lt', 'ru', 'en']
const LANGUAGE_KEY = 'bracketa:voice-language'

/** The organizer's last speech language, else the interface language. */
export function savedVoiceLanguage(fallback) {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY)
    if (VOICE_LANGUAGES.includes(saved)) return saved
  } catch { /* storage blocked */ }
  return VOICE_LANGUAGES.includes(fallback) ? fallback : 'lt'
}

export function saveVoiceLanguage(language) {
  try { localStorage.setItem(LANGUAGE_KEY, language) } catch { /* storage blocked */ }
}
// Opus in WebM (Chrome, Firefox, Edge), MP4/AAC (Safari); every one is a type Groq reads.
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

export function canRecord() {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'
}

/**
 * Starts recording; `done` resolves with the audio Blob when stop() is called or the time
 * limit ends the recording. cancel() drops it.
 */
export async function startRecording() {
  if (!canRecord()) throw new AiCallError('ai.micUnsupported')
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch {
    throw new AiCallError('ai.mic')
  }
  const type = TYPES.find(candidate => MediaRecorder.isTypeSupported?.(candidate)) ?? ''
  const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined)
  const chunks = []
  let cancelled = false
  recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data) }
  const done = new Promise(resolve => {
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop())
      resolve(cancelled ? null : new Blob(chunks, { type: (recorder.mimeType || type || 'audio/webm').replace(/\s+/g, '') }))
    }
  })
  recorder.start()
  const timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop() }, VOICE_MAX_SECONDS * 1000)
  const finish = () => {
    clearTimeout(timer)
    if (recorder.state !== 'inactive') recorder.stop()
    return done
  }
  return {
    done,
    stop: finish,
    cancel: () => { cancelled = true; return finish() },
  }
}

/** Text of a recording in `language`; `tournamentId` when recorded inside a tournament (score entry). */
export async function transcribeAudio(audio, { language, tournamentId = null, signal } = {}) {
  const { data } = await supabase.auth.getSession()
  const token = data?.session?.access_token
  if (!token) throw new AiCallError('ai.auth')
  const params = new URLSearchParams()
  if (VOICE_LANGUAGES.includes(language)) params.set('lang', language)
  if (tournamentId) params.set('tournament', tournamentId)
  const query = params.size ? `?${params}` : ''
  let response
  try {
    response = await fetch(`/api/transcribe${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': audio.type || 'audio/webm' },
      body: audio,
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw new AiCallError('ai.network')
  }
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || body.error) throw new AiCallError(body?.error || 'ai.unavailable')
  return body.text
}
