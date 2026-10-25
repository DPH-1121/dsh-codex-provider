// Protocol conversion tests: harness messages <-> Responses API, and the
// SSE -> StreamChunk translation.
import { strict as assert } from 'node:assert'
import {
  flattenText,
  parseEvents,
  toFinishReason,
  toRequestError,
  toResponsesInput,
  toResponsesInputWithImages,
  toResponsesTools,
  toTokenUsage,
  assistantItems,
  readReplay,
  replayEnvelope,
} from '../lib/convert.js'
import { StreamTranslator } from '../lib/stream.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

const msg = (role, content, source) => ({ id: `m-${Math.random()}`, role, content, source: source ?? { kind: 'user' } })

console.log('convert.js')

test('flattenText joins text blocks and ignores others', () => {
  assert.equal(flattenText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
})

test('a leading system message becomes instructions', () => {
  const out = toResponsesInput({
    messages: [msg('system', [{ type: 'text', text: 'be terse' }], { kind: 'plugin', plugin: 'p' }), msg('user', [{ type: 'text', text: 'hi' }])],
  })
  assert.equal(out.instructions, 'be terse')
  assert.equal(out.input.length, 1)
  assert.deepEqual(out.input[0].content, [{ type: 'input_text', text: 'hi' }])
})

test('options.system and a system message both fold into instructions', () => {
  const out = toResponsesInput({
    system: 'outer',
    messages: [msg('system', [{ type: 'text', text: 'inner' }], { kind: 'plugin', plugin: 'p' })],
  })
  assert.equal(out.instructions, 'outer\n\ninner')
  assert.equal(out.input.length, 0)
})

test('assistant text becomes output_text', () => {
  const out = toResponsesInput({ messages: [msg('assistant', [{ type: 'text', text: 'hello' }], { kind: 'model', provider: 'codex', model: 'x' })] })
  assert.deepEqual(out.input[0], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] })
})

test('assistant tool calls become function_call items with string arguments', () => {
  const out = toResponsesInput({
    messages: [msg('assistant', [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
    ], { kind: 'model', provider: 'codex', model: 'x' })],
  })
  assert.equal(out.input.length, 2)
  assert.deepEqual(out.input[1], { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' })
})

test('an empty tool-call argument string becomes {}', () => {
  const out = toResponsesInput({
    messages: [msg('assistant', [{ type: 'tool-call', id: 'c', name: 'f', arguments: '' }], { kind: 'model', provider: 'codex', model: 'x' })],
  })
  assert.equal(out.input[0].arguments, '{}')
})

test('reasoning blocks are not replayed', () => {
  const out = toResponsesInput({
    messages: [msg('assistant', [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }], { kind: 'model', provider: 'codex', model: 'x' })],
  })
  assert.equal(out.input.length, 1)
  assert.equal(out.input[0].content[0].text, 'answer')
})

test('tool results become function_call_output correlated by call id', () => {
  const out = toResponsesInput({
    messages: [msg('user', [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] }], { kind: 'tool', callId: 'call_1' })],
  })
  assert.deepEqual(out.input[0], { type: 'function_call_output', call_id: 'call_1', output: 'file body' })
})

test('a tool result and user text in one message split into two items', () => {
  const out = toResponsesInput({
    messages: [msg('user', [
      { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r' }] },
      { type: 'text', text: 'and also' },
    ], { kind: 'tool', callId: 'c1' })],
  })
  assert.equal(out.input.length, 2)
  assert.equal(out.input[0].type, 'function_call_output')
  assert.equal(out.input[1].type, 'message')
})

test('unresolvable images degrade to a visible placeholder', () => {
  const out = toResponsesInput({
    messages: [msg('user', [{ type: 'text', text: 'see' }, { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 3 } }])],
  })
  const content = out.input[0].content
  assert.equal(content[1].type, 'input_text')
  assert.match(content[1].text, /image omitted/)
})

test('documents are named, not inlined', () => {
  const out = toResponsesInput({
    messages: [msg('user', [{ type: 'file', attachment: { attachmentId: 'f', mediaType: 'text/plain', bytes: 1, name: 'notes.txt' } }])],
  })
  assert.match(out.input[0].content[0].text, /notes\.txt/)
})

test('tools map to the Responses tool shape', () => {
  const tools = toResponsesTools([{ name: 'read', description: 'reads', parameters: { type: 'object' } }])
  assert.deepEqual(tools[0], { type: 'function', name: 'read', description: 'reads', parameters: { type: 'object' }, strict: false })
})

test('no tools yields undefined rather than an empty array', () => {
  assert.equal(toResponsesTools([]), undefined)
  assert.equal(toResponsesTools(undefined), undefined)
})

test('resolved images become input_image data URLs', () => {
  const out = toResponsesInputWithImages({
    messages: [msg('user', [
      { type: 'text', text: 'see' },
      { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 3 }, resolved: { mediaType: 'image/png', base64: 'AAA=' } },
    ])],
  })
  const content = out.input[0].content
  assert.equal(content[1].type, 'input_image')
  assert.equal(content[1].image_url, 'data:image/png;base64,AAA=')
})

test('with-images keeps item ordering for mixed history', () => {
  const out = toResponsesInputWithImages({
    messages: [
      msg('user', [{ type: 'text', text: 'plain' }]),
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' }], { kind: 'model', provider: 'codex', model: 'x' }),
      msg('user', [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r' }] }], { kind: 'tool', callId: 'c1' }),
      msg('user', [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1 }, resolved: { mediaType: 'image/png', base64: 'AA==' } }]),
    ],
  })
  assert.deepEqual(out.input.map((i) => i.type), ['message', 'function_call', 'function_call_output', 'message'])
  assert.equal(out.input[3].content[0].type, 'input_image')
})

console.log('\nusage mapping')

test('cached input is subtracted so counts stay disjoint', () => {
  const usage = toTokenUsage({ input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 800 } })
  assert.equal(usage.inputTokens, 200)
  assert.equal(usage.cacheReadTokens, 800)
  assert.equal(usage.outputTokens, 50)
  assert.equal(usage.totalTokens, 1050)
})

test('reasoning tokens are surfaced separately', () => {
  const usage = toTokenUsage({ input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } })
  assert.equal(usage.reasoningTokens, 7)
})

test('an empty usage object yields undefined', () => {
  assert.equal(toTokenUsage({}), undefined)
  assert.equal(toTokenUsage(null), undefined)
})

console.log('\nfinish reasons')

test('incomplete for max tokens maps to max-tokens', () => {
  assert.deepEqual(toFinishReason({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), { kind: 'max-tokens' })
})

test('a failed response maps to an error finish', () => {
  const reason = toFinishReason({ status: 'failed', error: { message: 'boom' } })
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.message, 'boom')
})

test('a completed response maps to stop', () => {
  assert.deepEqual(toFinishReason({ status: 'completed' }), { kind: 'stop' })
})

console.log('\nerror mapping')

const quota = (d) => /usage_limit_reached|quota/i.test(d)
const ctxOver = (d) => /context/i.test(d)

test('401 maps to AUTH', () => {
  const err = toRequestError(401, '{"error":{"message":"bad token"}}', quota, ctxOver)
  assert.equal(err.code, 'AUTH')
})

test('429 with usage_limit_reached maps to QUOTA with a reset hint', () => {
  const err = toRequestError(429, '{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}', quota, ctxOver)
  assert.equal(err.code, 'QUOTA')
  assert.equal(err.failure.providerRetryAfterMs, 3_600_000)
})

test('429 without quota wording maps to RATE_LIMIT', () => {
  const err = toRequestError(429, '{"error":{"type":"rate_limit"}}', quota, ctxOver)
  assert.equal(err.code, 'RATE_LIMIT')
})

test('context overflow wording maps to CONTEXT_WINDOW_EXCEEDED', () => {
  const err = toRequestError(400, '{"error":{"message":"context window exceeded"}}', quota, ctxOver)
  assert.equal(err.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('404 maps to UNKNOWN_MODEL', () => {
  const err = toRequestError(404, 'nope', quota, ctxOver)
  assert.equal(err.code, 'UNKNOWN_MODEL')
})

test('an HTML error body does not crash the mapper', () => {
  const err = toRequestError(500, '<html>oops</html>', quota, ctxOver)
  assert.equal(err.code, 'PROVIDER_ERROR')
  assert.match(err.message, /HTTP 500/)
})

console.log('\nSSE parsing')

test('parseEvents reads data lines and skips [DONE]', () => {
  const events = parseEvents('data: {"type":"a"}\n\ndata: [DONE]\n\ndata: {"type":"b"}\n')
  assert.deepEqual(events.map((e) => e.type), ['a', 'b'])
})

test('a malformed frame is skipped, not fatal', () => {
  const events = parseEvents('data: {oops\n\ndata: {"type":"ok"}\n')
  assert.deepEqual(events.map((e) => e.type), ['ok'])
})

console.log('\nstream translation')

function run(events) {
  const t = new StreamTranslator()
  const chunks = []
  for (const e of events) chunks.push(...t.push(e))
  chunks.push(...t.end())
  return chunks
}

test('a text turn produces start, delta, end, usage, finish', () => {
  const chunks = run([
    { type: 'response.created', response: { id: 'r1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'lo' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hello' }] } },
    { type: 'response.completed', response: { id: 'r1', status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
  ])
  const kinds = chunks.map((c) => c.type)
  assert.deepEqual(kinds, ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[1].text, 'Hel')
  assert.equal(chunks[3].block.text, 'Hello')
  assert.deepEqual(chunks[5].reason, { kind: 'stop' })
})

test('interleaved text and tool call get distinct block indexes', () => {
  const chunks = run([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
    { type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: 'I will read' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'read' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"pa' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: 'th":"a"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const textStart = chunks.find((c) => c.type === 'block-start' && c.blockType === 'text')
  const callStart = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  assert.notEqual(textStart.index, callStart.index)
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(end.block.id, 'call_1')
  assert.equal(end.block.name, 'read')
  assert.equal(end.block.arguments, '{"path":"a"}')
})

test('a tool-call turn finishes with tool-calls even if status is completed', () => {
  const chunks = run([
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'f', arguments: '{}' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const finish = chunks.at(-1)
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
})

test('reasoning summaries become a reasoning block', () => {
  const chunks = run([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs1', output_index: 0, delta: 'weighing options' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs1', summary: [{ text: 'weighing options' }] } },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 1, content_index: 0, delta: 'done' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const reasoning = chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  const text = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(reasoning.block.text, 'weighing options')
  assert.notEqual(reasoning.index, text.index)
  assert.equal(text.block.text, 'done')
})

test('a stream without a terminal event finishes as a transport error', () => {
  const chunks = run([{ type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'partial' }])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TRANSPORT')
})

test('an empty completion is reported as EMPTY_RESPONSE', () => {
  const chunks = run([{ type: 'response.completed', response: { id: 'r', status: 'completed' } }])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('an in-band error event ends the stream as an error', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'x' },
    { type: 'error', error: { message: 'backend exploded', status: 500 } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /backend exploded/)
})

console.log('\nchunk ordering invariants')

test('usage is emitted before the terminal finish and nothing follows it', () => {
  // The StreamChunk contract states: "Adapters emit usage before the terminal
  // finish and nothing afterward."
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'hi' },
    { type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 9, output_tokens: 2 } } },
  ])
  const usageIndex = chunks.findIndex((c) => c.type === 'usage')
  const finishIndex = chunks.findIndex((c) => c.type === 'finish')
  assert.ok(usageIndex >= 0, 'usage should have been emitted')
  assert.ok(finishIndex >= 0, 'a finish should have been emitted')
  assert.ok(usageIndex < finishIndex, 'usage must precede finish')
  assert.equal(finishIndex, chunks.length - 1, 'nothing may follow finish')
})

test('exactly one finish chunk is emitted', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'hi' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  assert.equal(chunks.filter((c) => c.type === 'finish').length, 1)
})

test('every delta lands inside an open block', () => {
  // A delta whose block was never opened would be dropped by assembly, so each
  // one must be preceded by its block-start.
  const chunks = run([
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', delta: 'think' },
    { type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: 'say' },
    { type: 'response.function_call_arguments.delta', item_id: 'c1', delta: '{}' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const open = new Set()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') open.add(chunk.index)
    else if (chunk.type === 'block-end') open.delete(chunk.index)
    else if (chunk.type.endsWith('-delta')) {
      assert.ok(open.has(chunk.index), `${chunk.type} at index ${chunk.index} has no open block`)
    }
  }
  assert.equal(open.size, 0, 'every open block must be closed')
})

test('block starts, deltas and ends use one dense index space', () => {
  const chunks = run([
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', delta: 'think' },
    { type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: 'say' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const starts = chunks.filter((c) => c.type === 'block-start').map((c) => c.index)
  assert.deepEqual(starts, [0, 1])
  for (const chunk of chunks) {
    if (chunk.index === undefined) continue
    assert.ok(starts.includes(chunk.index), `index ${chunk.index} was used without a block-start`)
  }
})

test('nothing is emitted after the finish even when the response is an error', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'partial' },
    { type: 'error', error: { message: 'boom' } },
  ])
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.filter((c) => c.type === 'finish').length, 1)
})

test('unknown event types are ignored without breaking the turn', () => {
  const chunks = run([
    { type: 'response.some_future_event', payload: {} },
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'ok' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('multi-part text content indexes separately', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'first' },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 1, delta: 'second' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }] } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].index, starts[1].index)
  const ends = chunks.filter((c) => c.type === 'block-end')
  assert.equal(ends.length, 2)
})

test('block indexes are allocated densely from zero', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'a', content_index: 0, delta: 'x' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'b', delta: 'y' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'c', name: 'f' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const indexes = chunks.filter((c) => c.type === 'block-start').map((c) => c.index)
  assert.deepEqual(indexes, [0, 1, 2])
})

console.log('\nshape-based fallback for unrecognized event names')

test('a renamed text-delta event still produces a text block', () => {
  const chunks = run([
    { type: 'response.some_future_text_event.delta', item_id: 'm', content_index: 0, delta: 'hello' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, 'hello')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.equal(chunks.find((c) => c.type === 'block-start').blockType, 'text')
})

test('a renamed reasoning-delta event still produces a reasoning block', () => {
  const chunks = run([
    { type: 'response.experimental_thinking.delta', item_id: 'r1', delta: 'hmm' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, 'hmm')
  assert.equal(chunks.find((c) => c.type === 'block-start').blockType, 'reasoning')
})

test('a renamed tool-argument delta still produces a tool-call block', () => {
  const chunks = run([
    { type: 'response.some_tool_call_arguments.delta', item_id: 'fc1', delta: '{"a":1}' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const call = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(call.block.arguments, '{"a":1}')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('an unrecognized event carrying a completed response still terminates', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'done' },
    { type: 'response.some_new_terminal_event', response: { id: 'r', status: 'completed' } },
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('an unrecognized event carrying an error surfaces the failure', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'partial' },
    { type: 'response.weird_failure', error: { message: 'backend exploded', status: 503 } },
  ])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /backend exploded/)
})

test('an unrecognized event carrying a whole message yields its text', () => {
  const chunks = run([
    { type: 'response.unexpected_item_event', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'full text' }] } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(end.block.text, 'full text')
})

test('a genuinely inert unknown event is still ignored', () => {
  const chunks = run([
    { type: 'response.some_telemetry_ping', payload: { whatever: true } },
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'ok' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 1)
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('the fallback does not double-count an event the exact match handled', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'once' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, 'once')
})

console.log('\ncamelCase key spelling')

test('a camelCase text stream is keyed identically to a snake_case one', () => {
  // The shipped client contains both spellings, so both must work. Getting this
  // wrong is silent: every block would key off `undefined` and the whole turn
  // would collapse into one block.
  const camel = run([
    { type: 'response.output_text.delta', itemId: 'm1', contentIndex: 0, delta: 'a' },
    { type: 'response.output_text.delta', itemId: 'm2', contentIndex: 0, delta: 'b' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const starts = camel.filter((c) => c.type === 'block-start')
  assert.equal(starts.length, 2, 'two items must produce two blocks, not one')
  assert.notEqual(starts[0].index, starts[1].index)
})

test('camelCase contentIndex separates parts of one item', () => {
  const chunks = run([
    { type: 'response.output_text.delta', itemId: 'm1', contentIndex: 0, delta: 'first' },
    { type: 'response.output_text.delta', itemId: 'm1', contentIndex: 1, delta: 'second' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 2)
})

test('a camelCase item done event closes the block it identifies', () => {
  const chunks = run([
    { type: 'response.output_item.done', outputIndex: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'full' }] } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(end.block.text, 'full')
})

test('a camelCase function call stream still finishes as tool-calls', () => {
  const chunks = run([
    { type: 'response.output_item.added', outputIndex: 0, item: { type: 'function_call', id: 'fc1', callId: 'call_x', name: 'read' } },
    { type: 'response.function_call_arguments.delta', itemId: 'fc1', delta: '{"p":1}' },
    { type: 'response.output_item.done', outputIndex: 0, item: { type: 'function_call', id: 'fc1', callId: 'call_x', name: 'read', arguments: '{"p":1}' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const call = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(call.block.id, 'call_x')
  assert.equal(call.block.arguments, '{"p":1}')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('mixed spellings within one stream still produce one block per item', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: 'snake' },
    { type: 'response.output_text.delta', itemId: 'm2', contentIndex: 0, delta: 'camel' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, 'snakecamel')
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 2)
})

console.log('\nauthoritative wire shapes (from generated TypeScript bindings)')

test('a reasoning item summary of {type,text} objects is read', () => {
  // ResponseItem defines summary as Array<ReasoningItemReasoningSummary>,
  // i.e. [{ type: 'summary_text', text }] — not bare strings.
  const chunks = run([
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'first' }, { type: 'summary_text', text: 'second' }],
        encrypted_content: null,
      },
    },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const block = chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(block.block.text, 'firstsecond')
})

test('a reasoning item summary of bare strings is also read', () => {
  // ThreadItem's v2 view types summary as Array<string>, so both must work.
  const chunks = run([
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: ['a', 'b'] } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const block = chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  assert.equal(block.block.text, 'ab')
})

test('a function_call item read from the wire carries call_id and arguments', () => {
  // ResponseItem: { type: 'function_call', name, arguments: string, call_id }
  const chunks = run([
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', name: 'read', arguments: '{"path":"a"}', call_id: 'call_9' },
    },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const call = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(call.block.id, 'call_9')
  assert.equal(call.block.name, 'read')
  assert.equal(call.block.arguments, '{"path":"a"}')
})

test('a message item content of output_text parts is read', () => {
  // ContentItem: { type: 'output_text', text }
  const chunks = run([
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
    },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const block = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(block.block.text, 'hi there')
})

console.log('replay and hosted search')

const modelSource = (model, items) => ({ kind: 'model', provider: 'codex', model, replayState: replayEnvelope(model, items) })
const R1 = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'E1' }
const WS = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'q' } }
const replayed = (items) => msg('assistant', [
  { type: 'reasoning', text: 'summary' },
  { type: 'text', text: 'checking' },
  { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
], modelSource('gpt-x', items))

test('replay restores reasoning and search items in output order', () => {
  const m = replayed([{ kind: 'item', item: R1 }, { kind: 'item', item: WS }, { kind: 'message' }, { kind: 'call', callId: 'c1' }])
  assert.deepEqual(assistantItems(m, 'gpt-x').map((i) => i.type), ['reasoning', 'web_search_call', 'message', 'function_call'])
  const { id: _id, ...sent } = R1
  assert.deepEqual(toResponsesInput({ model: 'gpt-x', messages: [m] }).input[0], sent)
})

test('replayed items are sent without ids, as Codex sends them with store:false', () => {
  const m = replayed([{ kind: 'item', item: R1 }, { kind: 'item', item: WS }, { kind: 'message' }, { kind: 'call', callId: 'c1' }])
  const items = assistantItems(m, 'gpt-x')
  assert.ok(items.every((item) => !('id' in item)), JSON.stringify(items))
  assert.deepEqual(items[1], { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'q' } })
})

test('text on either side of a call or a search stays on its side', () => {
  const m = msg('assistant', [
    { type: 'text', text: 'before' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
    { type: 'reasoning', text: 'Web search: "q"' },
    { type: 'text', text: 'after' },
  ], modelSource('gpt-x', [{ kind: 'message', parts: 1 }, { kind: 'call', callId: 'c1' }, { kind: 'item', item: WS }, { kind: 'message', parts: 1 }]))
  const items = assistantItems(m, 'gpt-x')
  assert.deepEqual(items.map((i) => i.type), ['message', 'function_call', 'web_search_call', 'message'])
  assert.equal(items[0].content[0].text, 'before')
  assert.equal(items[3].content[0].text, 'after')
  // Entries recorded without a part count stand for one part each.
  const legacy = msg('assistant', m.content, modelSource('gpt-x', [{ kind: 'message' }, { kind: 'call', callId: 'c1' }, { kind: 'message' }]))
  assert.deepEqual(assistantItems(legacy, 'gpt-x').map((i) => i.content?.[0].text ?? i.type), ['before', 'function_call', 'after'])
})

test('a message with several text parts is replayed as one message with those parts', () => {
  const m = msg('assistant', [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }], modelSource('gpt-x', [{ kind: 'item', item: R1 }, { kind: 'message', parts: 2 }]))
  const items = assistantItems(m, 'gpt-x')
  assert.deepEqual(items.map((i) => i.type), ['reasoning', 'message'])
  assert.deepEqual(items[1].content, [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }])
})

test('with reasoning replay off, stored reasoning is withheld but search items stay', () => {
  const m = replayed([{ kind: 'item', item: R1 }, { kind: 'item', item: WS }, { kind: 'message' }, { kind: 'call', callId: 'c1' }])
  assert.deepEqual(assistantItems(m, 'gpt-x', { reasoning: false }).map((i) => i.type), ['web_search_call', 'message', 'function_call'])
  assert.deepEqual(toResponsesInput({ model: 'gpt-x', messages: [m] }, { reasoning: false }).input.map((i) => i.type), ['web_search_call', 'message', 'function_call'])
})

test('an invalid part count makes the replay state malformed', () => {
  const m = msg('assistant', [{ type: 'text', text: 'x' }], modelSource('gpt-x', [{ kind: 'message', parts: -1 }]))
  assert.equal(readReplay(m, 'gpt-x'), undefined)
})

test('replay is skipped for a different target model', () => {
  const m = replayed([{ kind: 'item', item: R1 }, { kind: 'message' }, { kind: 'call', callId: 'c1' }])
  assert.equal(readReplay(m, 'gpt-y'), undefined)
  assert.deepEqual(assistantItems(m, 'gpt-y').map((i) => i.type), ['message', 'function_call'])
})

test('foreign or malformed replay state is ignored', () => {
  const foreign = msg('assistant', [{ type: 'text', text: 'x' }], { kind: 'model', provider: 'codex', model: 'gpt-x', replayState: { response: { kind: 'deepseek-messages', version: 1, model: 'gpt-x' }, blocks: [] } })
  const broken = msg('assistant', [{ type: 'text', text: 'x' }], { kind: 'model', provider: 'codex', model: 'gpt-x', replayState: { response: { kind: 'codex-responses', version: 1, model: 'gpt-x' }, items: [{ kind: 'item', item: 'nope' }] } })
  assert.equal(readReplay(foreign, 'gpt-x'), undefined)
  assert.equal(readReplay(broken, 'gpt-x'), undefined)
  assert.deepEqual(assistantItems(broken, 'gpt-x').map((i) => i.type), ['message'])
})

test('a reasoning item left without its following call is dropped', () => {
  const m = msg('assistant', [{ type: 'text', text: 'partial' }], modelSource('gpt-x', [{ kind: 'message' }, { kind: 'item', item: R1 }, { kind: 'call', callId: 'gone' }]))
  assert.deepEqual(assistantItems(m, 'gpt-x').map((i) => i.type), ['message'])
})

test('calls and text missing from the replay order are still sent', () => {
  const m = replayed([{ kind: 'item', item: R1 }])
  assert.deepEqual(assistantItems(m, 'gpt-x').map((i) => i.type), ['reasoning', 'message', 'function_call'])
})

test('the stream records encrypted reasoning and positions in the finish replay state', () => {
  const t = new StreamTranslator({ model: 'gpt-x' })
  const chunks = [
    { type: 'response.created', response: { id: 'r', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }], encrypted_content: 'E1' } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Reading.' }] } },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'read', arguments: '{}' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
  ].flatMap((e) => t.push(e)).concat(t.end())
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.deepEqual(finish.replayState, {
    response: { kind: 'codex-responses', version: 1, model: 'gpt-x' },
    items: [
      { kind: 'item', item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }], encrypted_content: 'E1' } },
      { kind: 'message', parts: 1 },
      { kind: 'call', callId: 'c1' },
    ],
  })
})

test('no replay state without encrypted reasoning, or without a model to record', () => {
  const events = [
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }] } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'm', content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ]
  const plain = new StreamTranslator({ model: 'gpt-x' })
  assert.equal(events.flatMap((e) => plain.push(e)).concat(plain.end()).find((c) => c.type === 'finish').replayState, undefined)
  const encrypted = [{ ...events[0], item: { ...events[0].item, encrypted_content: 'E1' } }, ...events.slice(1)]
  const off = new StreamTranslator()
  assert.equal(encrypted.flatMap((e) => off.push(e)).concat(off.end()).find((c) => c.type === 'finish').replayState, undefined)
})

console.log('dsh 0.2.1 message roles')

const toolMsg = (callId, content) => ({ id: `t-${callId}`, role: 'tool', toolCallId: callId, content, source: { kind: 'tool', callId } })

test('a tool-role message becomes function_call_output for its call', () => {
  const call = msg('assistant', [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"file_path":"a"}' }], { kind: 'model', provider: 'codex', model: 'gpt-x' })
  const out = toResponsesInput({ model: 'gpt-x', messages: [msg('user', [{ type: 'text', text: 'go' }]), call, toolMsg('call_1', [{ type: 'text', text: 'file body' }])] })
  assert.deepEqual(out.input.map((i) => i.type), ['message', 'function_call', 'function_call_output'])
  assert.deepEqual(out.input[2], { type: 'function_call_output', call_id: 'call_1', output: 'file body' })
})

test('an unresolved image in a tool result degrades to a note in the output string', () => {
  const out = toResponsesInput({ messages: [toolMsg('c2', [{ type: 'text', text: 'shot:' }, { type: 'image', attachment: { id: 'a' } }])] })
  assert.equal(out.input[0].output, 'shot:\n[image omitted: not resolvable in this environment]')
})

test('a resolved image in a tool result is sent as structured output', () => {
  const tool = toolMsg('c3', [{ type: 'text', text: 'shot:' }, { type: 'image', attachment: { id: 'a' }, resolved: { mediaType: 'image/png', base64: 'AAAA' } }])
  const out = toResponsesInputWithImages({ messages: [msg('user', [{ type: 'text', text: 'look' }]), tool] })
  assert.deepEqual(out.input.map((i) => i.type), ['message', 'function_call_output'])
  assert.deepEqual(out.input[1].output, [{ type: 'input_text', text: 'shot:' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }])
})

test('a developer-role message keeps its role', () => {
  const out = toResponsesInput({ messages: [{ id: 'd', role: 'developer', content: [{ type: 'text', text: 'mode changed' }], source: { kind: 'plugin', plugin: 'p' } }] })
  assert.deepEqual(out.input[0], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'mode changed' }] })
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
