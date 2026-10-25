/**
 * Turn a Responses SSE event stream into harness `StreamChunk`s.
 *
 * The harness consumes an interleaved, index-addressed chunk protocol:
 * `block-start` opens a block, deltas append to it, `block-end` carries the
 * assembled result, and exactly one `finish` terminates the stream.
 *
 * The Responses API streams something structurally different — a flat sequence
 * of typed events, where each output item has its own `output_index` and text
 * arrives as `response.output_text.delta` with a `content_index` *within* that
 * item. Reasoning arrives on a separate channel (`response.reasoning_summary_*`)
 * and must become its own block so the harness can render it distinctly.
 *
 * The mapping therefore maintains one harness block per (item, content) pair
 * and assigns harness indexes itself, because reasoning-summary events and text
 * events share an item index but are different blocks.
 *
 * ## Tolerance for key naming and event-name drift
 *
 * The backend's event names and key spellings could not be fully confirmed
 * against a successful live turn while this plugin was written (the subscription
 * was rate-limited throughout). The shipped client was inspected instead, and it
 * showed **both conventions in play**: the upstream Responses wire spells fields
 * snake_case (`item_id`, `content_index`), while Codex's own app-server protocol
 * spells them camelCase (`itemId`, `contentIndex`).
 *
 * Rather than bet on one, every field is read under either spelling (see
 * {@link field}), and an unrecognized event is dispatched by *shape*: an event
 * carrying a string `delta` is classified by whether its name mentions
 * reasoning, arguments, or text; one carrying a terminal `response` ends the
 * turn; one carrying an `error` surfaces it; one carrying a full `item.message`
 * yields its text. An unknown name still falls through harmlessly.
 *
 * This matters because the failure is silent: keying off the wrong spelling
 * would make every block resolve to the same `undefined` identity, collapsing a
 * whole turn's output into one block rather than failing loudly.
 *
 * @module dsh-codex-provider/stream
 */
import { LlmError } from './llm-error.js'
import { replayEnvelope, toFinishReason, toTokenUsage } from './convert.js'

/**
 * Read a field under either naming convention.
 *
 * The two layers in play disagree on spelling: the upstream Responses wire uses
 * snake_case (`item_id`, `content_index`), while Codex's own app-server protocol
 * uses camelCase (`itemId`, `contentIndex`) — both spellings are present in the
 * shipped client. The plugin consumes the upstream wire, but which convention
 * that wire uses could not be confirmed against a successful live turn, and
 * guessing wrong is not a loud failure: every block would key off `undefined`
 * and an entire turn's text would collapse into a single block.
 *
 * Reading both costs one property lookup and removes that failure mode.
 *
 * @param event - the event to read from.
 * @param names - candidate field names, most likely first.
 * @returns the first present, non-null value, or undefined.
 */
function field(event, ...names) {
  for (const name of names) {
    const value = event?.[name]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * Identity of the output item an event belongs to.
 * @param event - a Responses event.
 * @returns the item id, or the output index when no id is carried.
 */
function itemKey(event) {
  return field(event, 'item_id', 'itemId', 'output_index', 'outputIndex')
}

/**
 * Identity of the output item an `item` payload describes.
 * @param item - a Responses output item.
 * @param event - the carrying event, for its output index fallback.
 * @returns the item id, or the output index.
 */
function itemKeyOf(item, event) {
  return field(item, 'id', 'item_id', 'itemId') ?? field(event, 'output_index', 'outputIndex')
}

/**
 * The content-part index within an item.
 * @param event - a Responses event.
 * @returns the index, defaulting to 0.
 */
function contentKey(event) {
  return field(event, 'content_index', 'contentIndex') ?? 0
}

/**
 * The call id a function-call event refers to.
 * @param payload - an item or event carrying call identity.
 * @returns the call id as a string.
 */
function callKey(payload) {
  return String(field(payload, 'call_id', 'callId', 'id', 'item_id', 'itemId') ?? '')
}

/**
 * Incrementally convert Responses events into harness chunks.
 *
 * Usage note: feed events with {@link push}, then call {@link end} to obtain the
 * terminal chunk. Every method returns the chunks produced by that input.
 */
export class StreamTranslator {
  #blocks = new Map()
  #nextIndex = 0
  #usage
  #response
  #failure
  #sawToolCall = false
  #sawContent = false
  #model
  /** Output items in order, for the replay envelope (see `replayEnvelope`). */
  #replay = []
  #hasReplayItems = false

  /**
   * @param options - `{ model }`: the requested model id, recorded in the replay
   *   envelope so later requests replay reasoning only to the model that wrote it.
   */
  constructor(options = {}) {
    this.#model = options.model
  }
  /** Accumulated text per block, so a block can be closed even without a `done` event. */
  #acc = new Map()

  /**
   * Allocate a harness block index for one Responses output item.
   * @param key - stable key identifying the block within the response.
   * @param kind - the harness block type to open.
   * @returns the assigned index and the `block-start` chunk.
   */
  #open(key, kind) {
    const existing = this.#blocks.get(key)
    if (existing !== undefined) return { index: existing, start: undefined }
    const index = this.#nextIndex++
    this.#blocks.set(key, index)
    this.#acc.set(index, { key, kind, text: '', callId: '', name: '', args: '', closed: false })
    return { index, start: { type: 'block-start', index, blockType: kind } }
  }

  /**
   * Accumulate a delta against its block so a dangling block can still be
   * closed with the right assembled content.
   * @param index - the block index.
   * @param field - which accumulator to extend.
   * @param value - the delta text.
   */
  #accumulate(index, field, value) {
    const state = this.#acc.get(index)
    if (state !== undefined) state[field] += value
  }

  /**
   * Mark a block closed so {@link end} does not close it a second time.
   * @param index - the block index.
   */
  #markClosed(index) {
    const state = this.#acc.get(index)
    if (state !== undefined) state.closed = true
  }

  /**
   * Feed one parsed Responses event.
   * @param event - a parsed SSE payload.
   * @returns the harness chunks this event produced.
   */
  push(event) {
    const chunks = []
    if (event === null || typeof event !== 'object') return chunks

    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        if (event.response !== undefined) this.#response = event.response
        break

      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call') {
          this.#sawToolCall = true
          const { index, start } = this.#open(`call:${itemKeyOf(item, event)}`, 'tool-call')
          if (start !== undefined) chunks.push(start)
        } else if (item?.type === 'reasoning') {
          // Announced but potentially silent; the first delta opens the block so
          // an empty reasoning item produces no spurious block.
        }
        break
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const text = typeof event.delta === 'string' ? event.delta : ''
        if (text.length === 0) break
        const key = `reasoning:${itemKey(event)}`
        const { index, start } = this.#open(key, 'reasoning')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#accumulate(index, 'text', text)
        chunks.push({ type: 'reasoning-delta', index, text })
        break
      }

      case 'response.output_text.delta': {
        const text = typeof event.delta === 'string' ? event.delta : ''
        if (text.length === 0) break
        const key = `text:${itemKey(event)}:${contentKey(event)}`
        const { index, start } = this.#open(key, 'text')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#accumulate(index, 'text', text)
        chunks.push({ type: 'text-delta', index, text })
        break
      }

      case 'response.function_call_arguments.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        const key = `call:${itemKey(event)}`
        const { index, start } = this.#open(key, 'tool-call')
        if (start !== undefined) chunks.push(start)
        const callId = callKey(event) || String(itemKey(event) ?? '')
        this.#accumulate(index, 'args', delta)
        const state = this.#acc.get(index)
        if (state !== undefined && state.callId.length === 0) state.callId = callId
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: callId,
          argumentsDelta: delta,
        })
        break
      }

      case 'response.output_item.done': {
        const item = event.item
        if (item?.type === 'function_call') {
          // A stream may deliver only `done` for a call (no `added`), and a call
          // is content: record it before opening the block so the turn is not
          // mistaken for an empty response.
          this.#sawToolCall = true
          const key = `call:${itemKeyOf(item, event) ?? callKey(item)}`
          const { index, start } = this.#open(key, 'tool-call')
          if (start !== undefined) chunks.push(start)
          this.#markClosed(index)
          this.#replay.push({ kind: 'call', callId: callKey(item) })
          chunks.push({
            type: 'block-end',
            index,
            block: {
              type: 'tool-call',
              id: callKey(item),
              name: String(item.name ?? ''),
              arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
            },
          })
        } else if (item?.type === 'message') {
          // Close each text part with its assembled content.
          const parts = Array.isArray(item.content) ? item.content : []
          // The part count lets replay hand each message back its own text blocks.
          this.#replay.push({ kind: 'message', parts: parts.filter((part) => part?.type === 'output_text').length })
          parts.forEach((part, partIndex) => {
            if (part?.type !== 'output_text') return
            const key = `text:${itemKeyOf(item, event)}:${partIndex}`
            const { index, start } = this.#open(key, 'text')
            if (start !== undefined) chunks.push(start)
            this.#sawContent = true
            this.#markClosed(index)
            chunks.push({ type: 'block-end', index, block: { type: 'text', text: String(part.text ?? '') } })
          })
        } else if (item?.type === 'reasoning') {
          // Only an item carrying its encrypted payload is replayable; without
          // it the backend cannot reconstruct the reasoning.
          if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) {
            this.#hasReplayItems = true
            this.#replay.push({
              kind: 'item',
              item: {
                type: 'reasoning',
                summary: Array.isArray(item.summary)
                  ? item.summary
                  : typeof item.summary === 'string' && item.summary.length > 0 ? [{ type: 'summary_text', text: item.summary }] : [],
                encrypted_content: item.encrypted_content,
              },
            })
          }
          const summary = Array.isArray(item.summary)
            ? item.summary.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
            : typeof item.summary === 'string' ? item.summary : ''
          if (summary.length > 0) {
            const key = `reasoning:${itemKeyOf(item, event)}`
            const { index, start } = this.#open(key, 'reasoning')
            if (start !== undefined) chunks.push(start)
            this.#sawContent = true
            this.#markClosed(index)
            chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: summary } })
          }
        }
        break
      }

      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        if (event.response !== undefined) this.#response = event.response
        break
      }

      case 'response.error':
      case 'error': {
        const detail = event.error ?? event
        this.#failure = new LlmError(
          `dsh-codex-provider: the backend reported an error mid-stream (${detail?.message ?? 'no detail'})`,
          'PROVIDER_ERROR',
          { status: typeof detail?.status === 'number' ? detail.status : undefined },
        )
        break
      }

      default:
        // Shape-based fallback. Exact names are handled above; this catches a
        // renamed or newly-introduced variant by what the event *carries*
        // rather than what it is called, so a protocol revision degrades into
        // slightly-worse attribution instead of a silently empty turn.
        for (const chunk of this.#byShape(event)) chunks.push(chunk)
        break
    }
    return chunks
  }

  /**
   * Interpret an event whose exact name is not recognized, using its payload
   * shape and a coarse name classification.
   * @param event - the unrecognized event.
   * @returns any chunks it produced.
   */
  #byShape(event) {
    const chunks = []
    const type = typeof event.type === 'string' ? event.type : ''

    // A terminal response object, whatever the event was called.
    if (event.response !== undefined && typeof event.response === 'object') {
      const status = event.response.status
      if (status === 'completed' || status === 'incomplete' || status === 'failed' || status === 'cancelled') {
        if (this.#response === undefined) this.#response = event.response
      }
    }

    // An error carried in-band.
    if (this.#failure === undefined && event.error !== undefined && typeof event.error === 'object') {
      this.#failure = new LlmError(
        `dsh-codex-provider: the backend reported an error mid-stream (${event.error.message ?? 'no detail'})`,
        'PROVIDER_ERROR',
        { status: typeof event.error.status === 'number' ? event.error.status : undefined },
      )
    }

    // Cumulative text carried by an item rather than streamed as deltas.
    if (event.item?.type === 'message') {
      const parts = Array.isArray(event.item.content) ? event.item.content : []
      parts.forEach((part, partIndex) => {
        if (part?.type !== 'output_text' || typeof part.text !== 'string') return
        const key = `text:${itemKeyOf(event.item, event)}:${partIndex}`
        const { index, start } = this.#open(key, 'text')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#markClosed(index)
        chunks.push({ type: 'block-end', index, block: { type: 'text', text: part.text } })
      })
    }

    // A delta, classified by name.
    const delta = typeof event.delta === 'string' ? event.delta : undefined
    if (delta !== undefined && delta.length > 0) {
      const isReasoning = /reasoning|thinking|summary/i.test(type)
      const isArguments = /arguments|tool_call|function_call/i.test(type)
      if (isArguments) {
        // A call assembled purely from deltas is still a tool call; not
        // recording it here would let the turn be misreported as empty.
        this.#sawToolCall = true
        const key = `call:${itemKey(event)}`
        const { index, start } = this.#open(key, 'tool-call')
        if (start !== undefined) chunks.push(start)
        this.#accumulate(index, 'args', delta)
        const callId = callKey(event) || String(itemKey(event) ?? '')
        const state = this.#acc.get(index)
        if (state !== undefined && state.callId.length === 0) state.callId = callId
        chunks.push({ type: 'tool-call-delta', index, id: callId, argumentsDelta: delta })
      } else if (/output_text|text/i.test(type)) {
        const key = `text:${itemKey(event)}:${contentKey(event)}`
        const { index, start } = this.#open(key, 'text')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#accumulate(index, 'text', delta)
        chunks.push({ type: 'text-delta', index, text: delta })
      } else if (isReasoning) {
        const key = `reasoning:${itemKey(event)}`
        const { index, start } = this.#open(key, 'reasoning')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#accumulate(index, 'text', delta)
        chunks.push({ type: 'reasoning-delta', index, text: delta })
      }
    }
    return chunks
  }

  /**
   * Close the stream and produce the terminal chunks.
   *
   * Emits `block-end` for any block that never received one (the backend can
   * end a stream without an `output_item.done` for every item), then usage and
   * exactly one finish chunk.
   *
   * @returns the closing chunks.
   */
  end() {
    const chunks = []
    if (this.#failure !== undefined) {
      chunks.push({ type: 'finish', reason: { kind: 'error', failure: this.#failure.failure } })
      return chunks
    }

    // Close every block the backend opened but never closed. A stream can end
    // without an `output_item.done` for each item, and the harness assembles a
    // message from `block-end` — leaving one open would silently drop content.
    for (const [index, state] of this.#acc) {
      if (state.closed) continue
      state.closed = true
      if (state.kind === 'text') {
        chunks.push({ type: 'block-end', index, block: { type: 'text', text: state.text } })
      } else if (state.kind === 'reasoning') {
        chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: state.text } })
      } else if (state.kind === 'tool-call') {
        chunks.push({
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: state.callId, name: state.name, arguments: state.args.length > 0 ? state.args : '{}' },
        })
      }
    }

    const usage = toTokenUsage(this.#response?.usage)
    if (usage !== undefined) chunks.push({ type: 'usage', usage })

    if (this.#response === undefined) {
      chunks.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'dsh-codex-provider: the response stream ended without a terminal event', code: 'TRANSPORT' },
        },
      })
      return chunks
    }

    const reason = toFinishReason(this.#response)
    // A response that produced no blocks at all is a degenerate completion; the
    // harness treats it as a retryable failure rather than an empty turn.
    if (reason.kind === 'stop' && !this.#sawContent && !this.#sawToolCall) {
      chunks.push({
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'dsh-codex-provider: the model returned an empty response', code: 'EMPTY_RESPONSE' } },
      })
      return chunks
    }
    // A tool-call turn must not claim a plain stop; the loop routes on this.
    if (reason.kind === 'stop' && this.#sawToolCall) {
      chunks.push(this.#finish({ kind: 'tool-calls' }))
      return chunks
    }
    chunks.push(this.#finish(reason))
    return chunks
  }

  /**
   * A successful finish chunk, carrying the replay envelope when the response
   * produced items the harness cannot represent as blocks.
   * @param reason - the finish reason.
   * @returns the finish chunk.
   */
  #finish(reason) {
    if (!this.#hasReplayItems || this.#model === undefined) return { type: 'finish', reason }
    return { type: 'finish', reason, replayState: replayEnvelope(this.#model, this.#replay) }
  }

  /** The replay entries recorded so far, in output order (for tests and diagnostics). */
  get replayItems() {
    return this.#replay
  }

  /** Whether the response produced any tool call. */
  get sawToolCall() {
    return this.#sawToolCall
  }
}
