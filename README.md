# dsh-codex-provider

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中使用 **Codex 的 ChatGPT 订阅模型**（GPT-6-Astra、GPT-5.6 系列等），支持流式回复、工具调用、图片输入、推理档位与用量显示。

插件直接复用 `codex` CLI 已经登录的会话，**不需要单独的 API Key**，也不产生按 token 计费的账单 —— 走的是你的 ChatGPT 订阅额度。

---

## 为什么需要这个插件

Codex 的模型**不在 `api.openai.com` 上**。订阅用户的请求发往 `chatgpt.com/backend-api/codex`，它要求：

| 要求 | 说明 | 实测 |
|---|---|---|
| OAuth 会话凭证 | 不是 API Key，而是 `~/.codex/auth.json` 里的 access/refresh token | **必需** |
| Responses 请求体 | 不是 `chat/completions`，而是扁平的 `input` item 数组 | **必需** |
| `client_version` 查询参数 | `/models` 上的必填参数，缺失直接 400 | **必需** |
| `chatgpt-account-id` 头 | 账号 ID | 该路由上非必需 |
| `originator: codex_cli_rs` | 后端按此标识第一方客户端 | 该路由上非必需 |
| `OpenAI-Beta` | 见下 | 该路由上非必需 |

> 上表的"必需/非必需"是**逐个摘除请求头实测**得出的，不是照抄文档。插件的每条请求都带齐这些头，是为了让请求与 Codex CLI 自身发出的**完全一致** —— 后端可以在任意时刻开始校验它们，而带上正确值的成本是零。

其中 `OpenAI-Beta` 用的是 `responses_websockets=2026-02-06` —— 这是**从本机 Codex CLI 二进制里读出来的实际值**，而不是公开文档写的 `responses=experimental`。两者当前都被接受，插件选前者是为了与第一方客户端保持一致。

`client_version` 由插件**从本机 Codex 安装自动探测**（`models_cache.json` → 已安装的 `@openai/codex` 版本）。因为后端会校验它，写死一个字面量会随 Codex 升级静默失效。可在配置里显式覆盖。

这些都无法用通用的 OpenAI 兼容 provider 表达，所以本插件自己实现适配器、传输层与协议转换。

---

## 安装

### Web

```sh
dsh plugin --profile web add dsh-codex-provider
```

或从本地目录安装：

```sh
dsh plugin --profile web add D:\path\to\dsh-codex-provider
```

安装后重启 `dsh web`，然后：

1. 打开 **设置 → 模型**，会出现 **Codex (ChatGPT)** 一行；
2. 在会话的模型选择器中选择 Codex 的模型。

### Headless

```sh
dsh plugin --profile headless add dsh-codex-provider
```

`headless.patch.yml`：

```yaml
- id: agent-default-model
  config:
    provider: codex
    model: gpt-6-astra
```

---

## 前置条件

**必须先登录 Codex CLI**：

```sh
codex login
```

插件读取 `~/.codex/auth.json`。如果这个文件不存在，或登录方式是 API Key（而非 ChatGPT 账号），插件会在启动时打印明确的修复指引。

> **插件只读该文件，从不写回。** 刷新后的 token 只存在于当前进程内存中，你正常使用 `codex` 的登录态不会被影响。

---

## 网络与代理

后端 `chatgpt.com` 在受限网络下无法直连。插件**自己实现 HTTP CONNECT 隧道**，读取标准的 `HTTPS_PROXY` / `ALL_PROXY`：

```sh
export HTTPS_PROXY=http://127.0.0.1:7897
```

- `NO_PROXY` 生效（支持域名后缀匹配）。
- **本机地址（`127.0.0.1`、`localhost`）永不走代理** —— 便于把 `baseURL` 指向本地网关。
- 未设置代理时直连。

> 不使用 Node 全局 `fetch`：它不认 `HTTPS_PROXY`，且在 DNS 被污染时解析到错误地址。因此每一条请求都走插件自己的传输层。

### 源站容灾

Codex 后端有两个等价源站（Codex CLI 自己也把两者当同一套 API）：

```
https://chatgpt.com/backend-api/codex      ← 默认
https://chat.openai.com/backend-api/codex  ← 备用
```

开发期间实测遇到 `chatgpt.com` 的 TLS 握手失败（curl、裸 Node、插件三处表现一致，是网络侧问题），因此插件在主源站**连接层失败**时会自动改试备用源站，并在日志里说明。

两条边界：

- **只对连接失败（`TRANSPORT` / `TIMEOUT`）容灾。** 后端返回的业务状态（如额度耗尽 429）是真实答复，换源站重试只会在恢复遥遥无期的情况下多烧请求。
- **只有内置源站之间会容灾。** 如果你把 `baseURL` 指向自建网关或中转，插件**只连你指定的那一个** —— 把流量悄悄转去 OpenAI 的端点既意外又等于泄露提示词。

---

## 模型

模型目录**来自后端实时接口**（`/models`），不是硬编码表：

```sh
llm-codex: catalog resolved from the backend (7 models served)
```

后端返回的每个模型都带权威元数据 —— 上下文窗口、支持的推理档位、输入模态 —— 插件直接采用。写入时的实测结果：

| 模型 | 上下文 | 推理档位 | 模态 |
|---|---|---|---|
| `gpt-6-astra` | 272K（最大 872K） | low → ultra | text + image |
| `gpt-reserve` | 272K | low → xhigh | text + image |
| `gpt-5.6-sol` / `terra` / `luna` | 272K | low → xhigh | text + image |
| `gpt-5.5` | 272K | low → xhigh | text + image |
| `codex-auto-review` | 272K | — | text + image |

**新模型自动出现**：后端上线新模型后，最多 5 分钟（可配置）自动出现在选择器中，无需升级插件。

若后端暂时不可达，插件退回内置的兜底表 —— 选择器不会变空。最后一次成功的目录会被保留并在下次刷新重试。

---

## 功能

- **流式输出**：SSE 逐帧转换，边生成边显示。
- **工具调用**：`function_call` / `function_call_output` 与 DSH 的 `tool-call` 块及工具结果双向映射，按 `call_id` 关联。工具结果既支持 DSH 0.2.1 起的 `tool` 角色消息，也支持旧版的 `tool-result` 块；`developer` 角色消息保持原角色发送。
- **推理档位**：后端上报的档位直接映射（`low` / `medium` / `high` / `xhigh` / `max` / `ultra`）。不支持的档位**明确报错，不做静默钳制**。
- **思考内容**：`reasoning_summary` 事件转成独立的 reasoning 块，与正文分开渲染。
- **图片输入**：通过 attachment 服务解析后转成 `input_image` data URL；无法读取时降级为可见占位文本，而不是静默丢弃。
- **多轮历史**：助手轮次与工具结果按 Responses 规范回放。
- **推理续接**：与 Codex CLI 一致，请求 `reasoning.encrypted_content`，把加密推理存入助手消息的 `replayState`，在后续请求中按原输出顺序回放（不带条目 id，因为 `store: false` 时后端不保存任何条目）。只回放给产生它的同一模型。
- **提示缓存**：与 Codex CLI 一致，以会话 id 作为 `prompt_cache_key` 发送。
- **联网搜索（可选，默认关闭）**：`webSearch` 设为 `live` 或 `cached` 时，请求附带后端托管的 `web_search` 工具，即 Codex 在同一订阅上使用的那个。开启后同名的 DSH `web_search` 函数工具会被隐藏；搜索在后端执行，不经过 DSH 的工具审批。搜索动作显示为思考块，正文未链接的引用以 `Sources:` 列表附在文末。
- **用量显示**：Host 侧 `codexUsage` 服务读取订阅剩余额度。

### 对事件名变化的容错

后端返回的 SSE 事件名**未能在真实成功轮次上验证**（开发期间订阅一直限流，详见 `docs/verification.md`）。与其把可用性押在一张精确名字表上，转换器改为**按形状分派**：

- 认识的精确事件名走精确分支；
- 不认识的事件按**载荷形状**判断 —— 带字符串 `delta` 的按名字归类为思考 / 工具参数 / 正文；带终止状态 `response` 对象的结束本轮；带 `error` 的如实上报；带完整 `item.message` 的取其正文。

效果是把「后端改了事件名」的后果，从**整轮静默返回空**降级为**照常工作，最多渲染归类略有偏差**。

---

## 错误分类
DSH 按 `code` 路由恢复策略，因此每种失败都带稳定的机器码：

| 场景 | code | 说明 |
|---|---|---|
| 没有可读的 Codex 会话 | `MISSING_CREDENTIAL` | 提示运行 `codex login` |
| 凭证被拒绝 | `AUTH` | 401/403；同时作废缓存 token，下次重新读取会话 |
| **订阅额度耗尽** | `QUOTA` | `usage_limit_reached`；带 `providerRetryAfterMs` 重置时间 |
| 请求频率限制 | `RATE_LIMIT` | 瞬时 429，可重试 |
| 超出上下文 | `CONTEXT_WINDOW_EXCEEDED` | |
| 后端不提供该模型 | `UNKNOWN_MODEL` | |
| 模型不支持图片 | `UNSUPPORTED_CONTENT` | |
| 不支持 `stop` 序列 | `UNSUPPORTED_OPTION` | 明确拒绝而不是静默忽略 |
| 模型不支持该推理档位 | `UNSUPPORTED_REASONING_EFFORT` | 列出可用档位 |
| 连接/超时/代理拒绝 | `TRANSPORT` / `TIMEOUT` / `PROXY_REJECTED` | |
| 模型返回空回复 | `EMPTY_RESPONSE` | 可安全重试 |

> **`QUOTA` 与 `RATE_LIMIT` 是刻意区分的。** 后端对两者都返回 429，但额度耗尽要等数小时才恢复，当成可重试会白白消耗重试次数。

---

## 配置

在 **设置 → 模型 → Codex (ChatGPT)** 中编辑，或直接改 `settings.yaml` 的 `llm-codex` 段：

```yaml
llm-codex:
  enabled: true                          # false 撤回路由，插件仍挂载
  baseURL: https://chatgpt.com/backend-api/codex
  refreshMinutes: 5                      # 目录刷新间隔
  streamIdleTimeoutMs: 120000            # 单次流的空闲超时
  maxRequestImageBytes: 4194304          # 单张图片编码后上限
  clientVersion: ''                      # 空 = 从本机 Codex 安装自动探测
  catalogAdditions: []                   # 额外补充的模型条目
  replayReasoning: true                  # 请求并回放加密推理
  reasoningSummary: auto                 # auto / concise / detailed / none
  promptCacheKey: true                   # 以会话 id 作为 prompt_cache_key
  webSearch: 'off'                       # live = 联网搜索；cached = 仅后端缓存索引；off = 不附带
```

改动立即生效，无需重启。

---

## 故障排查

### 看不到 Codex 这一行

1. 确认插件已装入该 profile：`dsh plugin --profile web list`
2. 确认 `~/.codex/auth.json` 存在且是 ChatGPT 登录（不是 API Key）
3. 查看日志中的 `llm-codex:` 行

### 提示额度耗尽（QUOTA）

这是 **ChatGPT 订阅额度用完**，不是插件问题。后端会返回重置时间，等它恢复即可。报错信息里会写明大约还要等多久。

### 路由被占用

若另一个适配器已占用 `codex` 路由，插件会**自动改用 `codex-provider`** 并打 warn，模型目录照常可用。想让插件重新占用 `codex`，先移除冲突的那一项。

### 日志在哪

`ctx.logger` 只写入内存环形缓冲，**不输出到终端**。排查时以行为差异为准，或通过插件清单读取。

---

## 测试

```sh
npm test
```

| 文件 | 覆盖 |
|---|---|
| `auth.test.mjs` | 凭证读取、JWT 过期判断、刷新合并、失效作废 |
| `catalog.test.mjs` | 目录解析、代理解析、用量归一化、适配器元数据 |
| `convert.test.mjs` | 消息↔Responses 转换、用量映射、SSE 解析、流转换 |
| `e2e.test.mjs` | 桩后端上的完整一轮（文本/工具/图片/错误/取消） |
| `settings.test.mjs` | 设置命名空间安装与热更新 |

另有联网检查（需要额度）：

```sh
node test/live-transport.mjs        # 真实后端：凭证 + 目录 + SSE
node test/integration.mjs           # 真实 Cordis 上下文中的挂载与流式调用
```

---

## 卸载

```sh
dsh plugin --profile web remove dsh-codex-provider
```

---

## 已知限制

- **依赖 ChatGPT 订阅的可接受使用政策。** 请自行确认你的使用方式符合 OpenAI 条款。
- 后端接口不是公开契约，可能随时变化；插件对未知事件与未知字段做了容错。
- `stop` 序列在 Responses API 中无对应字段，因此**明确不支持**（会报 `UNSUPPORTED_OPTION`），而不是假装接受。
- 用量面板依赖后端的 `/usage` 接口，该接口形状未经文档化，解析失败时静默降级为不显示。

---

## 许可证

[MIT](LICENSE)
