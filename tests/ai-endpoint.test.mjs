import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleAi, missingConfig } from '../api/ai.js'
import { DEEPSEEK_URL } from '../api/_ai-deepseek.js'
import { AiError } from '../api/_ai-errors.js'

const env = { VITE_SUPABASE_URL: 'https://ref.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon', DEEPSEEK_API_KEY: 'sk-test' }

const echo = {
  tournament: true,
  prompt: ({ input, context }) => ({ system: 'Answer in json.', user: `${context.tournamentId}: ${input}` }),
  check: json => {
    if (!Array.isArray(json.names)) throw new AiError('ai.badResponse')
    return { names: json.names }
  },
}

function services({ begin = { id: 'call-1', remaining: 4 }, beginError = null, deepseek = { names: ['Ona'] }, deepseekStatus = 200, finishReason = 'stop' } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ target, headers: init.headers, body })
    if (target.endsWith('/rpc/ai_begin_call')) {
      if (beginError) return new Response(JSON.stringify({ code: 'P0001', message: beginError }), { status: 400 })
      return new Response(JSON.stringify(begin))
    }
    if (target.endsWith('/rpc/ai_finish_call')) return new Response(null, { status: 204 })
    if (target === DEEPSEEK_URL) {
      if (deepseekStatus !== 200) return new Response('{"error":{"message":"x"}}', { status: deepseekStatus })
      const content = typeof deepseek === 'string' ? deepseek : JSON.stringify(deepseek)
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 120, completion_tokens: 30 } }))
    }
    throw new Error(`unexpected ${target}`)
  }
  return { calls, fetchImpl }
}

const request = (body, token = 'user-jwt') => new Request('https://bracketa.test/api/ai', {
  method: 'POST',
  headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

const run = async (body, options = {}, token) => {
  const { calls, fetchImpl } = services(options)
  const response = await handleAi(request(body, token), { env, fetchImpl, tasks: { echo } })
  return { status: response.status, body: await response.json(), calls }
}

const silenced = async fn => {
  const original = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = original }
}

test('the function refuses without configuration or a signed-in user', async () => {
  assert.deepEqual(missingConfig({}), ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'DEEPSEEK_API_KEY'])
  const response = await handleAi(request({ task: 'echo', input: 'x' }), { env: { ...env, DEEPSEEK_API_KEY: ' ' }, fetchImpl: () => assert.fail('no calls'), tasks: { echo } })
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'ai.notConfigured' })

  const anonymous = await run({ task: 'echo', input: 'x' }, {}, null)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.calls.length, 0)
})

test('a call is checked in the database as the user, then answered from the model and closed in the journal', async () => {
  const { status, body, calls } = await run({ task: 'echo', input: '  Ona, Jonas  ', context: { tournamentId: 't-1' } })
  assert.equal(status, 200)
  assert.deepEqual(body, { result: { names: ['Ona'] }, remaining: 4 })

  const [begin, model, finish] = calls
  assert.equal(begin.target, 'https://ref.supabase.co/rest/v1/rpc/ai_begin_call')
  assert.equal(begin.headers.Authorization, 'Bearer user-jwt', 'RPC runs with the user token, not a service key')
  assert.equal(begin.headers.apikey, 'anon')
  assert.deepEqual(begin.body, { p_task: 'echo', p_tournament_id: 't-1' })

  assert.equal(model.headers.Authorization, 'Bearer sk-test')
  assert.equal(model.body.model, 'deepseek-chat')
  assert.deepEqual(model.body.response_format, { type: 'json_object' })
  assert.equal(model.body.messages[1].content, 't-1: Ona, Jonas', 'input is trimmed')

  assert.deepEqual(finish.body, { p_id: 'call-1', p_ok: true, p_tokens_in: 120, p_tokens_out: 30, p_error_code: null })
})

test('database refusals are passed through as codes and the model is never asked', async () => {
  for (const [code, httpStatus] of [['ai.disabled', 403], ['ai.forbidden', 403], ['ai.limit', 429]]) {
    const { status, body, calls } = await run({ task: 'echo', input: 'x', context: { tournamentId: 't' } }, { beginError: code })
    assert.equal(status, httpStatus, code)
    assert.deepEqual(body, { error: code })
    assert.ok(!calls.some(call => call.target === DEEPSEEK_URL))
  }
})

test('bad requests and bad answers are reported, and a failed call is closed with its code', async () => {
  assert.deepEqual((await run('not json')).body, { error: 'ai.badRequest' })
  assert.deepEqual((await run({ task: 'translate', input: 'x' })).body, { error: 'ai.badTask' })
  assert.deepEqual((await run({ task: 'echo', input: '   ' })).body, { error: 'ai.empty' })
  assert.equal((await run({ task: 'echo', input: 'x'.repeat(30001) })).status, 413)

  const garbage = await run({ task: 'echo', input: 'x', context: { tournamentId: 't' } }, { deepseek: 'Sure! Here is the list:' })
  assert.deepEqual(garbage.body, { error: 'ai.badResponse' })
  assert.deepEqual(garbage.calls.at(-1).body, { p_id: 'call-1', p_ok: false, p_tokens_in: 120, p_tokens_out: 30, p_error_code: 'ai.badResponse' })

  const wrongShape = await run({ task: 'echo', input: 'x', context: { tournamentId: 't' } }, { deepseek: { people: [] } })
  assert.deepEqual(wrongShape.body, { error: 'ai.badResponse' })

  const cut = await run({ task: 'echo', input: 'x', context: { tournamentId: 't' } }, { finishReason: 'length' })
  assert.deepEqual(cut.body, { error: 'ai.tooLong' })

  await silenced(async () => {
    const noBalance = await run({ task: 'echo', input: 'x', context: { tournamentId: 't' } }, { deepseekStatus: 402 })
    assert.deepEqual(noBalance.body, { error: 'ai.notConfigured' })
    assert.equal(noBalance.calls.at(-1).body.p_error_code, 'ai.notConfigured')
    assert.deepEqual((await run({ task: 'echo', input: 'x', context: { tournamentId: 't' } }, { deepseekStatus: 429 })).body, { error: 'ai.busy' })
    assert.deepEqual((await run({ task: 'echo', input: 'x', context: { tournamentId: 't' } }, { deepseekStatus: 500 })).body, { error: 'ai.unavailable' })
  })
})
