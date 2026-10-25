/**
 * Model catalog for the Codex backend.
 *
 * Unlike most OpenAI-compatible gateways, `/models` here returns rich,
 * authoritative metadata: context window, supported reasoning efforts, input
 * modalities, and a display name. The catalog therefore *is* the live listing,
 * and the curated table below is only a fallback for when the endpoint cannot
 * be reached — not the source of truth.
 *
 * @module dsh-codex-provider/catalog
 */
import { codexRequest, DEFAULT_BASE_URL, DEFAULT_CLIENT_VERSION } from './transport.js'

/**
 * Fallback description of the models this backend served when this plugin was
 * written. It exists so the model selector is never empty on a cold start or
 * an offline machine; a successful listing always replaces it.
 */
export const FALLBACK_MODELS = [
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 272000, maxContextWindow: 872000, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], input: ['text', 'image'] },
  { id: 'gpt-reserve', name: 'GPT-Reserve', contextWindow: 272000, maxContextWindow: 872000, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'], input: ['text', 'image'] },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 272000, maxContextWindow: 872000, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'], input: ['text', 'image'] },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 272000, maxContextWindow: 872000, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'], input: ['text', 'image'] },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 272000, maxContextWindow: 872000, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'], input: ['text', 'image'] },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, maxContextWindow: 872000, reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh'], input: ['text', 'image'] },
]

/** Human-readable effort names, keyed by the value the backend accepts. */
const EFFORT_NAMES = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
}

/**
 * Turn a model id into a readable name.
 *
 * Version segments and all-caps initialisms are preserved: `gpt-5.6-luna`
 * becomes `GPT-5.6-Luna`, not `Gpt-5.6-Luna`. The backend normally supplies
 * `display_name`, so this is only the fallback for an entry that omits one.
 * @param id - model slug.
 * @returns title-cased name preserving version segments and known initialisms.
 */
export function prettifyModelName(id) {
  const initialisms = new Set(['gpt', 'ai', 'llm', 'vl', 'ocr'])
  return String(id)
    .split('-')
    .map((part) => {
      if (/^[0-9]/.test(part)) return part
      if (initialisms.has(part.toLowerCase())) return part.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join('-')
}

/**
 * Convert one backend model entry into this plugin's catalog shape.
 *
 * Fields the backend omits fall back to conservative defaults rather than
 * being dropped: a model the user can select and correct beats a model that
 * silently never appears.
 * @param raw - one entry from the `/models` payload.
 * @returns the normalized catalog entry, or undefined when it carries no id.
 */
export function normalizeModel(raw) {
  const id = typeof raw?.slug === 'string' && raw.slug.length > 0
    ? raw.slug
    : typeof raw?.id === 'string' && raw.id.length > 0 ? raw.id : undefined
  if (id === undefined) return undefined

  const efforts = Array.isArray(raw?.supported_reasoning_levels)
    ? raw.supported_reasoning_levels.map((level) => level?.effort).filter((level) => typeof level === 'string' && level.length > 0)
    : []
  const input = Array.isArray(raw?.input_modalities)
    ? raw.input_modalities.filter((m) => m === 'text' || m === 'image')
    : ['text']

  return {
    id,
    name: typeof raw?.display_name === 'string' && raw.display_name.length > 0 ? raw.display_name : prettifyModelName(id),
    description: typeof raw?.description === 'string' ? raw.description : undefined,
    contextWindow: Number.isFinite(raw?.context_window) && raw.context_window > 0 ? raw.context_window : 272000,
    maxContextWindow: Number.isFinite(raw?.max_context_window) && raw.max_context_window > 0 ? raw.max_context_window : undefined,
    reasoning: efforts.length > 0,
    efforts,
    defaultEffort: typeof raw?.default_reasoning_level === 'string' ? raw.default_reasoning_level : undefined,
    input: input.length > 0 ? input : ['text'],
    visibility: typeof raw?.visibility === 'string' ? raw.visibility : undefined,
  }
}

/**
 * Normalize a whole `/models` payload.
 * @param payload - parsed response body.
 * @returns catalog entries, in the order the backend reported them.
 */
export function normalizeCatalog(payload) {
  const list = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : []
  return list.map(normalizeModel).filter((model) => model !== undefined)
}

/**
 * Parse a `Retry-After`-style reset hint into milliseconds from now.
 * @param seconds - seconds until reset.
 * @returns milliseconds, or undefined when not a positive finite number.
 */
export function retryAfterMs(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

/**
 * A catalog snapshot: the models this route currently serves.
 * @typedef {object} CatalogSnapshot
 * @property {Map<string, object>} models - entries keyed by model id.
 * @property {boolean} live - whether the listing came from the endpoint.
 * @property {number} listed - how many models the endpoint advertised.
 * @property {Error} [error] - why the live listing failed, when it did.
 */

/**
 * Resolve and cache the model catalog.
 *
 * The backend's listing is authoritative but costs a round trip, so a snapshot
 * is reused for `refreshMs` before being re-fetched. A failed refresh keeps the
 * last good snapshot rather than emptying the selector.
 */
export class CodexCatalog {
  #resolveCredential
  #refreshMs
  #fallback
  #snapshot
  #inflight
  #onResolved
  #now
  #clientVersion
  #discoverVersion
  #baseURL
  #onOriginFailover

  /**
   * @param options - catalog wiring.
   * @param options.resolveCredential - supplies the access token and account id.
   * @param options.baseURL - backend origin; defaults to the Codex endpoint.
   * @param options.refreshMs - how long a snapshot stays fresh.
   * @param options.fallback - entries used when the endpoint cannot be reached.
   * @param options.onResolved - observer for each resolution.
   * @param options.now - clock, injectable for tests.
   * @param options.clientVersion - explicit version from configuration; wins when set.
   * @param options.discoverVersion - supplies a version discovered from the
   *   local Codex install, used when configuration names none.
   */
  constructor(options) {
    this.#resolveCredential = options.resolveCredential
    this.#baseURL = options.baseURL ?? DEFAULT_BASE_URL
    this.#refreshMs = options.refreshMs ?? 300_000
    this.#fallback = options.fallback ?? FALLBACK_MODELS
    this.#onResolved = options.onResolved ?? (() => {})
    this.#now = options.now ?? (() => Date.now())
    this.#clientVersion = options.clientVersion
    this.#discoverVersion = options.discoverVersion
    this.#onOriginFailover = options.onOriginFailover
  }

  /**
   * The client version to report.
   *
   * Explicit configuration wins; otherwise the locally installed Codex version
   * is discovered once and cached, because the backend rejects a value it
   * considers stale and a hardcoded literal would age out silently.
   * @returns the version string to send.
   */
  async #version() {
    if (typeof this.#clientVersion === 'function') {
      const configured = this.#clientVersion()
      if (typeof configured === 'string' && configured.length > 0) return configured
    } else if (typeof this.#clientVersion === 'string' && this.#clientVersion.length > 0) {
      return this.#clientVersion
    }
    if (this.#discovered === undefined && this.#discoverVersion !== undefined) {
      this.#discovered = (await this.#discoverVersion()) ?? null
    }
    return this.#discovered ?? DEFAULT_CLIENT_VERSION
  }

  /**
   * The client version requests should report — the same value the catalog
   * route sends. Model requests must report it too: the backend gates newer
   * models by client version, so a stale literal on `/responses` gets a model
   * the catalog just listed refused as unsupported.
   * @returns the version string.
   */
  clientVersion() {
    return this.#version()
  }

  /** Version discovered from the local install; `null` records a failed lookup. */
  #discovered

  /**
   * Return a catalog snapshot, fetching when the cache is stale.
   * @param options - refresh controls.
   * @param options.force - bypass the freshness check.
   * @param options.signal - cancellation.
   * @returns the snapshot.
   */
  async snapshot(options = {}) {
    const fresh = this.#snapshot !== undefined && !options.force && this.#snapshot.expiresAt > this.#now()
    if (fresh) return this.#snapshot
    this.#inflight ??= this.#resolve(options).finally(() => {
      this.#inflight = undefined
    })
    return this.#inflight
  }

  /**
   * Fetch the live listing, falling back to the curated table on failure.
   * @param options - cancellation.
   * @returns the new snapshot.
   */
  async #resolve(options) {
    const fallbackSnapshot = () => ({
      models: new Map(this.#fallback.map((model) => [model.id, { ...model }])),
      live: false,
      listed: 0,
      error: undefined,
      expiresAt: this.#now() + this.#refreshMs,
    })

    let credential
    try {
      credential = await this.#resolveCredential()
    } catch (error) {
      // No credential is fatal for requests but not for listing: showing the
      // curated table lets the user pick a model and see the real error later.
      const snapshot = { ...fallbackSnapshot(), error }
      this.#snapshot = snapshot
      this.#onResolved(snapshot)
      return snapshot
    }

    try {
      // The catalog route REQUIRES `client_version`; omitting it is a 400.
      const clientVersion = await this.#version()
      const response = await codexRequest({
        baseURL: this.#baseURL,
        path: `/models?client_version=${encodeURIComponent(clientVersion)}`,
        method: 'GET',
        accessToken: credential.accessToken,
        accountId: credential.accountId,
        signal: options.signal,
        timeoutMs: 30_000,
        clientVersion,
        onOriginFailover: this.#onOriginFailover,
      })
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.body.slice(0, 200)}`)
      }
      const models = normalizeCatalog(JSON.parse(response.body))
      if (models.length === 0) throw new Error('the listing contained no models')
      const snapshot = {
        models: new Map(models.map((model) => [model.id, model])),
        live: true,
        listed: models.length,
        expiresAt: this.#now() + this.#refreshMs,
      }
      this.#snapshot = snapshot
      this.#onResolved(snapshot)
      return snapshot
    } catch (error) {
      // A stale-but-real catalog beats the curated table; only fall back when
      // nothing has ever been fetched.
      if (this.#snapshot?.live === true) {
        const snapshot = { ...this.#snapshot, expiresAt: this.#now() + 30_000, error }
        this.#snapshot = snapshot
        this.#onResolved(snapshot)
        return snapshot
      }
      const snapshot = { ...fallbackSnapshot(), error }
      this.#snapshot = snapshot
      this.#onResolved(snapshot)
      return snapshot
    }
  }
}

/**
 * Describe the selectable reasoning efforts for one model.
 * @param model - a normalized catalog entry.
 * @returns effort descriptors in the backend's order, or undefined when the model has none.
 */
export function reasoningInfo(model) {
  if (model.reasoning !== true || !Array.isArray(model.efforts) || model.efforts.length === 0) return undefined
  return {
    efforts: model.efforts.map((effort) => ({
      id: effort,
      name: EFFORT_NAMES[effort] ?? effort,
    })),
    ...(typeof model.defaultEffort === 'string' && model.efforts.includes(model.defaultEffort)
      ? { defaultEffort: model.defaultEffort }
      : {}),
  }
}
