/**
 * HTTP transport for the ChatGPT Codex backend.
 *
 * Two facts shape this module:
 *
 * 1. **The endpoint is not `api.openai.com`.** Subscription models are served
 *    from `chatgpt.com/backend-api/codex`, which speaks the Responses API and
 *    requires a `chatgpt-account-id` header. Probing showed that header is
 *    advisory on the routes this plugin uses, but it is sent because the Codex
 *    CLI sends it and the backend may begin validating it at any time.
 *
 * 2. **Node's global `fetch` cannot reach it on a censored network.** The host
 *    resolves `chatgpt.com` to a poisoned address, and `fetch` ignores
 *    `HTTPS_PROXY` unless a dispatcher is installed. Rather than depend on an
 *    optional proxy-agent package, this module performs the HTTP CONNECT
 *    handshake itself and speaks HTTP/1.1 over the resulting TLS socket. With
 *    no proxy configured it connects directly.
 *
 * @module dsh-codex-provider/transport
 */
import net from 'node:net'
import tls from 'node:tls'
import { StringDecoder } from 'node:string_decoder'
import { LlmError } from './llm-error.js'

/** Default Codex backend origin. */
export const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
/**
 * Alternate origins serving the same API.
 *
 * The Codex CLI treats these as interchangeable backends for this endpoint, and
 * they are not always reachable at the same time: `chatgpt.com` has been
 * observed failing its TLS handshake through a proxy while `chat.openai.com`
 * answered normally. A request retries against these in order when the
 * configured origin is unreachable, so one host's outage does not take the
 * route down.
 */
export const ALTERNATE_BASE_URLS = ['https://chat.openai.com/backend-api/codex']
/** Origination tag the Codex backend expects; it routes subscription traffic by it. */
export const ORIGINATOR = 'codex_cli_rs'
/**
 * Client version reported to the backend, and sent as `client_version` on the
 * catalog route, which **requires** that query parameter.
 *
 * Overridable through configuration because the backend validates the value:
 * a version it considers too old is refused. Discovery from the local Codex
 * install is preferred, and this literal is only the last-resort default.
 */
export const DEFAULT_CLIENT_VERSION = '0.155.0'
/**
 * `OpenAI-Beta` value for the Responses channel.
 *
 * Probing showed this header is advisory on both the catalog and Responses
 * routes — the endpoint accepts any value, and accepts its absence. It is sent
 * because it matches what the Codex CLI itself sends (read out of the CLI
 * binary), so the request is indistinguishable from a first-party client.
 */
export const BETA_HEADER = 'responses_websockets=2026-02-06'

/**
 * Parse a proxy URL into connection coordinates.
 * @param value - `http://host:port`, `host:port`, or empty.
 * @returns proxy coordinates, or undefined when none is configured.
 */
export function parseProxy(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length === 0) return undefined
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    return undefined
  }
  const port = url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || url.hostname.length === 0) return undefined
  return {
    host: url.hostname,
    port,
    ...(url.username.length > 0 ? { auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` } : {}),
  }
}

/**
 * Choose the proxy for this process.
 *
 * `HTTPS_PROXY` wins because this endpoint is TLS; `ALL_PROXY` is the generic
 * fallback. `NO_PROXY` is honoured for the endpoint host.
 *
 * A loopback or private target is never proxied. A developer pointing
 * `baseURL` at a local gateway must not have that request sent through the
 * corporate or censorship proxy, which cannot reach their own machine and
 * would fail with an opaque connection error.
 *
 * @param env - environment to read.
 * @param host - endpoint host the request will target.
 * @returns proxy coordinates, or undefined for a direct connection.
 */
export function proxyFor(env = process.env, host = 'chatgpt.com') {
  if (isLocalHost(host)) return undefined
  const noProxy = typeof env.NO_PROXY === 'string' ? env.NO_PROXY : typeof env.no_proxy === 'string' ? env.no_proxy : ''
  if (noProxy.split(',').some((entry) => {
    const pattern = entry.trim()
    if (pattern === '*' || pattern === host) return true
    // NO_PROXY entries may be domain suffixes; a leading dot matches subdomains.
    if (pattern.startsWith('.') && host.endsWith(pattern)) return true
    return pattern.length > 0 && host.endsWith(`.${pattern}`)
  })) return undefined
  return parseProxy(env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy)
}

/**
 * Whether a host is loopback or otherwise local.
 * @param host - hostname or IP literal.
 * @returns true when the target is this machine.
 */
export function isLocalHost(host) {
  const value = typeof host === 'string' ? host.toLowerCase().replace(/^\[|\]$/g, '') : ''
  return value === 'localhost'
    || value === '::1'
    || value === '0.0.0.0'
    || value.endsWith('.localhost')
    || /^127\./.test(value)
}

/**
 * Open a TCP connection, then TLS when the target is https, optionally through
 * an HTTP proxy.
 *
 * TLS is applied only for `https:`. A plain-HTTP endpoint — a local gateway or
 * a test stub — must stay cleartext, and wrapping it in TLS would fail with an
 * opaque handshake error rather than an actionable one.
 *
 * The abort listener stays installed for the whole request rather than being
 * removed once the socket connects: a caller that cancels mid-stream must tear
 * the connection down immediately, not wait out the idle timeout.
 *
 * @param options - target host/port/scheme, proxy, and timeout.
 * @returns the connected socket plus `release`, which detaches the abort
 *   listener once the exchange has finished.
 */
async function connect({ host, port, secure, proxy, timeoutMs, signal }) {
  const onAbort = () => socket?.destroy(new Error('request aborted by caller'))
  let socket
  const guard = () => {
    if (signal?.aborted) throw new LlmError('dsh-codex-provider: request aborted by caller', 'ABORTED')
  }
  guard()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let raw
    try {
      raw = await new Promise((resolve, reject) => {
        const s = proxy === undefined
          ? net.connect(port, host, () => resolve(s))
          : net.connect(proxy.port, proxy.host, () => resolve(s))
        socket = s
        s.setTimeout(timeoutMs, () => s.destroy(new Error(`connect timeout after ${timeoutMs}ms`)))
        s.once('error', reject)
      })
    } catch (error) {
      // A raw Node socket error would otherwise reach the harness untyped; the
      // agent loop routes recovery on `code`, so every transport failure must
      // carry one.
      const target = proxy === undefined ? `${host}:${port}` : `proxy ${proxy.host}:${proxy.port}`
      throw new LlmError(
        `dsh-codex-provider: cannot reach ${target} (${error?.message ?? String(error)})`,
        error?.message?.includes('connect timeout') ? 'TIMEOUT' : 'TRANSPORT',
        { cause: error },
      )
    }
    raw.setTimeout(0)

    if (proxy !== undefined) {
      const headers = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`]
      if (proxy.auth !== undefined) headers.push(`Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}`)
      const line = await new Promise((resolve, reject) => {
        let buf = ''
        const onData = (chunk) => {
          buf += chunk.toString('latin1')
          const end = buf.indexOf('\r\n\r\n')
          if (end === -1) return
          raw.removeListener('data', onData)
          raw.removeListener('error', reject)
          // Bytes past the header block are already TLS; push them back so the
          // handshake sees a clean stream.
          const rest = buf.slice(end + 4)
          if (rest.length > 0) raw.unshift(Buffer.from(rest, 'latin1'))
          resolve(buf.slice(0, buf.indexOf('\r\n')))
        }
        raw.on('data', onData)
        raw.once('error', reject)
        raw.write(`${headers.join('\r\n')}\r\n\r\n`)
      })
      if (!/ 200 /.test(line)) {
        raw.destroy()
        const detail = line.replace(/^HTTP\/1\.[01]\s*/, '')
        throw new LlmError(
          `dsh-codex-provider: the proxy refused CONNECT to ${host}:${port} (${detail}). Check the HTTPS_PROXY setting.`,
          'PROXY_REJECTED',
        )
      }
    }

    if (!secure) {
      socket = raw
      return { socket: raw, release: () => signal?.removeEventListener('abort', onAbort) }
    }

    guard()
    const tlsSocket = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket: raw, servername: net.isIP(host) === 0 ? host : undefined, ALPNProtocols: ['http/1.1'] }, () => resolve(t))
      socket = t
      t.once('error', (error) => reject(new LlmError(
        `dsh-codex-provider: TLS handshake with ${host}:${port} failed (${error?.message ?? String(error)})`,
        'TRANSPORT',
        { cause: error },
      )))
    })
    return { socket: tlsSocket, release: () => signal?.removeEventListener('abort', onAbort) }
  } catch (error) {
    // A failed connect must not leave the listener attached.
    signal?.removeEventListener('abort', onAbort)
    throw error
  }
}

/**
 * One fully-buffered HTTP/1.1 response.
 * @typedef {object} HttpResponse
 * @property {number} status - HTTP status code.
 * @property {Record<string,string>} headers - lowercased response headers.
 * @property {string} body - decoded body, for non-streaming requests.
 */

/**
 * Write an HTTP/1.1 request and read its response, framing by
 * `content-length`, chunked transfer, or EOF.
 *
 * @param socket - connected TLS socket.
 * @param request - method, path, headers, and optional body.
 * @param handlers - optional per-SSE-data-line callback and idle timeout.
 * @returns the buffered response.
 */
function exchange(socket, request, handlers = {}) {
  const { method, path, headers, body } = request
  const idleMs = handlers.idleMs ?? 120_000
  return new Promise((resolve, reject) => {
    let headerBuf = Buffer.alloc(0)
    let dataBuf = Buffer.alloc(0)
    let phase = 'headers'
    let status = 0
    let responseHeaders = {}
    let text = ''
    let chunkLeft = -1
    let pending = ''
    let settled = false
    let idle
    // Chunked framing is parsed on a byte-preserving latin1 string, so body
    // bytes must be decoded as UTF-8 before they are emitted. A streaming
    // decoder keeps a multi-byte character split across two chunks intact.
    const decoder = new StringDecoder('utf8')

    const finish = (error) => {
      if (settled) return
      if (error === undefined) {
        const rest = decoder.end()
        if (rest.length > 0) emit(rest)
      }
      settled = true
      clearTimeout(idle)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('end', onEnd)
      if (error !== undefined) reject(error)
      else resolve({ status, headers: responseHeaders, body: text })
    }
    const bump = () => {
      clearTimeout(idle)
      idle = setTimeout(() => finish(new LlmError(`dsh-codex-provider: response stalled for ${idleMs}ms`, 'TIMEOUT')), idleMs)
    }
    const emit = (chunk) => {
      text += chunk
      if (handlers.onText !== undefined) handlers.onText(chunk)
    }
    const drainChunked = () => {
      for (;;) {
        if (chunkLeft < 0) {
          const nl = pending.indexOf('\r\n')
          if (nl === -1) return
          const size = parseInt(pending.slice(0, nl), 16)
          if (!Number.isFinite(size)) {
            finish(new LlmError('dsh-codex-provider: malformed chunked response', 'TRANSPORT'))
            return
          }
          pending = pending.slice(nl + 2)
          if (size === 0) {
            finish()
            return
          }
          chunkLeft = size
        }
        if (pending.length < chunkLeft + 2) return
        emit(decoder.write(Buffer.from(pending.slice(0, chunkLeft), 'latin1')))
        pending = pending.slice(chunkLeft + 2)
        chunkLeft = -1
      }
    }
    function onData(chunk) {
      bump()
      if (phase === 'headers') {
        headerBuf = Buffer.concat([headerBuf, chunk])
        const end = headerBuf.indexOf('\r\n\r\n')
        if (end === -1) return
        const lines = headerBuf.slice(0, end).toString('latin1').split('\r\n')
        status = Number(lines[0].split(' ')[1])
        for (const line of lines.slice(1)) {
          const idx = line.indexOf(':')
          if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
        }
        const tail = headerBuf.slice(end + 4)
        headerBuf = Buffer.alloc(0)
        if (/chunked/i.test(responseHeaders['transfer-encoding'] ?? '')) {
          phase = 'chunked'
          pending = tail.toString('latin1')
          drainChunked()
          return
        }
        if (responseHeaders['content-length'] !== undefined) {
          phase = 'length'
          dataBuf = Buffer.concat([dataBuf, tail])
          const need = Number(responseHeaders['content-length'])
          if (dataBuf.length >= need) {
            emit(dataBuf.slice(0, need).toString('utf8'))
            finish()
          }
          return
        }
        // No framing declared: the connection close delimits the body.
        phase = 'eof'
        if (tail.length > 0) emit(decoder.write(tail))
        return
      }
      if (phase === 'chunked') {
        pending += chunk.toString('latin1')
        drainChunked()
        return
      }
      if (phase === 'eof') {
        emit(decoder.write(chunk))
        return
      }
      dataBuf = Buffer.concat([dataBuf, chunk])
      const need = Number(responseHeaders['content-length'])
      if (dataBuf.length >= need) {
        emit(dataBuf.slice(0, need).toString('utf8'))
        finish()
      }
    }
    function onError(error) {
      finish(error instanceof LlmError ? error : new LlmError(`dsh-codex-provider: transport failure (${error?.message ?? String(error)})`, 'TRANSPORT'))
    }
    function onEnd() {
      finish()
    }

    // Listeners are attached before the request is written: a fast local peer
    // can answer within the same tick as `write`, and a listener attached
    // afterwards would miss the response entirely (the socket buffers it, but
    // no 'data' event fires for data that already arrived).
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('end', onEnd)
    idle = setTimeout(() => finish(new LlmError(`dsh-codex-provider: no response within ${idleMs}ms`, 'TIMEOUT')), idleMs)

    socket.write(`${method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    if (body !== undefined) socket.write(body)
  })
}

/**
 * Minimal Server-Sent Events reader over the response body.
 * @param text - a complete SSE body.
 * @returns the `data:` payloads in order, excluding `[DONE]`.
 */
export function parseSseBody(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length > 0 && payload !== '[DONE]') events.push(payload)
  }
  return events
}

/**
 * Call the Codex backend once.
 *
 * @param options - request description.
 * @param options.baseURL - backend origin.
 * @param options.path - path below the origin, beginning with `/`.
 * @param options.method - HTTP method.
 * @param options.accessToken - OAuth access token.
 * @param options.accountId - ChatGPT account id.
 * @param options.body - JSON body for POST requests.
 * @param options.sessionId - conversation id, sent for backend routing.
 * @param options.signal - caller cancellation.
 * @param options.onSse - invoked per SSE payload as it arrives; when supplied the
 *   call streams and resolves with the accumulated payloads.
 * @param options.proxy - proxy coordinates; defaults to the environment.
 * @param options.timeoutMs - connect and idle timeout.
 * @param options.env - environment for proxy resolution and attribution.
 * @returns status, headers, and either the body text or the SSE payloads.
 */
export async function codexRequest(options) {
  const { signal } = options

  // Try the configured origin, then any alternate that serves the same API.
  // Only a *connect* failure falls through; once a request reaches the wire its
  // response is the answer, however it reads.
  //
  // Failover applies ONLY to the built-in origins. A user who points `baseURL`
  // at a self-hosted gateway or a compatibility proxy means exactly that host:
  // silently redirecting their traffic to OpenAI's endpoint would be both
  // surprising and a data leak.
  const configured = options.baseURL ?? DEFAULT_BASE_URL
  const builtIn = configured === DEFAULT_BASE_URL || ALTERNATE_BASE_URLS.includes(configured)
  const origins = builtIn
    ? [configured, ...ALTERNATE_BASE_URLS.filter((u) => u !== configured)]
    : [configured]
  let lastError

  for (const origin of origins) {
    try {
      return await requestAgainstOrigin(origin, options)
    } catch (error) {
      if (signal?.aborted) throw error
      // A transport-level failure may be this host being unreachable rather
      // than a general outage, so the next origin is worth trying. Anything
      // else (a typed provider failure) is authoritative and propagates.
      const retryable = error?.code === 'TRANSPORT' || error?.code === 'TIMEOUT'
      if (!retryable) throw error
      lastError = error
      if (origin !== origins[origins.length - 1]) {
        // Reported rather than silent: a host that stops answering is worth
        // seeing in the log even when the fallback rescues the request.
        options.onOriginFailover?.(origin, error)
      }
    }
  }
  throw lastError
}

/**
 * Send one request against one origin.
 * @param baseURL - origin to target.
 * @param options - the full request, as passed to {@link codexRequest}.
 * @returns status, headers, body, and any SSE payloads.
 */
async function requestAgainstOrigin(baseURL, options) {
  const {
    path,
    method = 'POST',
    accessToken,
    accountId,
    body,
    sessionId,
    signal,
    onSse,
    timeoutMs = 120_000,
    env = process.env,
    extraHeaders,
    clientVersion = DEFAULT_CLIENT_VERSION,
  } = options

  const url = new URL(baseURL)
  const host = url.hostname
  const secure = url.protocol === 'https:'
  const port = url.port.length > 0 ? Number(url.port) : secure ? 443 : 80
  const basePath = url.pathname.replace(/\/+$/, '')
  const headers = {
    host: url.port.length > 0 ? `${host}:${port}` : host,
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    'openai-beta': BETA_HEADER,
    originator: ORIGINATOR,
    version: clientVersion,
    'user-agent': `${ORIGINATOR}/${clientVersion}`,
    accept: onSse === undefined ? 'application/json' : 'text/event-stream',
    ...(sessionId !== undefined ? { session_id: String(sessionId) } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
    // Merged last, and a `null` value removes a default — which is how the
    // beta-header probe tests which values the backend actually accepts.
    ...(extraHeaders ?? {}),
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === null || value === undefined) delete headers[key]
  }

  const proxy = options.proxy ?? proxyFor(env, host)
  // `release` detaches the abort listener only once the whole exchange is done,
  // so a cancellation arriving mid-stream still tears the socket down.
  const { socket, release } = await connect({ host, port, secure, proxy, timeoutMs, signal })

  try {
    const sse = []
    let carry = ''
    const onText = onSse === undefined
      ? undefined
      : (chunk) => {
        carry += chunk
        // SSE frames are newline-delimited; keep the trailing partial line.
        const lines = carry.split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload.length === 0 || payload === '[DONE]') continue
          sse.push(payload)
          onSse(payload)
        }
      }

    const response = await exchange(
      socket,
      { method, path: `${basePath}${path}`, headers, body },
      { onText, idleMs: timeoutMs },
    )
    return { status: response.status, headers: response.headers, body: response.body, sse }
  } finally {
    release()
    socket.destroy()
  }
}

/**
 * Install a global `undici`-style dispatcher? No — deliberately not.
 *
 * Node's `fetch` cannot be pointed at this backend reliably here, so every
 * request in this plugin goes through {@link codexRequest}, and there is no
 * ambient global to mutate. This comment exists so a future reader does not
 * "simplify" the transport back to `fetch` and silently lose proxy support.
 */
export const USES_OWN_TRANSPORT = true
