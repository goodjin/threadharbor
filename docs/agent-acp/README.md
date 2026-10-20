# 各 Agent 的 ACP 对接

每个 agent 一份。写的是**怎么接上去**和**哪里会出错**，不是协议教程。

| Agent | 状态 | 传输 | 文档 |
|---|---|---|---|
| **grok** | ✅ 已实现，已实测 | WebSocket（密钥在查询参数） | [grok.md](./grok.md) |
| **codex** | ✅ 已实现，已实测 | stdio | [codex.md](./codex.md) |
| **claude code** | ✅ 已实现，已实测 | stdio | [claude-code.md](./claude-code.md) |
| **Cursor** | ✅ 已实现，已实测 | stdio | [cursor.md](./cursor.md) |
| **Qoder** | ✅ 已实现，已实测 | stdio（`--acp`） | [qoder.md](./qoder.md) |
| **zcode** | ✅ 模型插件 | 直连 GLM，不走 ACP | [zcode.md](./zcode.md) |
| **minimaxi** | ✅ 模型插件，已实测 | 复用 MiniMax Code 登录，直连托管网关 | [minimaxi.md](./minimaxi.md) |

已实现的五家共用的代码在 `packages/dsh-acp-agent/`：传输、客户端、投影、审批桥接是共用的，**每个 agent 只提供一个 dialect**。

> **zcode 与 minimaxi 不在下面的字段对照表里。** 它们是模型列表里单独的两组，不走 ACP，对话由 DSH 自己的循环处理。见 [zcode.md](./zcode.md) 与 [minimaxi.md](./minimaxi.md)。
>
> 这两组贴着 ZCode 与 MiniMax Code 两个上游走（凭据、接口、模型清单、额度口径）。上游更新时如何判断要不要跟，见 [上游同步说明](../upstream-sync.zh.md)。

## 五家的字段差异对照

差异都在「读哪个字段」，协议本身一致。这张表是分出 dialect 的全部理由。zcode 不是 ACP，不在表里。

| | grok | codex | claude | **Cursor** | **Qoder** |
|---|---|---|---|---|---|
| **工具名** | `title`（**仅第一帧**） | `kind`（如 `execute`） | `_meta.claudeCode.toolName` | `kind`（如 `execute`） | `_meta.qoder.toolName` |
| **工具输出** | `content`（**双层嵌套**） | `rawOutput.formatted_output` | `content` / `rawOutput` / `_meta…toolResponse.stdout` | `rawOutput.stdout` | `rawOutput`（字符串）/ `_meta.terminal_output.data` |
| **模型列表** | `models.availableModels` | `models.availableModels` | `configOptions[id=model].options` | `models.availableModels` | `models.availableModels` |
| **token 数** | 更新帧 `params._meta.totalTokens` | `session/prompt` 响应 | `session/prompt` 响应 | **不提供** | **全为 0，不采用** |
| **权限请求 id** | 非 0 | 非 0 | 非 0 | **0（假值）** | **0（假值）** |
| **终端子协议** | **要**（五个方法全实现） | 未观察到 | 未观察到 | 未观察到 | 未观察到（用 `_meta.terminal_output`） |
| **额外前置** | — | — | 须切 `default` 模式 | **须先 `authenticate`** | 已登录即可直接建会话；**被拒才认证** |

**共用的一条铁律**：工具名必须**锁定**——各家都会在后续帧覆写名字或标题，不锁定就会被冲掉。

**Cursor、Qoder 与 codex 最像**（工具名不取 `title`、输出取 `rawOutput`），但**字段名不同**（Cursor 是 `rawOutput.stdout`，Qoder 是字符串 `rawOutput`，codex 是 `rawOutput.formatted_output`），仍需各自的 dialect。

> **关于「未观察到 terminal/*」**：意思是实测的几轮里没发起过，不等于永远不发起。实机测试里只有 grok 挂载了终端服务，codex/claude/cursor/qoder 跑的是同一条 shell 提示词且**在没有终端服务的情况下通过**——这是「那次没用到」的证据，不是「用不到」的证明。生产代码目前对所有 preset 都挂载了终端服务（见 `factory.ts`），这个默认是对的，别因为某家「未观察到」就去掉。

## 六条踩过就会懂的通则

1. **权限请求必须用 JSON-RPC 响应回同一个 id。** 用通知回会被静默接受，回合永不返回。实测挂满 240 秒，无错误、无超时、无后续帧。
2. **判断「是不是请求」要用 `typeof id === 'number'`，不能用 `if (id)`。** Cursor 与 Qoder 的权限请求 id 都是 **0**，会被真值判断漏掉，然后挂死。
3. **`usage_update` 不是 token 数。** 它带的是上下文窗口占用 `{used, size}`。Cursor 在 ACP 下干脆什么都不报；Qoder 报一个全 0 的 `usage`，同样是「没有数据」。
4. **握手通过 ≠ 能用。** 多数 agent 握手后直接建会话；**Cursor 必须先 `authenticate`，而未登录时 `authenticate` 会挂住等交互式登录**。
5. **终端子协议要五个方法全实现。** 只实现 `terminal/create` 看起来是「半能用」：回合结束，但工具结果是一句抱怨。
6. **不要抢着 `authenticate`。** Qoder 登录后直接建会话即可，主动认证反而会偶发挂满超时（2026-10-20 实测两次 120 秒）。会话被 `-32000 Authentication required` 拒绝时再认证、重试一次。

## 公共接口总览

五家共用同一套 ACP 协议，差别在**能力声明**和**帧里的字段名**。2026-09-14 实测，Qoder 于 2026-10-20 补入。

### 完整流程

```
client → agent:  initialize          { protocolVersion, clientCapabilities }
agent  → client:  initialize 响应     { protocolVersion, agentCapabilities, authMethods }
client → agent:  initialized         （通知）
client → agent:  authenticate        { methodId }     ← 仅 Cursor 每回合前置；Qoder 被拒时才发
client → agent:  session/new         { cwd, mcpServers }
agent  → client:  { sessionId, models, modes, configOptions }
client → agent:  session/set_mode    { sessionId, modeId }
client → agent:  session/prompt      { sessionId, prompt: [{type:'text',text}], modelId? }
agent  → client:  session/update …                        ← 流式内容与工具帧
agent  → client:  session/request_permission  { id }       ← 必须回响应，见通则 1
client → agent:  { outcome: { outcome: 'selected', optionId } }
agent  → client:  session/prompt 响应 { stopReason, usage? }
```

### `clientCapabilities` 声明什么

```json
{ "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true, "subagents": {},
  "_meta": { "jetbrains": { "air": { "version": 1, "capabilities": ["nativeSubagentSessions", "asyncTasks"] } } } }
```

`fs`/`terminal` 的含义同上。`subagents` 是 [ACP 子代理草案（PR #1992）](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992)的客户端开关：声明了它，实现了草案的适配器（codex-acp 1.10.0+、claude-agent-acp 0.76.0+，均按本机安装实测）就改用**原生子代理帧**报告委派，而不是把整段委派折叠成一个普通工具调用；未实现的 agent（grok、cursor）按协议忽略未知字段——grok 的握手容忍已按 `agent stdio` 实测（initialize 正常应答，2026-10-20），cursor 未实测。帧的形状与投影见下节。

**为什么有两种写法（2026-10-20 实测教训）**：已发布的 `@agentclientprotocol/sdk` 在 initialize 时会把草案字段 `subagents` 从 clientCapabilities 里**剥掉**——只发草案写法时，codex 把委派退成「Start subagent …」普通工具卡、claude 把 Agent 工具退成普通卡（失败取证存 `tests/fixtures/captured-subagent-frames.json` 的 `codex-failed` / `claude-failed`）。两家适配器文档化的备用通道是 `_meta.jetbrains.air` 扩展（`version: 1` + 能力数组，schema 会放行 `_meta`），claude 的异步任务能力对应数组里的 `asyncTasks`。两种写法同时发：`_meta` 通道今天生效，草案写法等 SDK 收录后自然接管。

### 子代理与异步任务帧（草案 #1992，2026-10-20 接入）

协商成功后，回合里会多出五类 update，投影层（`packages/dsh-acp-agent/src/projection.ts`）统一处理，与方言无关：

| update | 携带 | 投影为 |
|---|---|---|
| `subagent_spawned` | `subagentSessionId` / `name` / `task` | DSH 的 `subagent` 卡片（参数 `{prompt: task, agent: name}`），帧到达即实时开卡 |
| `subagent_state_update` | `state`: completed / failed / cancelled / disconnected | 该卡片的结果；failed 等非 completed 记为错误 |
| 子会话帧（`params.sessionId` = 子会话编号） | 子代理自己的消息/思考/工具帧 | 消息块折进卡片的回复文本；其余不进父转录 |
| `async_task_spawned` / `async_task_progress` / `async_task_state_update`（claude 的后台任务） | 任务名、描述、进度摘要、状态 | `async_task` 卡片；最新 summary 作结果文本 |

两条刻意的设计：**子会话帧绝不漏进父回答**（按 `params.sessionId` 归属路由）；**回合结束时仍未报终态的运行**（claude 的后台任务可能跨回合活着）结果文本带 `[still running]` 前缀，不冒充成功——会话日志不允许步骤在开着的工具调用上收尾，诚实只能写在文本里。

**grok 是第三种方言**（2026-10-20 真机抓包）：它不实现草案，用自己的方法名（`_x.ai/session_notification`）和蛇形字段发同一套生命周期——`subagent_spawned`（`child_session_id` / `subagent_type` / `description`）、`subagent_progress`（纯指标，丢弃）、`subagent_finished`（`status` / `output`，子代理回答整段在此，不流子会话内容帧）。经 grok 方言的 `frameUpdate` + `normalizeSubagentUpdate` 两个钩子归一化后走同一条投影路；详见 [grok.md](./grok.md)。

帧级真机验收在 `live.spec.ts` 的 native subagent 组（codex/claude 必须等到 `subagent_spawned` 并验投影，grok 按其私有帧验收）：三家均已通过（2026-10-20），原始帧存 `tests/fixtures/captured-subagent-frames.json`（含两轮失败取证 `codex-failed` / `claude-failed`，保留作 SDK 剥字段的证据）；单测层（`subagent-frames.spec.ts`、`mid-turn-tools.spec.ts`）照真实抓包与草案形状钉死全部投影行为。

### `initialize` 的能力声明（实测，差异很大）

| | grok | codex | claude | Cursor | Qoder |
|---|---|---|---|---|---|
| `protocolVersion` | 1 | 1 | 1 | 1 | 1 |
| `loadSession` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `promptCapabilities.image` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `promptCapabilities.audio` | ❌ | — | — | ✅（声明为 false） | — |
| `promptCapabilities.embeddedContext` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `mcpCapabilities.http` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `mcpCapabilities.sse` | ✅ | ❌ | ✅ | ✅ | ✅ |
| **`sessionCapabilities.list`** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`sessionCapabilities.resume`** | ✅ | ✅ | ✅ | — | ✅ |
| `sessionCapabilities.close` | ✅ | ✅ | ✅ | — | ✅ |
| `sessionCapabilities.delete` | — | ✅ | ✅ | — | ✅ |
| `sessionCapabilities.fork` | — | ✅ | ✅ | — | ✅ |
| `sessionCapabilities.subagents` | — | ✅ | ✅ | — | — |
| `sessionCapabilities.additionalDirectories` | — | ✅ | ✅ | — | ✅ |
| `providers` | — | `{}` | `{}` | — | — |
| `auth` | `{}` | `{logout}` | `{logout}` | — | — |
| `authMethods` | `cached_token` / `grok.com` | `api-key` / `chat-gpt` | **空** | `cursor_login` | `qoderclicn-login`（CN；国际版 id 不同） |

**两条要紧的结论：**

- **「声明了 authMethods」不等于「必须先鉴权」。** codex 声明了 `api-key`/`chat-gpt`，Qoder 声明了 `qoderclicn-login`，但 `initialize` 后直接 `session/new` 照样成功（实测）。**只有 Cursor 是硬门槛**——不 `authenticate` 直接 `-32000`；Qoder 只在未登录时被同一个错误拒绝，登录后无需主动认证。
- **`sessionCapabilities` 里的 `resume` / `list` / `fork` 是五家广泛支持的一组会话操作**，和本项目「中途换 agent 要带历史」「恢复会话」的需求直接相关。目前一个都没接。`subagents` 已接（2026-10-20）：客户端握手声明该能力，codex 协商已实测（回 `sessionCapabilities.subagents`）；claude 同版实现。帧级真机验收待跑（见上节末尾）。

### 私有扩展方法

agent 可能发标准之外的方法，本项目的客户端对不认识的会回 JSON-RPC 错误：

- grok：`session/update` 的 `_meta` 带 `x.ai/fs_notify`、`x.ai/hooks`、`x.ai/capabilities.toolOverrides`
- codex：会主动发 `_auth/status_update` 通知
- Cursor：`cursor/*` 共五个（两个阻塞式）
- Qoder：`_meta.qoder` 带 `toolName`、`promptQueueing`、`terminal_output` / `terminal_exit` / `terminal_info`；对 `initialized` 通知回 `-32601`（通知不等响应，无害）

### 尚未验证的接口行为

除下面注明的以外，五家都**没有实测数据**，不要当结论用：

| 项 | 说明 |
|---|---|
| `session/load` / `resume` 的实际行为 | 五家都声明了能力，但没有一家试过真加载旧会话 |
| `session/cancel` 的实际取消 | **Qoder 已实测**（3.7 秒内 `stopReason: cancelled`）；其余四家只在无回合运行时发过，没验证能否中断进行中的回合 |
| `session/delete`、`session/fork`、`session/close` | 五家声明了但未调用 |
| `fs/read_text_file`、`fs/write_text_file` | 声明了能力但没观察到 agent 真的发起 |
| 工具失败的 `status` 取值 | 只见过 `pending`/`in_progress`/`completed`，没抓到失败样本 |
| grok 的 `terminal/*` 之外是否还有别的子协议 | 只观察到 terminal 一族 |

## 验收门

`packages/dsh-acp-agent/tests/live.spec.ts` 是接新 agent 的验收标准，需设 `THREADHARBOR_LIVE_ACP=1` 才跑（要真二进制、真模型、几分钟墙钟时间）。

每个 agent 必须独立跑通：**建会话 → 提问 → 拿到回答 → 工具调用投影正确**，外加**权限请求被批准后回合继续**。

默认套件是封闭且快的，不跑这个。「你改了投影」之后、相信它可用之前，跑一次。

## 加一个新 agent 要动的地方

1. `packages/dsh-acp-agent/src/dialects/<name>.ts` — 实现 `AcpDialect`：工具名、输出、模型列表、token、噪声过滤、认证策略、权限请求里的工具名
2. `packages/dsh-preset-dispatch/src/factory.ts` — 在 `DIALECTS` 里登记
3. `packages/dsh-acp-agent/src/spawn-args.ts` — 若二进制不是 ACP 服务本身，补启动参数；若 IDE 会注入影响无头启动的环境变量，补过滤规则（Qoder 两条都占了）
4. preset 配置里声明 `agent` / `command`（或 `url`）
5. **实测抓帧**，存进 `tests/fixtures/captured-frames.<name>.json`，补一份本文档式的说明
6. 若目标只是一家模型、工具仍用 DSH：参照 zcode / minimaxi，做成模型插件，不要再包一层 ACP

第 5 步不能省。五家的差异全都不是从代码或文档里能看出来的——codex 把输出放在 `rawOutput` 里且 `set_model` 是坏的、grok 的工具名只在第一帧、claude 自己跟自己不一致、Cursor 的权限请求 id 是 0、Qoder 只把工具名放在 `_meta` 且登录后主动认证反而会挂——全是跑起来才看见的。

**接新 agent 时额外要确认的三件事（几轮下来的教训）：**

1. **`initialize` 后能不能直接 `session/new`。** Cursor 不能，必须先 `authenticate`；Qoder 能，而且主动认证会偶发挂住。两种策略分别对应 `authenticateMethodId`（急切）与 `authenticateOnDemand` + `sessionNeedsAuthenticate`（按需）。
2. **`session/set_model` 是否真的可用。** codex 的这行报 `-32603`，而实机测试用 `.catch(() => {})` 把它吞了——**错误被藏了很久**。新 agent 的模型选择要么放进 `session/prompt`，要么确认这行有效，不要靠 catch 兜着。
3. **裸启动是不是你要的东西。** Cursor 与 Qoder 的二进制不带子命令时都是交互式 CLI：进程活着、一个 JSON-RPC 字不回，握手只能等到超时。启动参数放进 `spawn-args.ts`，生产与 live 测试共用一张表。
