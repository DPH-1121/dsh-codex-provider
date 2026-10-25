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

/** Replay envelope kind this adapter writes into `source.replayState`. */
export const REPLAY_KIND = 'codex-responses'
/** Replay envelope version; bump when the item layout changes. */
export const REPLAY_VERSION = 1

/**
 * Build the versioned replay envelope persisted on an assistant message.
 *
 * The envelope records the response's output items in order: opaque items the
 * harness has no block for (`reasoning` with its encrypted payload,
 * `web_search_call`) are stored whole, while visible content is stored as
 * position markers (`message`, `call`) so replay can splice the opaque items
 * back between the assistant's text and tool calls exactly where they were.
 *
 * @param model - the requested model id; encrypted reasoning is not portable across models.
 * @param items - ordered entries: `{kind:'item', item}`, `{kind:'message', parts}`, `{kind:'call', callId}`.
 * @returns the envelope, without a `blocks` field so the assembler keeps it as-is.
 */
export function replayEnvelope(model, items) {
  return { response: { kind: REPLAY_KIND, version: REPLAY_VERSION, model }, items }
}

/**
 * Read this adapter's replay entries from an assistant message.
 *
 * Replay is skipped for foreign or malformed state and when the target model
 * differs from the model that produced the message, because encrypted
 * reasoning is only meaningful to the model that wrote it.
 *
 * @param message - a harness assistant message.
 * @param targetModel - the model this request goes to.
 * @returns the ordered entries, or undefined when nothing can be replayed.
 */
export function readReplay(message, targetModel) {
  const source = message?.source
  if (source?.kind !== 'model') return undefined
  const envelope = source.replayState
  if (envelope === null || typeof envelope !== 'object') return undefined
  const response = envelope.response
  if (response?.kind !== REPLAY_KIND || response.version !== REPLAY_VERSION) return undefined
  if (response.model !== source.model || (targetModel !== undefined && response.model !== targetModel)) return undefined
  if (!Array.isArray(envelope.items)) return undefined
  const valid = envelope.items.every((entry) =>
    (entry?.kind === 'item' && entry.item !== null && typeof entry.item === 'object' && typeof entry.item.type === 'string')
    || (entry?.kind === 'message' && (entry.parts === undefined || (Number.isInteger(entry.parts) && entry.parts >= 0)))
    || (entry?.kind === 'call' && typeof entry.callId === 'string'))
  return valid ? envelope.items : undefined
}

/**
 * The Responses input items for one assistant message.
 *
 * Without replay state the message flattens to its text and tool calls, as the
 * harness stores them. With replay state the stored output order is restored,
 * so the model sees its own earlier reasoning and hosted search calls again —
 * the same history Codex keeps. Each recorded output message takes back its own
 * text blocks, so text written before and after a call stays on its side of it.
 * Item ids are not sent: Codex clears them on `store: false` requests, since the
 * backend kept nothing for them to refer to. A reasoning item left with nothing
 * after it (its call was dropped, e.g. by a max-tokens finish) is discarded,
 * because the backend rejects a reasoning item without its following item.
 *
 * @param message - a harness assistant message.
 * @param targetModel - the model this request goes to.
 * @param policy - `{ reasoning }`; `false` withholds stored reasoning items.
 * @returns the ordered input items.
 */
export function assistantItems(message, targetModel, { reasoning = true } = {}) {
  const blocks = message.content ?? []
  const calls = blocks.filter((block) => block?.type === 'tool-call')
  const messageItem = (texts) => ({ type: 'message', role: 'assistant', content: texts.map((text) => ({ type: 'output_text', text })) })
  const callItem = (call) => ({
    type: 'function_call',
    call_id: String(call.id),
    name: call.name,
    arguments: call.arguments.length > 0 ? call.arguments : '{}',
  })

  const replay = readReplay(message, targetModel)
  if (replay === undefined) {
    const text = flattenText(blocks)
    // Reasoning blocks hold display summaries only; they are never sent back.
    return [...(text.length > 0 ? [messageItem([text])] : []), ...calls.map(callItem)]
  }

  const items = []
  const texts = blocks.filter((block) => block?.type === 'text').map((block) => (typeof block.text === 'string' ? block.text : ''))
  let nextText = 0
  const pushMessage = (count) => {
    const parts = texts.slice(nextText, nextText + count).filter((text) => text.length > 0)
    nextText = Math.min(texts.length, nextText + count)
    if (parts.length > 0) items.push(messageItem(parts))
  }
  const pending = new Map(calls.map((call) => [String(call.id), call]))
  for (const entry of replay) {
    if (entry.kind === 'item') {
      if (entry.item.type === 'reasoning' && !reasoning) continue
      const { id: _id, ...item } = entry.item
      items.push(item)
    } else if (entry.kind === 'message') {
      // An entry without a part count stands for one text part.
      pushMessage(entry.parts ?? 1)
    } else {
      const call = pending.get(entry.callId)
      if (call !== undefined) {
        items.push(callItem(call))
        pending.delete(entry.callId)
      }
    }
  }
  pushMessage(texts.length - nextText)
  for (const call of pending.values()) items.push(callItem(call))
  while (items.length > 0 && items[items.length - 1].type === 'reasoning') items.pop()
  return items
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
 * @param policy - replay policy passed to {@link assistantItems}.
 * @returns instruction text plus the ordered input items.
 */
export function toResponsesInput(options, policy = {}) {
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
      input.push(...assistantItems(message, options.model, policy))
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
 *
 * With hosted search on, the backend's own `web_search` tool is appended (the
 * one Codex uses on the same subscription) and any harness function tool named
 * `web_search` is withheld, so the model sees one search tool, not two with the
 * same name. Hosted search is added only to requests that already carry tools:
 * title generation and other tool-less calls stay tool-less.
 *
 * @param tools - harness tool schemas.
 * @param hosted - `{ webSearch: 'live' | 'cached' | 'off' }`.
 * @returns backend tool descriptors.
 */
export function toResponsesTools(tools, hosted = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const webSearch = hosted.webSearch ?? 'off'
  const functions = tools
    .filter((tool) => webSearch === 'off' || tool.name !== 'web_search')
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      // Tool arguments are streamed as partial JSON; the backend requires
      // explicit acknowledgement that raw string fragments are acceptable.
      strict: false,
    }))
  if (webSearch === 'off') return functions
  // `external_web_access` false restricts search to the backend's cached index.
  return [...functions, { type: 'web_search', external_web_access: webSearch === 'live' }]
}

/**
 * Rebuild the final input array with images attached.
 *
 * Runs after {@link projectImages}, reading the `resolved` marker that step
 * attached. Kept separate so the text-only path stays synchronous.
 *
 * @param options - a request whose image blocks carry `resolved` payloads.
 * @param policy - replay policy passed to {@link assistantItems}.
 * @returns instruction text plus input items including `input_image` parts.
 */
export function toResponsesInputWithImages(options, policy = {}) {
  const base = toResponsesInput(options, policy)
  // Re-walk in parallel with the base result so image parts land in order.
  const input = []
  let cursor = 0
  for (const message of options.messages ?? []) {
    if (message.role === 'system') continue
    const hasImages = (message.content ?? []).some((block) => block?.type === 'image' && block.resolved !== undefined)
    if (!hasImages) {
      // Consume the base items this message produced.
      const produced = countItemsFor(message, options.model, policy)
      for (let i = 0; i < produced; i++) input.push(base.input[cursor++])
      continue
    }
    // Rebuild this message's items with image parts included.
    const items = itemsFor(message, options.model, policy)
    cursor += countItemsFor(message, options.model, policy)
    input.push(...items)
  }
  // Anything left over (defensive) keeps the base ordering intact.
  while (cursor < base.input.length) input.push(base.input[cursor++])
  return { instructions: base.instructions, input }
}

/**
 * How many Responses items one harness message produces.
 * @param message - a harness message.
 * @param model - the target model, which decides whether replay items are included.
 * @param policy - replay policy passed to {@link assistantItems}.
 * @returns the item count, mirroring {@link toResponsesInput}.
 */
function countItemsFor(message, model, policy) {
  if (message.role === 'assistant') return assistantItems(message, model, policy).length
  if (message.role === 'tool') return 1
  if (message.role === 'developer') return developerItem(message) === undefined ? 0 : 1
  const results = (message.content ?? []).filter((block) => block?.type === 'tool-result').length
  const regular = (message.content ?? []).filter((block) => block?.type !== 'tool-result' && block?.type !== 'reasoning')
  return results + (regular.length > 0 ? 1 : 0)
}

/**
 * Build the Responses items for one harness message, including image parts.
 * @param message - a harness message whose image blocks carry `resolved`.
 * @param model - the target model, which decides whether replay items are included.
 * @param policy - replay policy passed to {@link assistantItems}.
 * @returns the item list for that message.
 */
function itemsFor(message, model, policy) {
  const items = []
  if (message.role === 'assistant') return assistantItems(message, model, policy)
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
