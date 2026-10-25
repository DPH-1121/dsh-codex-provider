// End-to-end adapter test: a stub backend replays real Responses SSE frames,
// and the adapter must produce a well-formed harness chunk stream.
//
// The frames below are trimmed copies of what the live Codex backend emits, so
// this test exercises the real wire shape without needing a subscription.
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { CodexAdapter, PROVIDER_ID } from '../lib/adapter.js'
import { codexRequest } from '../lib/transport.js'
import { Config } from '../lib/config.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

const CATALOG = JSON.stringify({
  models: [
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      context_window: 272000,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }],
    },
  ],
})

/** SSE frames for a plain text answer. */
const TEXT_TURN = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello' },
  { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: ' world' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } } } },
]

/** SSE frames for a tool-calling turn with a reasoning summary. */
const TOOL_TURN = [
  { type: 'response.created', response: { id: 'resp_2', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'I should read the file.' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'I should read the file.' }] } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read', arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path"' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: ':"a.txt"}' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read', arguments: '{"path":"a.txt"}' } },
  { type: 'response.completed', response: { id: 'resp_2', status: 'completed', usage: { input_tokens: 20, output_tokens: 9 } } },
]

/**
 * Start a stub backend.
 * @param routes - map of path to a handler.
 * @returns base URL, captured requests, and a stop function.
 */
async function stub(routes) {
  const captured = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      captured.push({ method: req.method, url: req.url, headers: req.headers, body })
      const handler = routes[req.url.split('?')[0]]
      if (handler === undefined) {
        res.writeHead(404).end('{}')
        return
      }
      handler(req, res, body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}`,
    captured,
    stop: () => new Promise((r) => server.close(r)),
  }
}

/** Send an SSE event list. */
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end()
}

/** Build an adapter pointed at a stub. */
function adapterFor(baseURL, extra = {}) {
  return new CodexAdapter({
    config: () => ({ ...Config({}), baseURL, refreshMinutes: 60, ...extra.config }),
    resolveCredential: async () => ({ accessToken: 'test-token', accountId: 'acct-test' }),
    imageAccess: extra.imageAccess,
  })
}

/** Drain a chunk stream. */
async function drain(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const userMessage = (text) => ({
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

console.log('end-to-end adapter stream')

await test('a text turn yields a complete, well-formed chunk stream', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => sse(res, TEXT_TURN),
  })
  const adapter = adapterFor(s.baseURL)
  const chunks = await drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('hi')] }))
  await s.stop()

  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks[0].blockType, 'text')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, 'Hello world')
  const end = chunks.find((c) => c.type === 'block-end')
  assert.equal(end.block.text, 'Hello world')
  const usage = chunks.find((c) => c.type === 'usage')
  assert.equal(usage.usage.inputTokens, 60)
  assert.equal(usage.usage.cacheReadTokens, 40)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

await test('the request carries the required Codex headers and body', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => sse(res, TEXT_TURN),
  })
  const adapter = adapterFor(s.baseURL)
  await drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('hi')] }))
  await s.stop()

  const call = s.captured.find((c) => c.url === '/responses')
  assert.equal(call.headers['chatgpt-account-id'], 'acct-test')
  assert.equal(call.headers.originator, 'codex_cli_rs')
  // The value the Codex CLI itself sends; probing showed the backend accepts
  // any value here, so this asserts compatibility with the first-party client
  // rather than a hard requirement.
  assert.equal(call.headers['openai-beta'], 'responses_websockets=2026-02-06')
  assert.match(call.headers.authorization, /^Bearer test-token$/)
  assert.match(call.headers['user-agent'], /codex_cli_rs/)

  const body = JSON.parse(call.body)
  assert.equal(body.model, 'gpt-6-astra')
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.equal(body.input[0].content[0].text, 'hi')
})

await test('model requests report the same client version as the catalog', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => sse(res, TEXT_TURN),
  })
  const adapter = adapterFor(s.baseURL, { config: { clientVersion: '9.9.9' } })
  await drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('hi')] }))
  await s.stop()

  // The backend gates newer models by client version, so a default literal
  // here gets a model the catalog just listed refused as unsupported.
  assert.match(s.captured.find((c) => c.url.startsWith('/models')).url, /client_version=9\.9\.9/)
  const call = s.captured.find((c) => c.url === '/responses')
  assert.equal(call.headers.version, '9.9.9')
  assert.match(call.headers['user-agent'], /\/9\.9\.9/)
})

await test('a tool turn emits reasoning and tool-call blocks and finishes tool-calls', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => sse(res, TOOL_TURN),
  })
  const adapter = adapterFor(s.baseURL)
  const chunks = await drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('read a.txt')] }))
  await s.stop()

  const reasoning = chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(reasoning.block.text, 'I should read the file.')
  const call = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(call.block.id, 'call_abc')
  assert.equal(call.block.name, 'read')
  assert.equal(call.block.arguments, '{"path":"a.txt"}')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

await test('tools and reasoning effort reach the request body', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => sse(res, TEXT_TURN),
  })
  const adapter = adapterFor(s.baseURL)
  await drain(adapter.stream({
    provider: PROVIDER_ID,
    model: 'gpt-6-astra',
    reasoningEffort: 'ultra',
    maxTokens: 512,
    messages: [userMessage('hi')],
    tools: [{ name: 'read', description: 'reads a file', parameters: { type: 'object' } }],
  }))
  await s.stop()

  const body = JSON.parse(s.captured.find((c) => c.url === '/responses').body)
  assert.deepEqual(body.reasoning, { effort: 'ultra' })
  assert.equal(body.max_output_tokens, 512)
  assert.equal(body.tools[0].name, 'read')
  assert.equal(body.tool_choice, 'auto')
})

await test('history replays tool results as function_call_output', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => sse(res, TEXT_TURN),
  })
  const adapter = adapterFor(s.baseURL)
  await drain(adapter.stream({
    provider: PROVIDER_ID,
    model: 'gpt-6-astra',
    messages: [
      userMessage('read a.txt'),
      { id: 'm2', role: 'assistant', content: [{ type: 'tool-call', id: 'call_abc', name: 'read', arguments: '{"path":"a.txt"}' }], source: { kind: 'model', provider: PROVIDER_ID, model: 'gpt-6-astra' } },
      { id: 'm3', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_abc', content: [{ type: 'text', text: 'file body' }] }], source: { kind: 'tool', callId: 'call_abc' } },
    ],
  }))
  await s.stop()

  const body = JSON.parse(s.captured.find((c) => c.url === '/responses').body)
  const types = body.input.map((i) => i.type)
  assert.deepEqual(types, ['message', 'function_call', 'function_call_output'])
  assert.equal(body.input[2].call_id, 'call_abc')
  assert.equal(body.input[2].output, 'file body')
})

await test('a dsh 0.2.1 tool-role result is sent as function_call_output', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => sse(res, TEXT_TURN),
  })
  const adapter = adapterFor(s.baseURL)
  await drain(adapter.stream({
    provider: PROVIDER_ID,
    model: 'gpt-6-astra',
    messages: [
      userMessage('read a.txt'),
      { id: 'm2', role: 'assistant', content: [{ type: 'tool-call', id: 'call_abc', name: 'read', arguments: '{"path":"a.txt"}' }], source: { kind: 'model', provider: PROVIDER_ID, model: 'gpt-6-astra' } },
      // Since dsh 0.2.1 the result is its own message, with the call id on it.
      { id: 'm3', role: 'tool', toolCallId: 'call_abc', content: [{ type: 'text', text: 'file body' }], source: { kind: 'tool', callId: 'call_abc' } },
    ],
  }))
  await s.stop()

  const body = JSON.parse(s.captured.find((c) => c.url === '/responses').body)
  assert.deepEqual(body.input.map((i) => i.type), ['message', 'function_call', 'function_call_output'])
  assert.deepEqual(body.input[2], { type: 'function_call_output', call_id: 'call_abc', output: 'file body' })
})

await test('a 429 quota response raises QUOTA with a reset hint', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_in_seconds: 3600 } }))
    },
  })
  const adapter = adapterFor(s.baseURL)
  await assert.rejects(
    () => drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('hi')] })),
    (e) => e.code === 'QUOTA' && e.failure.status === 429 && e.failure.providerRetryAfterMs === 3_600_000,
  )
  await s.stop()
})

await test('a 401 raises AUTH and invalidates the cached credential', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad token"}}') },
  })
  let invalidated = 0
  const adapter = new CodexAdapter({
    config: () => ({ ...Config({}), baseURL: s.baseURL, refreshMinutes: 60 }),
    resolveCredential: async () => ({ accessToken: 't', accountId: 'a' }),
    onAuthRejected: () => { invalidated++ },
  })
  await assert.rejects(
    () => drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('hi')] })),
    (e) => e.code === 'AUTH',
  )
  assert.equal(invalidated, 1)
  await s.stop()
})

await test('an unreachable backend surfaces as a transport failure', async () => {
  // Port 1 is reserved and never listening.
  const adapter = adapterFor('http://127.0.0.1:1')
  await assert.rejects(
    () => drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('hi')] })),
    (e) => e.code === 'TRANSPORT' || e.code === 'TIMEOUT',
  )
})

await test('caller cancellation aborts the request', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(TEXT_TURN[0])}\n\n`)
      // Never ends; the abort must tear it down.
    },
  })
  const adapter = adapterFor(s.baseURL)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(
    () => drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('hi')], signal: controller.signal })),
    (e) => e.code === 'ABORTED' || e.code === 'TRANSPORT',
  )
  await s.stop()
})

await test('an empty completion is reported as a retryable failure', async () => {
  const s = await stub({
    '/models': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(CATALOG) },
    '/responses': (req, res) => sse(res, [{ type: 'response.completed', response: { id: 'r', status: 'completed' } }]),
  })
  const adapter = adapterFor(s.baseURL)
  const chunks = await drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [userMessage('hi')] }))
  await s.stop()
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

console.log('\norigin failover')

await test('a custom baseURL is never redirected to a built-in origin', async () => {
  const failovers = []
  // A user pointing at a self-hosted gateway means exactly that host. Silently
  // redirecting their traffic to OpenAI's endpoint would leak prompts, so a
  // custom origin must fail on its own rather than fall through.
  await assert.rejects(
    () => codexRequest({
      baseURL: 'http://127.0.0.1:1',
      path: '/models',
      method: 'GET',
      accessToken: 't',
      accountId: 'a',
      timeoutMs: 5_000,
      onOriginFailover: (origin) => failovers.push(origin),
    }),
    (e) => e.code === 'TRANSPORT' || e.code === 'TIMEOUT',
  )
  assert.deepEqual(failovers, [])
})

await test('a provider status is never treated as failover-eligible', async () => {
  const s = await stub({
    '/models': (req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 60 } }))
    },
  })
  const failovers = []
  // A quota answer is the endpoint's real reply; retrying it on another origin
  // would burn a request per origin for an allowance that resets hours later.
  const res = await codexRequest({
    baseURL: s.baseURL,
    path: '/models',
    method: 'GET',
    accessToken: 't',
    accountId: 'a',
    timeoutMs: 10_000,
    onOriginFailover: (origin) => failovers.push(origin),
  })
  await s.stop()
  assert.equal(res.status, 429)
  assert.deepEqual(failovers, [])
})

await test('the built-in origin set is what failover moves between', async () => {
  const { DEFAULT_BASE_URL: primary, ALTERNATE_BASE_URLS: alternates } = await import('../lib/transport.js')
  assert.ok(alternates.length >= 1, 'expected at least one alternate origin')
  assert.ok(!alternates.includes(primary), 'an alternate must not be the primary')
  // Every alternate must be a distinct, absolute https origin.
  for (const url of alternates) {
    const parsed = new URL(url)
    assert.equal(parsed.protocol, 'https:')
    assert.ok(url.endsWith('/backend-api/codex'), `${url} must point at the same API path`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
