import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleTranscribe, missingConfig } from '../api/transcribe.js'
import { GROQ_TRANSCRIBE_URL, audioExtension } from '../api/_ai-groq.js'

const env = { VITE_SUPABASE_URL: 'https://ref.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon', GROQ_API_KEY: 'gsk_test' }
const TOURNAMENT = '6f1c2c1e-0000-4000-8000-000000000001'

function services({ beginError = null, groq = { text: ' Šeštadienį padelio turnyras ', duration: 7.2 }, groqStatus = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target === GROQ_TRANSCRIBE_URL) {
      const form = init.body
      calls.push({ target, headers: init.headers, form: Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size }])) })
      if (groqStatus !== 200) return new Response('{"error":{}}', { status: groqStatus })
      return new Response(JSON.stringify(groq))
    }
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ target, headers: init.headers, body })
    if (target.endsWith('/rpc/ai_begin_call')) {
      if (beginError) return new Response(JSON.stringify({ message: beginError }), { status: 400 })
      return new Response(JSON.stringify({ id: 'call-1', remaining: 59 }))
    }
    if (target.endsWith('/rpc/ai_finish_call')) return new Response(null, { status: 204 })
    throw new Error(`unexpected ${target}`)
  }
  return { calls, fetchImpl }
}

const request = ({ query = '?lang=lt', type = 'audio/webm;codecs=opus', bytes = 2000, token = 'user-jwt' } = {}) => new Request(`https://bracketa.test/api/transcribe${query}`, {
  method: 'POST',
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': type },
  body: new Uint8Array(bytes),
})

const run = async (req, options) => {
  const { calls, fetchImpl } = services(options)
  const response = await handleTranscribe(req, { env, fetchImpl })
  return { status: response.status, body: await response.json(), calls }
}
const quiet = async fn => { const e = console.error; console.error = () => {}; try { return await fn() } finally { console.error = e } }

test('speech becomes text after the database allowed the call; seconds go to the journal', async () => {
  const { status, body, calls } = await run(request({ query: `?lang=lt&tournament=${TOURNAMENT}` }))
  assert.equal(status, 200)
  assert.deepEqual(body, { text: 'Šeštadienį padelio turnyras', remaining: 59 })
  const [begin, groq, finish] = calls
  assert.deepEqual(begin.body, { p_task: 'voice', p_tournament_id: TOURNAMENT })
  assert.equal(begin.headers.Authorization, 'Bearer user-jwt')
  assert.equal(groq.headers.Authorization, 'Bearer gsk_test')
  assert.equal(groq.form.model, 'whisper-large-v3-turbo')
  assert.equal(groq.form.language, undefined, 'Whisper detects the language itself')
  assert.deepEqual(groq.form.file, { name: 'speech.webm', type: 'audio/webm;codecs=opus', size: 2000 })
  assert.deepEqual(finish.body, { p_id: 'call-1', p_ok: true, p_tokens_in: 8, p_tokens_out: null, p_error_code: null })
})

test('the wizard records without a tournament', async () => {
  const { calls } = await run(request({ query: '' }))
  assert.deepEqual(calls[0].body, { p_task: 'voice', p_tournament_id: null })
})

test('refusals and bad input never reach Groq', async () => {
  assert.deepEqual(missingConfig({}), ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'GROQ_API_KEY'])
  assert.equal((await run(request({ token: null }))).status, 401)
  for (const [options, req, code] of [
    [{ beginError: 'ai.disabled' }, request(), 'ai.disabled'],
    [{ beginError: 'ai.limit' }, request(), 'ai.limit'],
    [{}, request({ bytes: 0 }), 'ai.empty'],
    [{}, request({ bytes: 4 * 1024 * 1024 + 1 }), 'ai.tooLong'],
    [{}, request({ query: '?tournament=not-a-uuid' }), 'ai.badRequest'],
  ]) {
    const { body, calls } = await run(req, options)
    assert.deepEqual(body, { error: code })
    assert.ok(!calls.some(call => call.target === GROQ_TRANSCRIBE_URL), code)
  }
  const wrongType = await run(request({ type: 'image/png' }))
  assert.deepEqual(wrongType.body, { error: 'ai.badRequest' })
  assert.equal(wrongType.calls.length, 0, 'not even counted against the limit')
})

test('silence and Groq failures are reported and closed in the journal', async () => {
  const silent = await run(request(), { groq: { text: '  ', duration: 3 } })
  assert.deepEqual(silent.body, { error: 'ai.noSpeech' })
  assert.deepEqual(silent.calls.at(-1).body, { p_id: 'call-1', p_ok: false, p_tokens_in: 3, p_tokens_out: null, p_error_code: 'ai.noSpeech' })
  await quiet(async () => {
    assert.deepEqual((await run(request(), { groqStatus: 401 })).body, { error: 'ai.notConfigured' })
    assert.deepEqual((await run(request(), { groqStatus: 429 })).body, { error: 'ai.busy' })
    assert.deepEqual((await run(request(), { groqStatus: 500 })).body, { error: 'ai.unavailable' })
  })
})

test('browser recording types map to file names Groq accepts', () => {
  assert.equal(audioExtension('audio/webm;codecs=opus'), 'webm')
  assert.equal(audioExtension('audio/mp4'), 'm4a')
  assert.equal(audioExtension('audio/ogg; codecs=opus'), 'ogg')
  assert.equal(audioExtension('video/webm'), null)
})
