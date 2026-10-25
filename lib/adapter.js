/**
 * The Codex LLM adapter.
 *
 * Implements the harness `LlmAdapter` contract on top of the ChatGPT Codex
 * backend. It is a direct-fetch adapter: the request is built by
 * `./convert.js`, sent by `./transport.js`, and the SSE stream is translated by
 * `./stream.js`. No provider SDK is involved, because the subscription backend
 * is not reachable through the standard OpenAI client configuration.
 *
 * @module dsh-codex-provider/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { CodexCatalog, reasoningInfo } from './catalog.js'
import { LlmError, isContextWindowExceeded, isQuotaExceeded } from './llm-error.js'
import { codexRequest } from './transport.js'
import { projectImages, toRequestError, toResponsesInput, toResponsesInputWithImages, toResponsesTools } from './convert.js'
import { StreamTranslator } from './stream.js'

/** Route this adapter serves. */
export const PROVIDER_ID = 'codex'
/** Route used when another adapter already owns {@link PROVIDER_ID}. */
export const FALLBACK_PROVIDER_ID = 'codex-provider'
/** Display name for selectors and diagnostics. */
export const DISPLAY_NAME = 'Codex (ChatGPT)'

/**
 * Whether a message list contains a non-offloaded image.
 * @param messages - harness messages.
 * @returns true when at least one image must be projected.
 */
function containsImage(messages) {
  return (messages ?? []).some((message) => (message.content ?? []).some((block) => block?.type === 'image' && block.offloaded !== true))
}

/**
 * The adapter serving the Codex route.
 *
 * Extends the harness `LlmAdapter` base so the inherited `prepareCall` binds one
 * catalog generation's model metadata to the stream that follows it — without
 * that, a settings change landing between model resolution and dispatch could
 * pair one generation's capabilities with another's endpoint.
 *
 * Every dynamic fact — configuration, credential, catalog — is read through a
 * callback at call time rather than captured at construction, so a settings
 * change reaches the next request without a restart.
 */
export class CodexAdapter extends LlmAdapter {
  #options
  #catalog
  #route

  /**
   * @param options - adapter wiring.
   * @param options.config - current configuration.
   * @param options.resolveCredential - supplies the token and account id.
   * @param options.imageAccess - attachment access for image projection.
   * @param options.onCatalogResolved - observer for catalog resolutions.
   * @param options.onReplayDegrade - observer for unusable replay state.
   */
  constructor(options) {
    super()
    this.#options = options
    this.#route = PROVIDER_ID
    this.#catalog = new CodexCatalog({
      baseURL: options.config().baseURL,
      resolveCredential: options.resolveCredential,
      refreshMs: (options.config().refreshMinutes ?? 5) * 60_000,
      onResolved: options.onCatalogResolved,
      // Configuration may pin a version; otherwise the catalog discovers the
      // locally installed Codex version, which is what the backend validates.
      clientVersion: () => options.config().clientVersion,
      discoverVersion: options.discoverClientVersion,
      onOriginFailover: options.onOriginFailover,
    })
  }

  /** The route this adapter currently serves. */
  get route() {
    return this.#route
  }

  /**
   * Point the adapter at the route it actually claimed.
   * @param value - the provider route that registered successfully.
   */
  set route(value) {
    this.#route = value
  }

  /**
   * Describe this provider to the harness.
   * @param provider - the registered route.
   * @returns display metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME }
  }

  /**
   * Retry policy is owned by the agent recovery layer, so this adapter declares
   * none and lets the harness defaults apply.
   * @returns undefined.
   */
  providerRetryPolicy() {
    return undefined
  }

  /**
   * Report image request pricing? The subscription is not billed per token, so
   * there is no meaningful per-image price to declare.
   * @returns undefined.
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * List the models this route serves.
   * @returns catalog entries in backend order.
   */
  async listModels() {
    const snapshot = await this.#catalog.snapshot()
    return [...snapshot.models.values()].map((model) => ({
      provider: this.#route,
      id: model.id,
      name: model.name,
      ...(model.description !== undefined ? { description: model.description } : {}),
      inputModalities: [...model.input],
    }))
  }

  /**
   * Resolve full metadata for one exact model.
   * @param provider - the registered route.
   * @param model - model id.
   * @returns resolved model metadata.
   * @throws LlmError with `UNKNOWN_MODEL` when the catalog does not carry it.
   */
  async resolveModel(_provider, model) {
    const snapshot = await this.#catalog.snapshot()
    const entry = snapshot.models.get(model)
    if (entry === undefined) {
      throw new LlmError(
        `dsh-codex-provider: the Codex backend does not serve a model named "${model}"`,
        'UNKNOWN_MODEL',
      )
    }
    return this.#modelInfo(entry)
  }

  /**
   * Describe one model: capacity, modalities, and the efforts it offers.
   * @param entry - normalized catalog entry.
   * @returns resolved model metadata.
   */
  #modelInfo(entry) {
    const reasoning = reasoningInfo(entry)
    return {
      provider: this.#route,
      id: entry.id,
      name: entry.name,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      inputModalities: [...entry.input],
      context: { contextWindow: entry.contextWindow },
      ...(reasoning !== undefined ? { reasoning } : {}),
      // The backend reads `instructions` as the complete system prompt, so a
      // mid-conversation prompt change is expressible without rewriting history.
      systemPromptUpdate: 'in-history',
    }
  }

  /**
   * Validate an explicit reasoning effort against the model's own levels.
   * @param entry - catalog entry.
   * @param effort - requested effort.
   * @returns the effort, or undefined when none was requested.
   * @throws LlmError with `UNSUPPORTED_REASONING_EFFORT` when the model has no such level.
   */
  #resolveEffort(entry, effort) {
    if (effort === undefined) return undefined
    const info = reasoningInfo(entry)
    if (info === undefined) {
      throw new LlmError(
        `dsh-codex-provider: model "${entry.id}" does not expose reasoning levels`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    if (!info.efforts.some((candidate) => candidate.id === effort)) {
      const available = info.efforts.map((candidate) => candidate.id).join(', ')
      throw new LlmError(
        `dsh-codex-provider: model "${entry.id}" does not support reasoning effort "${effort}" (available: ${available})`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return effort
  }

  /**
   * Stream one model call.
   *
   * The whole response is requested at once and translated as it arrives: the
   * transport reports each SSE frame to a callback, so chunks reach the harness
   * while the backend is still generating.
   *
   * @param options - the fully assembled request.
   * @returns harness chunks.
   */
  async *stream(options) {
    const config = this.#options.config()
    const snapshot = await this.#catalog.snapshot()
    const entry = snapshot.models.get(options.model)
    if (entry === undefined) {
      throw new LlmError(
        `dsh-codex-provider: the Codex backend does not serve a model named "${options.model}"`,
        'UNKNOWN_MODEL',
      )
    }

    // stop sequences have no equivalent in the Responses API; refusing is
    // better than silently ignoring a caller's generation constraint.
    if (options.stop !== undefined && options.stop.length > 0) {
      throw new LlmError('dsh-codex-provider does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }

    const effort = this.#resolveEffort(entry, options.reasoningEffort)

    const wantsImage = containsImage(options.messages)
    if (wantsImage && !entry.input.includes('image')) {
      throw new LlmError(`dsh-codex-provider: model "${entry.id}" does not accept image input`, 'UNSUPPORTED_CONTENT')
    }

    let projected = options
    if (wantsImage) {
      const access = this.#options.imageAccess
      if (access === undefined) {
        throw new LlmError(
          'dsh-codex-provider: image input requires the harness attachment service, which is not mounted',
          'UNSUPPORTED_CONTENT',
        )
      }
      projected = await projectImages(options, (attachment) => access.resolveInline(attachment))
    }

    const policy = { reasoning: config.replayReasoning }
    const converted = wantsImage ? toResponsesInputWithImages(projected, policy) : toResponsesInput(projected, policy)
    const tools = toResponsesTools(options.tools, { webSearch: config.webSearch })

    // Mirror Codex: a reasoning model gets a reasoning object whenever it can
    // reason (effort omitted = the model's default), asks for summaries, and —
    // because `store: false` keeps nothing server-side — asks for the encrypted
    // reasoning payload so the next step can replay it (see convert.js).
    const reasons = reasoningInfo(entry) !== undefined
    const summary = config.reasoningSummary === 'none' ? undefined : config.reasoningSummary
    const reasoning = reasons && (effort !== undefined || summary !== undefined)
      ? { ...(effort !== undefined ? { effort } : {}), ...(summary !== undefined ? { summary } : {}) }
      : undefined
    const cacheKey = config.promptCacheKey && options.sessionId !== undefined ? String(options.sessionId) : undefined

    const body = {
      model: entry.id,
      instructions: converted.instructions.length > 0 ? converted.instructions : undefined,
      input: converted.input,
      stream: true,
      // The subscription backend must not persist turns server-side.
      store: false,
      ...(tools !== undefined ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(reasons && config.replayReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
      ...(cacheKey !== undefined ? { prompt_cache_key: cacheKey } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
    }
    // `instructions: undefined` would serialize as null; drop the key instead.
    if (body.instructions === undefined) delete body.instructions

    const credential = await this.#options.resolveCredential()
    const translator = new StreamTranslator({ model: config.replayReasoning || config.webSearch !== 'off' ? options.model : undefined })
    const pending = []
    let streamError

    const response = await codexRequest({
      baseURL: config.baseURL,
      path: '/responses',
      method: 'POST',
      accessToken: credential.accessToken,
      accountId: credential.accountId,
      body: JSON.stringify(body),
      clientVersion: await this.#catalog.clientVersion(),
      sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
      signal: options.signal,
      timeoutMs: config.streamIdleTimeoutMs,
      onOriginFailover: this.#options.onOriginFailover,
      onSse: (payload) => {
        let event
        try {
          event = JSON.parse(payload)
        } catch {
          return
        }
        for (const chunk of translator.push(event)) pending.push(chunk)
      },
    })

    if (response.status !== 200) {
      // A credential rejection invalidates the cached token so the next call
      // re-reads the session instead of replaying the same failure.
      if (response.status === 401 || response.status === 403) this.#options.onAuthRejected?.()
      throw toRequestError(response.status, response.body, isQuotaExceeded, isContextWindowExceeded)
    }

    // The transport resolves once the body is fully read, so replay every chunk
    // it accumulated during the call, then close the stream.
    for (const chunk of pending) yield chunk
    for (const chunk of translator.end()) yield chunk
  }
}
