/**
 * Configuration schema for the Codex provider.
 *
 * The composition entry in `cordis.yml` is the base layer; a stored section
 * under the `llm-codex` namespace overrides it field by field. Every field has
 * a working default, so the plugin is usable the moment it is mounted.
 *
 * @module dsh-codex-provider/config
 */
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_BASE_URL } from './transport.js'

/**
 * Reject a base URL the transport cannot use.
 * @param value - candidate base URL.
 * @returns the normalized URL without a trailing slash.
 * @throws TypeError when it is not an absolute http(s) URL.
 */
export function assertBaseURL(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`llm-codex: baseURL must be an absolute URL, got "${value}"`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`llm-codex: baseURL must use http or https, got "${url.protocol}"`)
  }
  return url.toString().replace(/\/+$/, '')
}

/** Settings schema for the `llm-codex` namespace. */
export const Config = Schema.object({
  /** Whether the route is registered. `false` withdraws it while keeping the plugin mounted. */
  enabled: Schema.boolean().default(true),
  /**
   * Backend origin. The Codex CLI's own endpoint is the default; overriding it
   * is how a user points the plugin at a compatible gateway instead.
   */
  baseURL: Schema.string().default(DEFAULT_BASE_URL),
  /**
   * How long a resolved model catalog stays fresh before it is re-fetched.
   * The backend rotates model availability without notice, so a shorter
   * interval surfaces new models sooner at the cost of one request.
   */
  refreshMinutes: Schema.number().min(1).max(1440).default(5),
  /**
   * Idle timeout for one model stream. A subscription backend can pause while
   * it queues a request, so this is generous, but a genuinely dead connection
   * must not hang a turn forever.
   */
  streamIdleTimeoutMs: Schema.number().min(1000).max(600000).default(120000),
  /** Maximum encoded bytes for one request image after re-encoding. */
  maxRequestImageBytes: Schema.number().min(1024).max(20 * 1024 * 1024).default(4 * 1024 * 1024),
  /**
   * Models to advertise even when the live listing omits them. Useful when a
   * rollout stages a model behind the account, or when an offline machine must
   * still show a selectable entry.
   */
  catalogAdditions: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    contextWindow: Schema.number(),
  })).default([]),
  /**
   * Codex client version reported to the backend.
   *
   * The catalog route requires this and the backend validates it, so an empty
   * value means "discover it from the local Codex install" — which keeps the
   * plugin in step across Codex upgrades. Set it explicitly only to pin a
   * version the backend accepts when discovery reports one it refuses.
   */
  clientVersion: Schema.string().default(''),
  /**
   * Accepted for symmetry with other provider plugins; this route reads its
   * credential from the Codex session, never from a stored key.
   */
  apiKeyEnv: Schema.string().default(''),
  /**
   * Request the encrypted reasoning payload and replay it on later steps, as
   * Codex does. Without it the model re-derives its reasoning on every tool step.
   */
  replayReasoning: Schema.boolean().default(true),
  /** Reasoning summary detail requested from the backend; `none` requests none. */
  reasoningSummary: Schema.union(['auto', 'concise', 'detailed', 'none']).default('auto'),
  /** Send the harness session id as `prompt_cache_key`, as Codex does. */
  promptCacheKey: Schema.boolean().default(true),
})

export default Config
