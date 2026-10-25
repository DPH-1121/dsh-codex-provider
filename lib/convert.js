/**
 * Conversion between the harness message vocabulary and the Codex Responses API.
 *
 * ## Request shape
 *
 * The backend takes a `Responses` request: a flat `input` array of typed items
 * (`message`, `function_call`, `function_call_output`) plus a top-level
 * `instructions` string and a `tools` array. The harness instead hands over
 * ordered `Message` values with content blocks, so this module flattens them.
 *
 * Two properties of the harness contract drive the mapping:
 *
 * - A tool result is its own `user`-role message carrying a `tool-result`
 *   block, while the Responses API wants a `function_call_output` item that
 *   names the call it answers. The call id is carried across by the block, so
 *   no positional guessing is needed.
 * - An assistant turn's `tool-call` blocks must be replayed as `function_call`
 *   items *before* the results that answer them, and the Responses API reads
 *   `arguments` as a JSON string rather than an object.
 *
 * ## Images
 *
 * The backend accepts `input_image` items with a data URL. The harness keeps
 * images as durable attachment references that must be resolved to bytes
 * through the attachment service, so image projection is asynchronous and
 * lives in {@link projectImages} rather than in the pure text path.
 *
 * @module dsh-codex-provider/convert
 */
import { LlmError } from './llm-error.js'

/**
 * Concatenate the text of a block list.
 * @param blocks - content blocks.
 * @returns the joined text.
 */
export function flattenText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map((block) => (block?.type === 'text' ? block.text : '')).join('')
}

/**
 * The `function_call_output` item answering one tool call.
 *
 * Since dsh 0.2.1 a tool result is its own `tool`-role message: the call id is
 * on the message (`toolCallId`) and the result is ordinary content blocks.
 * Text-only results are sent as a string; a result carrying resolved images
 * (see {@link projectImages}) is sent as the structured content array the
 * backend also accepts, so a tool that returns a screenshot shows it.
 *
 * @param message - a harness `tool`-role message.
 * @returns the backend item.
 */
export function toolOutputItem(message) {
  const blocks = message.content ?? []
  const call_id = String(message.toolCallId)
  const placeholder = (block) => block?.type === 'image'
    ? '[image omitted: not resolvable in this environment]'
    : block?.type === 'file' ? `[file: ${block.attachment?.name ?? 'attachment'}]` : undefined
  if (!blocks.some((block) => block?.type === 'image' && block.resolved !== undefined)) {
    const notes = blocks.map(placeholder).filter((note) => note !== undefined)
    return { type: 'function_call_output', call_id, output: [flattenText(blocks), ...notes].filter((part) => part.length > 0).join('\n') }
  }
  const output = []
  for (const block of blocks) {
    if (block?.type === 'text') output.push({ type: 'input_text', text: block.text })
    else if (block?.type === 'image' && block.resolved !== undefined) {
      output.push({ type: 'input_image', image_url: `data:${block.resolved.mediaType};base64,${block.resolved.base64}` })
    } else {
      const note = placeholder(block)
      if (note !== undefined) output.push({ type: 'input_text', text: note })
    }
  }
  return { type: 'function_call_output', call_id, output }
}

/**
 * A developer-role message, which the Responses API accepts as its own role.
 * @param message - a harness `developer`-role message.
 * @returns the backend item, or undefined when it carries no text.
 */
export function developerItem(message) {
  const text = flattenText(message.content)
  return text.length > 0 ? { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } : undefined
}

/**
 * Read a tool-result block as the text the model should see.
 * @param block - a `tool-result` block.
 * @returns the flattened result text.
 */
export function toolResultText(block) {
  return flattenText(block?.content)
}

/**
 * Split the harness message list into `instructions` and `input` items.
 *
 * The harness puts its system prompt in a leading `system`-role message for
 * loop-built requests, and in `options.system` for one-shot callers. The
 * Responses API has a dedicated `instructions` field, so both collapse into it;
 * any later `system` message is appended to the instructions, because the
 * backend reads `instructions` as one string rather than a positioned message.
 *
 * @param options - the assembled request.
 * @returns instruction text plus the ordered input items.
 */
export function toResponsesInput(options) {
  const instructions = []
  if (typeof options.system === 'string' && options.system.length > 0) instructions.push(options.system)

  const input = []
  for (const message of options.messages ?? []) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text.length > 0) instructions.push(text)
      continue
    }

    if (message.role === 'assistant') {
      // Reasoning blocks are not replayable input for this backend, and a
      // replayed `reasoning` item would need its encrypted payload.
      const text = flattenText(message.content)
      if (text.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const call of message.content ?? []) {
        if (call?.type !== 'tool-call') continue
        input.push({
          type: 'function_call',
          call_id: String(call.id),
          name: call.name,
          arguments: call.arguments.length > 0 ? call.arguments : '{}',
        })
      }
      continue
    }

    if (message.role === 'tool') {
      input.push(toolOutputItem(message))
      continue
    }

    if (message.role === 'developer') {
      const item = developerItem(message)
      if (item !== undefined) input.push(item)
      continue
    }

    // user role: a tool result is a distinct item kind, ordinary content is a message.
    const results = (message.content ?? []).filter((block) => block?.type === 'tool-result')
    const regular = (message.content ?? []).filter((block) => block?.type !== 'tool-result')

    for (const result of results) {
      input.push({
        type: 'function_call_output',
        call_id: String(result.toolCallId),
        output: toolResultText(result),
      })
    }

    if (regular.length > 0) {
      const content = regular
        .filter((block) => block?.type === 'text')
        .map((block) => ({ type: 'input_text', text: block.text }))
      // Images are projected separately; a placeholder keeps the ordering fact
      // visible to the model when bytes could not be attached.
      for (const block of regular) {
        if (block?.type === 'image') {
          content.push({ type: 'input_text', text: '[image omitted: not resolvable in this environment]' })
        }
        if (block?.type === 'file') {
          content.push({ type: 'input_text', text: `[file: ${block.attachment?.name ?? 'attachment'}]` })
        }
      }
      if (content.length > 0) input.push({ type: 'message', role: 'user', content })
    }
  }

  return { instructions: instructions.join('\n\n'), input }
}

/**
 * Deep-clone the message list with images replaced by resolvable data URLs.
 *
 * Images arrive as durable attachment references. The Responses API needs
 * bytes, so each retained occurrence is resolved through the attachment
 * service and re-encoded as a data URL. An occurrence that cannot be resolved
 * is replaced by a text placeholder rather than dropped, so the model still
 * learns that an image was present.
 *
 * @param options - the assembled request.
 * @param resolveImage - maps an attachment reference to `{ mediaType, base64 }`.
 * @returns a shallow-cloned request whose image blocks carry inline data.
 */
export async function projectImages(options, resolveImage) {
  const messages = []
  for (const message of options.messages ?? []) {
    const content = []
    for (const block of message.content ?? []) {
      if (block?.type !== 'image' || block.offloaded === true) {
        content.push(block)
        continue
      }
      // A resolver that throws must not fail the turn. Losing one image is a
      // degraded request; losing the turn because an attachment store was
      // briefly unavailable is a broken session. The model still learns an
      // image was present, so its answer stays honest about what it saw.
      let resolved
      try {
        resolved = await resolveImage(block.attachment)
      } catch {
        resolved = undefined
      }
      content.push(resolved === undefined ? { type: 'text', text: '[image omitted: could not be read]' } : { ...block, resolved })
    }
    messages.push({ ...message, content })
  }
  return { ...options, messages }
}

/**
 * Convert harness tool schemas into the Responses API `tools` array.
 * @param tools - harness tool schemas.
 * @returns backend tool descriptors.
 */
export function toResponsesTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
    // Tool arguments are streamed as partial JSON; the backend requires
    // explicit acknowledgement that raw string fragments are acceptable.
    strict: false,
  }))
}

/**
 * Rebuild the final input array with images attached.
 *
 * Runs after {@link projectImages}, reading the `resolved` marker that step
 * attached. Kept separate so the text-only path stays synchronous.
 *
 * @param options - a request whose image blocks carry `resolved` payloads.
 * @returns instruction text plus input items including `input_image` parts.
 */
export function toResponsesInputWithImages(options) {
  const base = toResponsesInput(options)
  // Re-walk in parallel with the base result so image parts land in order.
  const input = []
  let cursor = 0
  for (const message of options.messages ?? []) {
    if (message.role === 'system') continue
    const hasImages = (message.content ?? []).some((block) => block?.type === 'image' && block.resolved !== undefined)
    if (!hasImages) {
      // Consume the base items this message produced.
      const produced = countItemsFor(message)
      for (let i = 0; i < produced; i++) input.push(base.input[cursor++])
      continue
    }
    // Rebuild this message's items with image parts included.
    const items = itemsFor(message)
    cursor += countItemsFor(message)
    input.push(...items)
  }
  // Anything left over (defensive) keeps the base ordering intact.
  while (cursor < base.input.length) input.push(base.input[cursor++])
  return { instructions: base.instructions, input }
}

/**
 * How many Responses items one harness message produces.
 * @param message - a harness message.
 * @returns the item count, mirroring {@link toResponsesInput}.
 */
function countItemsFor(message) {
  if (message.role === 'assistant') {
    let count = flattenText(message.content).length > 0 ? 1 : 0
    count += (message.content ?? []).filter((block) => block?.type === 'tool-call').length
    return count
  }
  if (message.role === 'tool') return 1
  if (message.role === 'developer') return developerItem(message) === undefined ? 0 : 1
  const results = (message.content ?? []).filter((block) => block?.type === 'tool-result').length
  const regular = (message.content ?? []).filter((block) => block?.type !== 'tool-result' && block?.type !== 'reasoning')
  return results + (regular.length > 0 ? 1 : 0)
}

/**
 * Build the Responses items for one harness message, including image parts.
 * @param message - a harness message whose image blocks carry `resolved`.
 * @returns the item list for that message.
 */
function itemsFor(message) {
  const items = []
  if (message.role === 'assistant') {
    const text = flattenText(message.content)
    if (text.length > 0) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
    for (const call of message.content ?? []) {
      if (call?.type !== 'tool-call') continue
      items.push({ type: 'function_call', call_id: String(call.id), name: call.name, arguments: call.arguments.length > 0 ? call.arguments : '{}' })
    }
    return items
  }
  if (message.role === 'tool') return [toolOutputItem(message)]
  if (message.role === 'developer') {
    const item = developerItem(message)
    return item === undefined ? [] : [item]
  }

  for (const result of message.content ?? []) {
    if (result?.type !== 'tool-result') continue
    items.push({ type: 'function_call_output', call_id: String(result.toolCallId), output: toolResultText(result) })
  }

  const regular = (message.content ?? []).filter((block) => block?.type !== 'tool-result')
  if (regular.length === 0) return items

  const content = []
  for (const block of regular) {
    if (block?.type === 'text') {
      content.push({ type: 'input_text', text: block.text })
    } else if (block?.type === 'image' && block.resolved !== undefined) {
      content.push({ type: 'input_image', image_url: `data:${block.resolved.mediaType};base64,${block.resolved.base64}` })
    } else if (block?.type === 'image') {
      content.push({ type: 'input_text', text: '[image omitted: could not be read]' })
    } else if (block?.type === 'file') {
      content.push({ type: 'input_text', text: `[file: ${block.attachment?.name ?? 'attachment'}]` })
    }
  }
  if (content.length > 0) items.push({ type: 'message', role: 'user', content })
  return items
}

/**
 * Map a Responses `usage` object onto the harness token vocabulary.
 *
 * The harness counts are DISJOINT — `inputTokens` excludes cached input, which
 * is reported separately — while Responses reports a single `input_tokens`
 * total that already includes cached tokens. Subtracting the cached count is
 * what keeps billed input equal to the sum of the three fields.
 *
 * @param usage - the Responses `usage` object.
 * @returns harness token usage, or undefined when nothing usable was reported.
 */
export function toTokenUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const totalInput = Number.isFinite(usage.input_tokens) ? usage.input_tokens : undefined
  const cached = Number.isFinite(usage.input_tokens_details?.cached_tokens)
    ? usage.input_tokens_details.cached_tokens
    : undefined
  const output = Number.isFinite(usage.output_tokens) ? usage.output_tokens : undefined
  const reasoning = Number.isFinite(usage.output_tokens_details?.reasoning_tokens)
    ? usage.output_tokens_details.reasoning_tokens
    : undefined

  if (totalInput === undefined && output === undefined) return undefined
  const cacheRead = cached ?? 0
  const inputTokens = Math.max(0, (totalInput ?? 0) - cacheRead)
  const result = {
    inputTokens,
    outputTokens: output ?? 0,
  }
  if (totalInput !== undefined) result.totalTokens = totalInput + (output ?? 0)
  if (cacheRead > 0) result.cacheReadTokens = cacheRead
  if (reasoning !== undefined && reasoning > 0) result.reasoningTokens = reasoning
  return result
}

/**
 * Map a Responses terminal status onto a harness finish reason.
 * @param response - the completed response object.
 * @returns the harness finish reason.
 */
export function toFinishReason(response) {
  const status = response?.status
  if (status === 'incomplete') {
    const reason = response?.incomplete_details?.reason
    if (reason === 'max_output_tokens') return { kind: 'max-tokens' }
    return { kind: 'stop' }
  }
  if (status === 'failed') {
    return {
      kind: 'error',
      failure: {
        message: response?.error?.message ?? 'the Codex backend reported a failed response',
        code: 'PROVIDER_ERROR',
      },
    }
  }
  if (status === 'cancelled') {
    return { kind: 'aborted', failure: { message: 'the response was cancelled', code: 'ABORTED' } }
  }
  return { kind: 'stop' }
}

/**
 * Read the retry hint from a quota-exhausted response.
 * @param body - the parsed error body.
 * @returns milliseconds until the allowance resets, when reported.
 */
export function quotaResetMs(body) {
  const seconds = body?.error?.resets_in_seconds
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

/**
 * Turn a non-2xx backend response into a typed failure.
 * @param status - HTTP status.
 * @param body - response body text.
 * @param quotaExceeded - classifier for terminal quota wording.
 * @param contextExceeded - classifier for context overflow wording.
 * @returns the error to raise.
 */
export function toRequestError(status, body, quotaExceeded, contextExceeded) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }
  const detail = `${parsed?.error?.type ?? ''} ${parsed?.error?.code ?? ''} ${parsed?.error?.message ?? body}`.trim()

  if (status === 401 || status === 403) {
    return new LlmError(
      `dsh-codex-provider: the Codex backend rejected the credential (HTTP ${status}). Run \`codex login\` to refresh the session. ${detail.slice(0, 200)}`,
      'AUTH',
      { status },
    )
  }
  if (status === 429) {
    if (quotaExceeded(detail)) {
      const resetMs = quotaResetMs(parsed)
      return new LlmError(
        `dsh-codex-provider: the ChatGPT subscription usage limit is exhausted${resetMs !== undefined ? ` and resets in about ${Math.round(resetMs / 60000)} minutes` : ''}. ${parsed?.error?.message ?? ''}`.trim(),
        'QUOTA',
        { status, ...(resetMs !== undefined ? { providerRetryAfterMs: resetMs } : {}) },
      )
    }
    return new LlmError(`dsh-codex-provider: rate limited by the Codex backend. ${detail.slice(0, 200)}`, 'RATE_LIMIT', { status })
  }
  if (contextExceeded(detail)) {
    return new LlmError(`dsh-codex-provider: request exceeded the model context window. ${detail.slice(0, 200)}`, 'CONTEXT_WINDOW_EXCEEDED', { status })
  }
  if (status === 404) {
    return new LlmError(`dsh-codex-provider: the backend does not serve this model. ${detail.slice(0, 200)}`, 'UNKNOWN_MODEL', { status })
  }
  return new LlmError(`dsh-codex-provider: the Codex backend returned HTTP ${status}. ${detail.slice(0, 300)}`, 'PROVIDER_ERROR', { status })
}

/**
 * Parse a whole SSE body into event objects.
 * @param body - response body text.
 * @returns parsed events, skipping unparseable frames.
 */
export function parseEvents(body) {
  const events = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      // A partial or non-JSON frame is skipped; the stream's own terminal
      // event is what decides success.
    }
  }
  return events
}
