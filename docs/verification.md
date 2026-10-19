# Verification record

What was actually run, and what it proved.

## Environment

| Item | Value |
|---|---|
| Harness CLI | `dsh 0.2.1-rc.2` (next channel) |
| Node | `v24.14.0` (`D:\tools\nodejs`) |
| Isolation | `DSH_HOME` pointed at a scratch directory; production harness untouched |
| Credential | ChatGPT Plus session at `~/.codex/auth.json`, read-only |
| Network | `HTTPS_PROXY=http://127.0.0.1:7897` (Clash) |

## Offline suite

```sh
npm test
```

```
auth.test.mjs          13 passed, 0 failed
catalog.test.mjs       42 passed, 0 failed
convert.test.mjs       61 passed, 0 failed
e2e.test.mjs           13 passed, 0 failed
image.test.mjs          5 passed, 0 failed
settings-page.test.mjs  8 passed, 0 failed
settings.test.mjs       5 passed, 0 failed
url-join.test.mjs       6 passed, 0 failed
usage.test.mjs         14 passed, 0 failed
────────────────────────────────────────
ALL 9 TEST FILES PASSED   (167 assertions)
```

## The fallback route, and what the models page receives

The plugin prefers the `codex` route and falls back to `codex-provider` when
another adapter already owns the name. That path had never been exercised
end-to-end, and it is the one a user is most likely to hit without realising it —
any other plugin or a hand-written `llm-pi-ai.providers.codex` entry triggers it.

`test/settings-page.test.mjs` mounts the plugin with an impostor adapter already
holding `codex`, then checks what the Settings → Models page will actually
receive:

- the plugin serves `codex-provider` rather than failing;
- **the directory row follows the route actually served** — a row advertising
  `codex` while the plugin serves `codex-provider` would point the page at
  someone else's adapter;
- the impostor's route is untouched;
- the `llm-codex` namespace still installs;
- the fallback route is *usable* — it lists models, not merely registers.

The same file also pins the non-fallback contract: every directory entry names a
route that is actually registered, carries the metadata a row needs, and its
namespace resolves to a section holding the fields the page renders.

## What is still not verified, and the honest limits of each check

Two things could not be confirmed against the live backend, and neither is
papered over:

**1. The usage endpoint path and payload shape.** RESOLVED — and both were
wrong.

The plugin originally guessed `USAGE_PATH = '/usage'` and parsed
`used_percent` / `resets_at` (ISO string) / `window_minutes` at the payload's
top level. Every field was wrong, and the parser would have returned `undefined`
for every real response.

The authoritative source turned out to be the CLI's own published protocol:

```sh
codex app-server generate-json-schema --out <dir>
```

That emits ~300 JSON Schema files describing the app-server contract, including
`GetAccountRateLimitsResponse.json`. Reading it settled the shape:

| Guessed | Authoritative (`RateLimitWindow` / `RateLimitSnapshot`) |
|---|---|
| `used_percent` | `usedPercent` |
| `resets_at` (ISO string) | `resetsAt` (**Unix seconds, int64**) |
| `window_minutes` | `windowDurationMins` |
| top-level `primary` / `secondary` | nested under `rateLimits`, plus a multi-bucket `rateLimitsByLimitId` |
| — | `planType`, `credits.unlimited`, `rateLimitReachedType`, `ordinaryUsageAllowed` |

The CLI binary additionally references `/api/codex/usage`, so the path constant
was corrected from `/usage` to `/api/codex/usage` — and because that path is
host-root-relative while the configured base URL ends in `/backend-api/codex`,
`read()` now resolves it against the URL origin. A naive join would have
requested `/backend-api/codex/api/codex/usage`.

`normalizeUsage` was rewritten against the real schema: it prefers the
multi-bucket view over the single backward-compatible one, converts `resetsAt`
from seconds to one consistent unit, and surfaces `unlimited` so a consumer does
not draw a meter for an uncapped account.

**What is still not confirmed:** a live 200 from that endpoint. Every attempt
returned a uniform **403 HTML page from Cloudflare** — including for paths that
cannot exist — so the block happens before path routing and proves nothing about
the path itself. That is the residual risk, and it stays low only because
`read()` returns `undefined` on any non-200 and the feature is decorative: a
wrong path costs a missing pill, not a broken turn.

**The same schema also corroborates the token mapping.** `TokenUsageBreakdown`
defines `inputTokens`, `cachedInputTokens`, `outputTokens`,
`reasoningOutputTokens`, `totalTokens` — the disjoint-counts model this plugin
implements, where cached input is subtracted out of the input total. The
`ReasoningTextDeltaNotification` / `ReasoningSummaryTextDeltaNotification`
schemas likewise confirm that reasoning arrives on its own channel, which is how
the translator treats it.

**2. The streaming event vocabulary and key spelling.** RESOLVED, without a
live turn — by generating the client's own TypeScript bindings.

```sh
codex app-server generate-ts --out <dir> --experimental
```

The JSON Schema export describes the app-server API and deliberately does not
expose the upstream Responses wire (`response.output_text.delta` appears zero
times in all 312 schema files). The **TypeScript** export is richer and includes
the wire-shaped types:

```ts
// ResponseItem.ts — snake_case throughout
{ "type": "function_call", name, arguments: string, call_id: string }
{ "type": "reasoning", summary: Array<ReasoningItemReasoningSummary>, ... }
{ "type": "message", role, content: Array<ContentItem> }

// ReasoningItemReasoningSummary.ts
{ "type": "summary_text", text: string }

// ContentItem.ts
{ "type": "input_text", text } | { "type": "input_image", image_url }
  | { "type": "output_text", text }
```

This confirms the implementation that was already there: the wire is
**snake_case** (`call_id`, `item_id`), reasoning summaries are objects carrying
`.text`, and message content is the `input_text` / `input_image` / `output_text`
trio exactly as `convert.js` builds and reads it. The `{ type: "summary_text",
text }` shape is why the translator's `typeof part === 'string' ? part :
part?.text` fallback matters — both forms are now handled.

It also explains the camelCase sightings: those belong to the **app-server
protocol** layer (`ReasoningSummaryTextDeltaNotification` is
`{ threadId, turnId, itemId, delta, summaryIndex }`), which is Codex's internal
API, not the wire this plugin speaks. The previous round's key-spelling
tolerance was therefore not fixing a live bug — the snake_case assumption was
already correct — but it is cheap insurance against the wire changing, and it is
now backed by evidence rather than by doubt.

An earlier claim in this file — that `response.output_text.delta` was absent from
the client — came from the packed string table, whose extraction is unreliable.
It is worth noting the schema export agrees it is absent **there**, while the
TypeScript bindings define the wire item shapes it would produce. Neither
establishes the exact event *name* list, which remains the one unconfirmed
detail, covered by shape-based dispatch.

## Isolated-harness installation, re-run against the finished code

The install-and-boot check was first done early, before the plugin gained origin
failover, version discovery, and settings handling — so it was re-run against
the current code on a **fresh** `DSH_HOME`:

```sh
DSH_HOME=<scratch> dsh plugin --profile web add <package>
DSH_HOME=<scratch> dsh web --port 3097 --no-open
```

- `dsh.profile.bundles` gained `dsh-codex-provider`.
- `dsh --dump-config --profile web` ends with:

  ```yaml
  # == dsh-codex-provider
  - id: llm-codex
    name: dsh-codex-provider
  ```

- `dsh web` booted to a printed URL with **no plugin-tree error** and stayed up.

The composed config proves the row was *composed*; it does not prove the plugin
*activated*. `test/verify-activation.mjs` covers that by composing the plugin the
way the loader does, against the real `LlmRuntime` and a real settings provider:

```
route           : codex="Codex (ChatGPT)"
configurable    : codex ns=llm-codex
settings ns     : llm-codex
[live catalog]  : gpt-6-astra, gpt-reserve, gpt-5.6-sol, gpt-5.6-terra,
                  gpt-5.6-luna, gpt-5.5, codex-auto-review
context         : 272000 | efforts: low/medium/high/xhigh/max/ultra
settings write  : refreshMinutes 9 accepted
```

An HTTP probe of the running harness was attempted and abandoned: the plugin is
host-side and contributes no client surface, so there is no route to query. The
check above is the honest substitute, and it is what would have caught a row that
composed but never activated.

## Chunk-ordering invariants

The `StreamChunk` contract states one ordering rule outright — *"Adapters emit
usage before the terminal finish and nothing afterward"* — and the rest is
implied by how assembly works. Five tests now pin the whole set, because a
violation is silent: a delta whose block was never opened is simply dropped when
the message is assembled, and a second finish chunk would confuse the loop.

- usage precedes `finish`, and `finish` is last;
- exactly one `finish` is emitted, on the success and error paths alike;
- **every delta falls inside an open block** — asserted by replaying the stream
  and tracking which indexes are open;
- block starts, deltas, and ends share one dense index space, so an index can
  never be used without its `block-start`;
- nothing is emitted after `finish`.

## Origin failover, found by an outage during development

Mid-development, `chatgpt.com` began failing its TLS handshake:

```
GET /models -> TRANSPORT: TLS handshake with chatgpt.com:443 failed
               (Client network socket disconnected before secure TLS connection was established)
```

**It was not the plugin.** Established by isolating each layer:

| Check | Result |
|---|---|
| `curl -x <proxy> https://github.com` | 200 |
| `curl https://www.google.com` (direct) | 200 |
| `curl -x <proxy> https://chatgpt.com` | exit 35 (schannel: failed to receive handshake) |
| `curl -x <proxy> https://chat.openai.com` | 308 |
| Bare Node CONNECT + TLS to chatgpt.com, **no plugin code** | same failure |
| Plugin transport to `chat.openai.com` | 308 — full CONNECT + TLS + HTTP/1.1 framing |

The tunnel established (`HTTP/1.1 200 Connection established`) and then the TLS
handshake died — identically in curl, in raw Node, and in the plugin. The route
to that one host was down. It recovered on its own minutes later and `/models`
returned 200 again.

The outage exposed a real robustness gap: the transport had a single hardcoded
origin. The Codex CLI treats two origins as interchangeable for this API —
readable from its own string table as `https://chatgpt.com/backend-api/codex`
**and** `https://chat.openai.com/backend-api/codex` — so one host being
unreachable need not take the route down.

`codexRequest` now retries against the alternate **only for transport-level
failures** (`TRANSPORT`, `TIMEOUT`). A provider status is never retried: a quota
answer is the endpoint's real reply, and repeating it per origin would spend
requests against an allowance that resets hours later.

**Failover applies only to the built-in origins.** A user who sets `baseURL` to
a self-hosted gateway or a compatibility proxy means exactly that host; silently
redirecting their traffic to OpenAI's endpoint would be both surprising and a
data leak. A custom origin fails on its own. Three tests pin this down,
including one that would have caught the leak.

## The one thing still unverified, and what was done about it

The streaming event vocabulary is the only part of the contract that could not
be confirmed against a successful live turn — the subscription was rate-limited
for the entire development window.

Three approaches were attempted:

1. **Wait for quota.** The backend reported a reset ~26 hours out
   (`resets_in_seconds` ≈ 91,000 throughout). The Codex CLI independently
   confirms the same wall, reporting *"try again at Sep 19th, 2026 6:19 PM"* —
   so this is the account's own accounting, not a plugin defect.

2. **Capture the wire directly.** `test/capture-sse.mjs` runs the plugin's own
   transport against the real endpoint and dumps every frame. While the account
   is limited the backend answers with a JSON error before any SSE frame, so
   nothing was captured. This script is the first thing to run once quota
   resets.

3. **Read the Codex CLI binary.** The client parses the same stream, so its
   string table should list the event names. This produced **contradictory
   readings across successive attempts** and was abandoned as unreliable:

   - A plain substring search reported `response.output_text.delta` absent.
   - Dumping the raw neighbourhood of `output_text` showed
     `...output_text.done...` and `...output_text.delta...` both present,
     because Rust packs literals with non-printable separators and glues
     adjacent literals together.
   - A separator-tolerant matcher then reported *every* name absent, because
     the gap between fragments exceeds any safe cap.
   - Reassembling by suffix produced yet another answer.

   The honest conclusion is that **binary archaeology cannot settle this**, and
   the earlier claim in this repository that the CLI "does not parse a
   text-delta event" was a false negative that has been removed. No code was
   changed on the strength of it.

**What was done instead**, since the uncertainty itself is the risk: the
translator no longer depends on exact event names. Exact names are still
handled precisely, and anything unrecognized is dispatched by **shape** — an
event carrying a string `delta` is classified by whether its name mentions
reasoning, arguments, or text; an event carrying a `response` object with a
terminal status ends the turn; an event carrying an `error` surfaces it; an
event carrying a full `item.message` yields its text.

That converts an unknown-vocabulary failure from *"the turn silently comes back
empty"* into *"the turn works, possibly with slightly worse attribution."*
Eight tests cover the fallback, including that a genuinely inert unknown event
is still ignored and that an exact-matched event is not double-counted.

A real bug surfaced while writing those tests: a tool call assembled purely from
deltas did not set the "saw a tool call" flag, so such a turn was reported as
`EMPTY_RESPONSE`. This is the same defect class as item 1 in the bug table
below, in a different code path, and it is now fixed and covered.

## Header and version probing

Reasoning about the wire contract from documentation was not good enough, so
each assumption was tested against the live endpoint. `/models` does not consume
quota, which makes it usable as a probe target while the account is rate-limited.

**Which headers are load-bearing.** Each was removed in turn:

```
/models with each header removed in turn:

all headers (baseline)                         OK
- chatgpt-account-id                           OK
- originator                                   OK
- version                                      OK
- OpenAI-Beta                                  OK
- user-agent                                   OK
- all optional headers                         OK

Is client_version load-bearing on /models?
no client_version query                        400 — missing query client_version

Is the Authorization header load-bearing?
no bearer token                                401 — missing_end_user_auth
```

Conclusions, all of which corrected an earlier assumption:

- **Only `Authorization` gates the request.** The remaining headers are
  advisory on this route.
- **`client_version` is a required query parameter**, not optional — omitting
  it is a hard 400.
- **`OpenAI-Beta` is not validated.** Any value is accepted, including none.
  The plugin sends `responses_websockets=2026-02-06` because that is what the
  installed Codex CLI binary actually sends, so the request is
  indistinguishable from a first-party client — not because the backend
  requires that specific string. (An earlier revision sent
  `responses=experimental`, the value the public Responses API documents; that
  works too, but it is not what this backend's own client sends.)

**Client version discovery.** Because `client_version` is validated, a
hardcoded literal ages out silently across Codex upgrades. The plugin now reads
the version from the local installation — `models_cache.json` first, then the
installed `@openai/codex` manifest — and reports that:

```
codex home     : C:\Users\Administrator\.codex
plugin default : 0.155.0
discovered     : 0.155.0
```

Configuration (`llm-codex.clientVersion`) overrides discovery when set.
Discovery is a filesystem read and happens once per catalog instance, not once
per refresh; a test asserts that.

## Live backend checks

`node test/live-transport.mjs`

```
auth   : resolved (account <redacted>)
proxy  : {"host":"127.0.0.1","port":7897}
/models status: 200
models: gpt-6-astra, gpt-reserve, gpt-5.6-sol, gpt-5.6-terra,
        gpt-5.6-luna, gpt-5.5, codex-auto-review
sample: {"slug":"gpt-6-astra","context_window":272000,
         "max_context_window":872000,
         "efforts":["low","medium","high","xhigh","max","ultra"],
         "modalities":["text","image"],"display":"GPT-6-Astra"}
```

This proves credential resolution, the CONNECT tunnel, TLS, the required
headers, and response framing against the real endpoint.

`/responses` returned **HTTP 429 `usage_limit_reached`** throughout
development — the subscription allowance was exhausted by prior use, with the
backend reporting a reset about 26 hours out. That is the backend's own
accounting, not a defect: the plugin classifies it as `QUOTA` with a reset hint
rather than treating it as a retryable rate limit.

> **Consequence for this record:** a full text turn against the *real* backend
> has not been observed. Everything up to and including the response status line
> has. The stream translation itself is covered by `e2e.test.mjs` against a stub
> replaying the real wire shape, and by `integration.mjs` through
> `ctx.llm.stream()`. A live conversational check remains outstanding until the
> allowance resets.

## Harness integration

`node test/integration.mjs` — the plugin mounted in a real Cordis context with
the real `LlmRuntime`:

```
registry providers before: []
registry providers after : [ 'codex' ]
codex route registered   : true Codex (ChatGPT)
listModels               : gpt-6-astra, gpt-reserve, gpt-5.6-sol,
                           gpt-5.6-terra, gpt-5.6-luna, gpt-5.5,
                           codex-auto-review
inputModalities          : ["text","image"]
contextWindow            : 272000
reasoning efforts        : low, medium, high, xhigh, max, ultra
systemPromptUpdate       : in-history
configurable providers   : codex(llm-codex)
stream chunk types       : block-start,text-delta,block-end,usage,finish
stream text              : "integration ok"
stream finish            : {"type":"finish","reason":{"kind":"stop"}}
```

A full turn through the harness's own streaming API, from message in to finish
chunk out.

## Isolated harness boot

```sh
DSH_HOME=<scratch> dsh plugin --profile web add <package>
DSH_HOME=<scratch> dsh web --port 3099 --no-open
```

- The profile's `dsh.profile.bundles` gained `dsh-codex-provider`.
- `dsh --dump-config --profile web` ended with:

  ```yaml
  # == dsh-codex-provider
  - id: llm-codex
    name: dsh-codex-provider
  ```

- `dsh web` booted to a URL with **no error** — the plugin tree loaded, which
  is the failure mode a broken provider plugin usually produces.

The production harness on its own `DSH_HOME` was never written to.

## Bugs found and fixed during development

Recorded because each was caught by a test rather than by inspection:

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | Tool-call turn reported as an empty response | `#sawToolCall` only set on `output_item.added` | Also set it on `output_item.done` |
| 2 | Content silently dropped when a stream ended early | A block opened but never closed by `output_item.done` was never emitted | Accumulate deltas and close dangling blocks in `end()` |
| 3 | `prettifyModelName` produced `Gpt-5.6-Luna` | Naive capitalisation | Preserve known initialisms |
| 4 | Every local test hit a TLS handshake error | Transport always wrapped in TLS | Apply TLS only for `https:` |
| 5 | `adapter.prepareCall is not a function` | Adapter was a plain class, not an `LlmAdapter` subclass | Extend `LlmAdapter` |
| 6 | Settings namespace never registered | Guessed `settings.install()`; the real API is `installSection(owner, ns, schema, entry, {setSource, onChange})` | Use the real signature and read through the `setSource` thunk |
| 7 | Stub backend unreachable, `HTTP 0` | `HTTPS_PROXY` routed loopback through Clash | Never proxy loopback/private hosts |
| 8 | Response status stayed `0` against a local peer | Listeners attached *after* `socket.write`; a fast peer answered in the same tick | Attach listeners before writing |
| 9 | Raw `ECONNREFUSED` reached the harness untyped | Socket errors not wrapped | Wrap connect and TLS failures in typed `LlmError`s |
| 10 | `client_version` hardcoded to a stale literal | Assumed optional; probing showed a 400 when absent | Discover the version from the local Codex install, overridable by config |
| 11 | Cancelling a stream hung for the full 120s idle timeout | The abort listener was detached once the socket connected, so an abort arriving mid-stream never reached it | Keep the listener for the whole request; detach only when the exchange finishes |
| 12 | A tool call assembled purely from deltas was reported as `EMPTY_RESPONSE` | The shape-based fallback did not set `#sawToolCall` | Set it when a tool-call delta is opened |
| 13 | A transient `chatgpt.com` outage took the whole route down | The transport had a single hardcoded origin | Fail over between the two built-in origins, transport failures only |
| 14 | Failover redirected a user's **custom** `baseURL` to OpenAI's endpoint | Failover was applied to every origin | Restrict it to the built-in origin set, so a self-hosted gateway is never bypassed |
| 15 | A throwing attachment service failed the whole turn | `projectImages` awaited the resolver without a guard | Degrade that one image to a placeholder instead of losing the turn |
| 16 | **Every field of the usage payload was wrong** | Guessed `used_percent`/`resets_at`/`window_minutes` at the top level; the real contract is `usedPercent`/`resetsAt`(Unix seconds)/`windowDurationMins` nested under `rateLimits` | Rewrote against the CLI's published JSON Schema |
| 17 | The usage path was `/usage` | Guessed from other providers; the CLI binary references `/api/codex/usage` | Corrected, and resolved against the URL origin rather than the API base |
| 18 | **Block identity keyed off snake_case only** | The shipped client uses camelCase under its app-server protocol and snake_case elsewhere; which the upstream wire uses is unconfirmed, and a wrong guess collapses a turn into one block | Read every field under either spelling |

Items 10 and 11 were found by probing and by a test that started failing for the
right reason — not by inspection. Item 12 came out of writing tests for the
fallback, which is the point of writing them.


## Reproducing

```sh
# offline, no credentials needed
npm test

# live (requires an unexhausted ChatGPT subscription and a working proxy)
node test/live-transport.mjs
node test/integration.mjs
```
