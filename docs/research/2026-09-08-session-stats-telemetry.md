# 会话底部统计行：四后端可获取信息与代码对接调研

- 日期: 2026-09-08
- 范围: 上一轮实现的「会话框底部统计行」（composer 下方，模仿官方 DSH StatsLine）在 codex / grok / claude / dsh 四种 Agent 后端下，各项指标**原生是否可得**、以及 ThreadHarbor **代码层是否已采集/转发/展示**
- 非范围: 本文偏调研与证据；v1 数据对接的实现说明见文末「已落地（2026-09-08）」
- 状态: 调研完成；v1 对接已落地

> **2026-09-08 已落地**：gateway 新增 `run-usage.ts`（`packages/dsh-gateway/src/run-usage.ts`）从原生帧容忍提取 token usage（claude/codex 响应 `result.usage`、grok `result._meta.usage`（`cacheCreationTokens`→缓存写）、dsh `session.event` 的 usage），挂在每轮**终态 status 条目**的可选 `usage` 字段上（protocol `RemoteTranscriptUsage`、spec/store 均已扩展）；浏览器统计行据此显示「缓存命中 / 输入输出 tok」（仅最近一轮、无数据整组省略）。hostd 侧新增 `THREADHARBOR_FRAME_LOG` 帧日志开关用于进一步实证。LLM 耗时/TTFT/TPS 仍不展示（上游或需打点，见矩阵）。

## 结论摘要

1. **当前代码只“对接”了 3 项**：`轮`、`步`（浏览器端由 transcript 派生）与 `工具调用耗时`（tool-call→tool-result 到达时间差）。`LLM 耗时`、`首 token 平均`、`tok/s`、`缓存命中`、`输入/输出 tok` **整组省略**，不是因为数据“没想好”，而是 protocol/hostd/gateway 到浏览器的整条链路目前**不携带**这些字段。
2. **“原生可得”按后端差异很大**：
   - dsh：输入/输出/cache-read/cache-write/reasoning token **在 wire 事件里就有**（`session.event` 的 `assistant/message` payload 内嵌 `usage`）；每帧带毫秒时间戳，LLM 耗时/TTFT/工具耗时可由时间戳推导。
   - codex / grok（经 codex-acp / grok serve）：流的 chunk 无任何数字，**只有轮末** `session/prompt` 响应/扩展通知带**最后一次请求**的 token 分桶（codex 含 cache-read，grok 含 cache-creation、apiDurationMs、costUsdTicks 等），且两者都**没有**逐请求时长/TTFT/tok/s；要获得这些必须由 hostd 自己打点（prompt→首 chunk、prompt→end_turn）。
   - claude（经 claude-agent-acp 0.69.0）：ACP 帧只有 `usage_update {used(总和), size, cost(仅轮末)}`，**分桶与时长完全不转发**（分桶/时长/TTFT 只存在于其子进程 stream-json/OTel，hostd 看不到）。
3. **代码层缺口是结构性而非“没填表”**：
   - 帧→transcript 的投影只保留 `{role, kind, text, requestId}`（`packages/dsh-gateway/src/projection.ts`）；`usage_update`/`_x.ai` 扩展通知等**不产生 fragment → 连条目都没有**（`projectNativeFrame` 对未知 kind 返回 `[]`）。
   - assistant 行**故意不带 nativeFrame**（`packages/dsh-gateway/src/index.ts:1626`），即便事件里带着 `usage` 也到不了浏览器。
   - 时间：hold-worker 每条 journal 事件有自己的到达时间戳（`hold-worker.ts:413`），但 gateway 落库时**按批统一盖 `createdAt`**（`index.ts:1821`），细粒度时间在投影层丢失。
   - 浏览器协议 `RemoteTranscriptEntry` / `RemoteAgentState` 无任何 usage/stats 字段（`packages/protocol/src/index.ts:276-325`、`packages/dsh-gateway/src/spec.ts:95-105`、`packages/dsh-client/src/client/store.ts:516-531`）。

## 现状代码链路（已对接部分）

上一轮改动（`packages/dsh-client`）在活动会话 composer 下方渲染 `<ConversationStatsLine>`（`RemoteConversation.tsx:2424`，组件 `conversation-stats-line.tsx`），数据来自纯函数 `deriveConversationStats`（`conversation-model.ts:658`）：

- 轮 = transcript 中 `role: 'user'` 行数；步 = 合并流式分片后的连续 assistant 片段数（同一 LLM 迭代跨 journal 页/跨 reason+message 只算一次）；
- 工具调用耗时 = 配对 tool-call→tool-result 的 `createdAt` 差之和（同批时间戳→0→该组按“无数据”省略）；
- 其余组（LLM 耗时、TTFT、TPS、缓存命中、token 分桶）由 `conversationStatsGroups`（`conversation-model.ts:717`）整体省略——这是上一轮和你确认的“能算的算、算不出整组省略”口径。

## 各后端传输形态（hostd 视角）

| 后端 | 传输 | 上游可执行 | 版本（调研所查） |
|---|---|---|---|
| codex | stdio `codex-acp`（ACP） | `codex` CLI | @agentclientprotocol/codex-acp@1.6.2、codex ^0.148/0.150 |
| grok | WS → `grok … agent serve`（本地 127.0.0.1:2419，`_x.ai/*` 扩展通知包装） | `grok` CLI | @xai-official/grok@1.0.5（迭代快，字段按 minor 追加） |
| claude | stdio `claude-agent-acp`（ACP） | `claude`（Claude Code） | claude-agent-acp@0.69.0、CC 2.1.251 时代 |
| dsh | stdio `dsh-jsonrpc-agent`（harness SDK JSON-RPC，事件逐条原样转发） | harness runtime | wheel 0.1.1rc1；对照 harness HEAD 0.1.3-alpha.2 |

hostd（hold-worker）对每条入站帧：`ChunkCoalescer` 只合并 text 流式分片（ACP `agent_message_chunk/agent_thought_chunk`、dsh `assistant/chunk`），其余帧**原样进 journal**，并按到达时间打 `timestamp`（`hold-worker.ts:319-432`）；journal 有界（默认 4000 事件 / 8 MB，`bin.ts:57-58`）。注意 hostd **看不到**各 CLI 子进程私有的产物（codex exec jsonl / app-server 通知、claude stream-json、OTel），除非另行捕获子进程输出。

## 上游可提供信息（证据矩阵）

### codex（经 codex-acp 的 ACP wire）

| 指标 | 原生 codex 流 | codex-acp 转发到 wire |
|---|---|---|
| 输入 token（含 cache） | 有，但**仅会话累计**：jsonl `turn.completed.usage.{input_tokens,cached_input_tokens,cache_write_input_tokens}`；app-server `thread/tokenUsage/updated` 有 total/last | **部分**：仅**最后一次请求**：响应 `usage.{inputTokens(未缓存),cachedReadTokens,outputTokens,thoughtTokens}` + `_meta.quota`；**cache-write 从不转发** |
| 输出 token | 有（累计） | 有（last request；null 直到 tokenUsage 事件发生） |
| LLM 时长 / TTFT / 时间戳 | **无**（jsonl 与 ThreadItem 均无时间戳；TTFT 只在内部 otel/TUI） | **无** |
| tok/s | 无 | 无 |
| 成本 | 流内无（另走账户 API） | 无（ACP 可选 cost 未填） |
| 上下文占用 | — | 有：`session/update` `usage_update {used, size}` |
| 工具帧时间戳 | 无 | 无（需 host 侧打点） |

证据：codex-acp@1.6.2 dist（unpkg）；openai/codex main `event_processor_with_jsonl_output.rs`、`exec_events.rs`、`turn_timing.rs`、`TokenUsageBreakdown.ts`；issue #17539。

### grok（grok serve 的 ACP wire，含 xAI 扩展 rail）

| 指标 | 结论 |
|---|---|
| 输入/输出/cache-read/cache-creation/reasoning token | **有，但仅轮末**：`session/prompt` 响应 `result._meta.usage`（last model call 分桶 + `modelUsage` 逐模型）与扩展 rail 的 `ResponseStarted/ResponseCompleted/TurnCompleted` 帧 |
| 时长 | 仅聚合：`TurnCompleted.elapsed_ms`、`usage.apiDurationMs`；**无 TTFT、无逐帧时间戳** |
| tok/s | 无（需自行算） |
| 成本 | 有：`costUsdTicks`（10^10 ticks = $1），partial/incomplete 时被抑制 |
| prompt_complete 通知 | **无 usage**（payload 只有 sessionId/promptId/stopReason/agentResult） |
| 工具帧 | 无时间戳（需 host 侧打点 tool_call→tool_call_update） |

证据：xai-org/grok-build（`acp_agent.rs`、`turn_end.rs`、`extensions/notification.rs`、`15-agent-mode.md`）+ 对 @xai-official/grok@1.0.5 二进制做字符串普查。**版本敏感**：1.0.5 之后迭代快，plan_update 等字段在 1.0.5 双平台都不稳定。

### claude（claude-agent-acp 的 ACP wire）

| 指标 | claude-agent-acp 转发 | 原始 CC stream-json（子进程内，hostd 不可见） |
|---|---|---|
| token 分桶 | **无分桶**；`usage_update {used(全部求和), size}`；cost 仅轮末 `{amount: total_cost_usd, currency:"USD"}` | 有：`result.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`、逐模型 `modelUsage` |
| LLM 时长 / TTFT | **无**（adapter 从不读时长字段） | 有：`result.duration_ms/duration_api_ms/ttft_ms…` |
| tok/s | 无 | 无（需算） |
| 工具帧时间戳 | 无 | 无（仅 OTel/hook 有 tool duration） |

证据：claude-agent-acp@0.69.0 dist、@agentclientprotocol/sdk@1.3.0 schema、@anthropic-ai/claude-agent-sdk@0.3.232、ACP RFD（session-usage 已稳定；end-turn token-usage 仍 Draft，本 adapter 未实现）。

### dsh（dsh-jsonrpc-agent，事件 = session-log 原样转发）

| 指标 | wire 事件 | 说明 |
|---|---|---|
| 输入/输出 token | **有**：`session.event` 的 `assistant/message` → `data.usage.inputTokens…`（还有内嵌 `{type:'usage'}` stream chunk） | 事件即日志行（sdk server `session/event` 原样 notify） |
| cache-read/cache-write/reasoning | **有（可选字段）**：`cacheReadTokens/cacheWriteTokens/reasoningTokens` | |
| LLM 时长 / TTFT | **无字段**，但事件带毫秒时间戳（`event.time`、chunk `time/time0/dt`）→ 可由 `step/start`→`assistant/message`、首 delta 推导 | 官方 dsh-session-stats 就是这么算的 |
| tok/s | 无字段，客户端算（decodeTokens/decodeMs） | |
| 成本 | **未找到**（TokenUsage 无货币字段） | |
| 工具耗时 | 可推导：`tool/call` 与 `tool/result` 各自独立事件、各有 `time`，按 `callId` 配对 | |
| 缓存命中 % | 由 `cacheRead/(总输入)` 客户端派生 | |

证据：deepseek-harness `packages/sdk/server/src/server.ts:95-98`、`packages/sdk/protocol/src/types.ts`、`packages/llm/llm/src/types.ts:141-163`（TokenUsage）、fixtures `snapshots/sdk/text-turn/*.jsonl`、`packages/session/session-stats/…projection.ts`；wheel 0.1.1rc1 README + 本机安装的 `dsh-jsonrpc-agent` 二进制。**注意**：对照的是 harness HEAD（0.1.3-alpha.2）；0.1.1rc1 是否同形需拿一条真实日志核对。

## 跨后端“底栏统计”可得性速览

| 指标（底栏） | codex | grok | claude | dsh | 当前 ThreadHarbor 代码 |
|---|---|---|---|---|---|
| 轮 / 步 | ✓（transcript 派生） | ✓ | ✓ | ✓ | **已对接**（浏览器派生） |
| 工具调用耗时 | △ 需 host 打点（帧无时间戳） | △ 需 host 打点 | △ 需 host 打点 | ✓ 事件自带时间戳/可按 callId 配对 | **半对接**（用 gateway 批时间差，catch-up 会退化为 0 而省略） |
| LLM 耗时 | ✗ 上游无（须 host 打点 prompt→end） | △ 仅轮末聚合（无逐请求） | ✗ ACP 不转发（子进程才有） | △ 由事件时间戳可推导 | **未对接**（组省略） |
| 首 token 平均 | ✗（须 host 打点） | ✗ | ✗ ACP 不转发 | △ 由首 chunk 时间可推导 | 未对接 |
| tok/s | ✗ 需自行估算 | ✗ 需自行估算 | ✗ | △ decode 时间可推 | 未对接 |
| 缓存命中 | △ 部分（无 cache-write；仅 last request） | △ 有 cache read/creation（轮末） | ✗ ACP 无分桶 | ✓ cacheRead/Write 都有 | 未对接 |
| 输入/输出 tok | △ last request 才有 | △ 轮末才有 | ✗ ACP 无分桶 | ✓ 事件自带 | 未对接 |
| 成本 | ✗（另走 API） | △ costUsdTicks（轮末，可被抑制） | △ 轮末 cost（估算） | ✗ | 未对接（底栏也无此项） |

图例：✓ 原生/可精确获得；△ 有部分/需推导或打点；✗ 当前上游拿不到（若换捕获面则另说，见下）。

## 关键代码缺口位置

1. **投影即丢**：`packages/dsh-gateway/src/projection.ts:179-183`（只认 method/type 白名单，`usage_update`、`_x.ai/…`、`response_completed` 等无 fragment→无条目）；`projectAcp`/`projectDsh` 只取 text/title。
2. **assistant 行丢 nativeFrame**：`packages/dsh-gateway/src/index.ts:1626`（`fragment.role === 'assistant' ? {} : { nativeFrame }`），所以 dsh `assistant/message` 内嵌的 `data.usage` 即使投影到 entry 也被丢弃。
3. **createdAt 批级覆盖**：`packages/dsh-gateway/src/index.ts:1821` 一整个 `appendTranscriptBatch` 共用一个 `createdAt`，hold-worker journal 里逐事件的 `timestamp`（`hold-worker.ts:413`）在投影后不可用。
4. **协议无字段**：`RemoteTranscriptEntry`（`packages/protocol/src/index.ts:276-286`）与 `remoteAgentDomainSpec.transcriptRecord`（`packages/dsh-gateway/src/spec.ts:95-105`）只有 role/kind/text/createdAt/nativeFrame/requestId；browser `parseTranscript`（`store.ts:516-531`）同形。
5. **浏览器统计行**（上一轮实现）：`conversation-model.ts:658 deriveConversationStats / :717 conversationStatsGroups`，只消费上面这些字段，所以 LLM/TTFT/TPS/缓存/token 组恒为“无数据省略”。

## 建议补齐路径（后续再做，供决策）

- **最小可靠改造（推荐起步）**：把 hold-worker journal 的逐事件时间戳带到投影（entries 增加 `eventTime`，或 gateway 直接按 `event.timestamp` 落 `createdAt`），即可让「工具调用耗时」对所有后端都稳定可测；同时把统计行里 LLM 耗时/首 token 的先不做。
- **dsh 后端 token 展示**：扩展投影处理 `assistant/message` 的 `data.usage`（+usage chunk）→ 协议加 `usage` 字段或 gateway 侧聚合成 per-run stats → 浏览器即可显示 输入/输出/缓存命中（该后端是唯一“免打点”就能全量拿到 token 的）。
- **codex/grok**：让 hold-worker 在转发时对轮末携带的 token 载荷做一次投影保存（codex 响应 `usage`/`_meta.quota`；grok `_meta.usage`/`TurnCompleted`），并在发送 prompt / 收首 chunk / 收 end 时打点，可支撑 轮耗时、首 token 近似与（文本长度的）tok/s 估算；cache-write/成本要么接受缺省，要么后续在 host 上旁路捕获子进程 jsonl。
- **claude**：ACP 面只有 `usage_update {used,size,cost}`，没有分桶与时长；要完整统计需在 host 上旁路捕获 Claude Code 的 stream-json（或 OTel/hook），这是跨后端的例外，成本最高——建议明确降级策略（只显示 used/size/成本或直接整组省略）。
- 版本敏感：grok 1.0.x 迭代快、claude 字段 snake/camel 随 SDK 代际变化、dsh 0.1.1rc1 需真实日志核对，接入时都要做版本门禁。

## 附录：如何抓真实帧（结构实测）

当不确定某后端对字段的**命名与结构**时，先抓一帧真实会话日志再谈对接，不要照文档猜。

在 hostd 进程上设置（detached hold worker 会继承环境变量）：

```sh
THREADHARBOR_FRAME_LOG=1            # 默认关；逐条打印入/出站原生帧
THREADHARBOR_FRAME_LOG_MAX=262144   # 可选：单行截断上限（默认 32768；usage/cost 字段较长时调大）
```

帧在 **hold-worker 边界、coalescing 与 projection 之前**原样落 stderr（systemd --user journal，或部署时重定向的日志文件），格式：

```
threadharbor-hostd frame-out method=session/prompt id=… frame={"jsonrpc":"2.0",…}
threadharbor-hostd frame-in  method=session/update frame={"jsonrpc":"2.0",…}
```

注意：这是调试开关，日志会包含 prompt 与工具内容等敏感文本；分析完即关。

各后端最容易命中“携带数据”的帧：

- **codex**：跑完一个完整回合（不要只给思考流），查 `frame-in` 里**响应行**（无 method、带 `id`）的 `result.usage` / `result._meta.quota`，以及 `session/update` 的 `usage_update`。
- **grok**：轮末 `session/prompt` 响应 `result._meta.usage`，以及 `_x.ai/…` 扩展通知（`TurnCompleted`/`ResponseCompleted`/`ResponseStarted`）。
- **claude**：观察 `session/update` `usage_update` 的 `used`/`size`/`cost`（分桶与时长在 ACP 面上没有——见上文）。
- **dsh**：`session.event` 的 `assistant/message` → `event.data.usage`（及内嵌 `{type:'usage'}` chunk）；注意 0.1.1rc1 与 harness HEAD（0.1.3-alpha.2）需以真实日志核对。

拿到日志后，按真实字段名把对应值接进浏览器统计行：能填的组显示、缺字段/缺数据整组省略（组件与 `conversationStatsGroups` 已按此语义实现，只需新增“有数据才出现”的组）。如果日志里根本没有 usage/计时字段，说明该指标不在该后端的 wire 上（参见上方矩阵），按“没有就忽略”处理即可。

## 引用

- ThreadHarbor 代码：`packages/hostd/src/{hold-worker.ts,chunk-coalescer.ts,server.ts,agent-manager.ts,bin.ts}`、`packages/dsh-gateway/src/{projection.ts,index.ts,spec.ts}`、`packages/protocol/src/index.ts`、`packages/dsh-client/src/client/{conversation-model.ts,conversation-stats-line.tsx,store.ts,RemoteConversation.tsx}`
- codex：unpkg @agentclientprotocol/codex-acp@1.6.2；github openai/codex main（exec_events.rs、event_processor_with_jsonl_output.rs、turn_timing.rs、TokenUsageBreakdown.ts）；issue openai/codex#17539
- grok：github xai-org/grok-build（acp_agent.rs、turn_end.rs、notification.rs、15-agent-mode.md）；npm @xai-official/grok@1.0.5
- claude：unpkg @agentclientprotocol/claude-agent-acp@0.69.0、@agentclientprotocol/sdk@1.3.0、@anthropic-ai/claude-agent-sdk@0.3.232；agentclientprotocol.com RFDs；code.claude.com/docs
- dsh：github deepseek-ai/deepseek-harness（sdk/server、sdk/protocol、llm/types.ts、session-stats、fixtures）；pypi deepseek-harness-runtime-bin==0.1.1rc1
