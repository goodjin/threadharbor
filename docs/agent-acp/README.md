# 各 Agent 的 ACP 对接

每个 agent 一份。写的是**怎么接上去**和**哪里会出错**，不是协议教程。

| Agent | 状态 | 传输 | 文档 |
|---|---|---|---|
| **grok** | ✅ 已实现，已实测 | WebSocket（密钥在查询参数） | [grok.md](./grok.md) |
| **codex** | ✅ 已实现，已实测 | stdio | [codex.md](./codex.md) |
| **claude code** | ✅ 已实现，已实测 | stdio | [claude-code.md](./claude-code.md) |
| **Cursor** | ✅ 已实现，已实测 | stdio | [cursor.md](./cursor.md) |
| **zcode** | ✅ 模型插件 | 直连 GLM，不走 ACP | [zcode.md](./zcode.md) |

已实现的四家共用的代码在 `packages/dsh-acp-agent/`：传输、客户端、投影、审批桥接是共用的，**每个 agent 只提供一个 dialect**。

> **zcode 不在这张表里。** 它是模型列表里单独的一组 GLM，对话由 DSH 自己的循环处理。见 [zcode.md](./zcode.md)。

## 四家的字段差异对照

差异都在「读哪个字段」，协议本身一致。这张表是分出 dialect 的全部理由。zcode 不是 ACP，不在表里。

| | grok | codex | claude | **Cursor** |
|---|---|---|---|---|
| **工具名** | `title`（**仅第一帧**） | `kind`（如 `execute`） | `_meta.claudeCode.toolName` | `kind`（如 `execute`） |
| **工具输出** | `content`（**双层嵌套**） | `rawOutput.formatted_output` | `content` / `rawOutput` / `_meta…toolResponse.stdout` | `rawOutput.stdout` |
| **模型列表** | `models.availableModels` | `models.availableModels` | `configOptions[id=model].options` | `models.availableModels` |
| **token 数** | 更新帧 `params._meta.totalTokens` | `session/prompt` 响应 | `session/prompt` 响应 | **不提供** |
| **权限请求 id** | 非 0 | 非 0 | 非 0 | **0（假值）** |
| **终端子协议** | **要**（五个方法全实现） | 未观察到 | 未观察到 | 未观察到 |
| **额外前置** | — | — | 须切 `default` 模式 | **须先 `authenticate`** |

**共用的一条铁律**：工具名必须**锁定**——各家都会在后续帧覆写名字或标题，不锁定就会被冲掉。

> **关于「未观察到 terminal/*」**：意思是实测的四轮里没发起过，不等于永远不发起。实机测试里只有 grok 挂载了终端服务，codex/claude 跑的是同一条 shell 提示词且**在没有终端服务的情况下通过**——这是「那次没用到」的证据，不是「用不到」的证明。生产代码目前对所有 preset 都挂载了终端服务（见 `factory.ts`），这个默认是对的，别因为某家「未观察到」就去掉。

**Cursor 与 codex 最像**（名字取 `kind`、输出取 `rawOutput`），但**输出字段名不同**（`stdout` vs `formatted_output`），仍需单独一个 dialect。

## 五条踩过就会懂的通则

1. **权限请求必须用 JSON-RPC 响应回同一个 id。** 用通知回会被静默接受，回合永不返回。实测挂满 240 秒，无错误、无超时、无后续帧。
2. **判断「是不是请求」要用 `typeof id === 'number'`，不能用 `if (id)`。** Cursor 的权限请求 id 是 **0**，会被真值判断漏掉，然后挂死。
3. **`usage_update` 不是 token 数。** 它带的是上下文窗口占用 `{used, size}`。Cursor 在 ACP 下干脆什么都不报。
4. **握手通过 ≠ 能用。** 三家握手后直接建会话；**Cursor 必须先 `authenticate`，而未登录时 `authenticate` 会挂住等交互式登录**。
5. **终端子协议要五个方法全实现。** 只实现 `terminal/create` 看起来是「半能用」：回合结束，但工具结果是一句抱怨。

## 公共接口总览

四家共用同一套 ACP 协议，差别在**能力声明**和**帧里的字段名**。2026-09-14 实测。

### 完整流程

```
client → agent:  initialize          { protocolVersion, clientCapabilities }
agent  → client:  initialize 响应     { protocolVersion, agentCapabilities, authMethods }
client → agent:  initialized         （通知）
client → agent:  authenticate        { methodId }     ← 只有 Cursor 强制要求
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
{ "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": true }
```

实测各家都接受这一组。声明了 `fs`/`terminal` 意味着客户端**愿意**服务对应的 `fs/*`、`terminal/*` 调用——不声明就不该期待 agent 发起。

### `initialize` 的能力声明（实测，差异很大）

| | grok | codex | claude | Cursor |
|---|---|---|---|---|
| `protocolVersion` | 1 | 1 | 1 | 1 |
| `loadSession` | ✅ | ✅ | ✅ | ✅ |
| `promptCapabilities.image` | ❌ | ✅ | ✅ | ✅ |
| `promptCapabilities.audio` | ❌ | — | — | ✅（声明为 false） |
| `promptCapabilities.embeddedContext` | ✅ | ✅ | ✅ | ✅ |
| `mcpCapabilities.http` | ✅ | ✅ | ✅ | ✅ |
| `mcpCapabilities.sse` | ✅ | ❌ | ✅ | ✅ |
| **`sessionCapabilities.list`** | ✅ | ✅ | ✅ | ✅ |
| **`sessionCapabilities.resume`** | ✅ | ✅ | ✅ | — |
| `sessionCapabilities.close` | ✅ | ✅ | ✅ | — |
| `sessionCapabilities.delete` | — | ✅ | ✅ | — |
| `sessionCapabilities.fork` | — | ✅ | ✅ | — |
| `sessionCapabilities.subagents` | — | ✅ | ✅ | — |
| `sessionCapabilities.additionalDirectories` | — | ✅ | ✅ | — |
| `providers` | — | `{}` | `{}` | — |
| `auth` | `{}` | `{logout}` | `{logout}` | — |
| `authMethods` | `cached_token` / `grok.com` | `api-key` / `chat-gpt` | **空** | `cursor_login` |

**两条要紧的结论：**

- **「声明了 authMethods」不等于「必须先鉴权」。** codex 声明了 `api-key`/`chat-gpt`，但 `initialize` 后直接 `session/new` 照样成功（实测）。**只有 Cursor 是硬门槛**——不 `authenticate` 直接 `-32000`。
- **`sessionCapabilities` 里的 `resume` / `list` / `fork` 是四家共同支持的一组会话操作**，和本项目「中途换 agent 要带历史」「恢复会话」的需求直接相关。目前**一个都没接**。

### 私有扩展方法

agent 可能发标准之外的方法，本项目的客户端对不认识的会回 JSON-RPC 错误：

- grok：`session/update` 的 `_meta` 带 `x.ai/fs_notify`、`x.ai/hooks`、`x.ai/capabilities.toolOverrides`
- codex：会主动发 `_auth/status_update` 通知
- Cursor：`cursor/*` 共五个（两个阻塞式）

### 尚未验证的接口行为

以下四家都**没有实测数据**，不要当结论用：

| 项 | 说明 |
|---|---|
| `session/load` / `resume` 的实际行为 | 四家都声明了能力，但没有一家试过真加载旧会话 |
| `session/cancel` 的实际取消 | 只在无回合运行时发过，没验证能否中断进行中的回合 |
| `session/delete`、`session/fork`、`session/close` | 四家声明了但未调用 |
| `fs/read_text_file`、`fs/write_text_file` | 声明了能力但没观察到 agent 真的发起 |
| 工具失败的 `status` 取值 | 只见过 `pending`/`in_progress`/`completed`，没抓到失败样本 |
| grok 的 `terminal/*` 之外是否还有别的子协议 | 只观察到 terminal 一族 |

## 验收门

`packages/dsh-acp-agent/tests/live.spec.ts` 是接新 agent 的验收标准，需设 `THREADHARBOR_LIVE_ACP=1` 才跑（要真二进制、真模型、几分钟墙钟时间）。

每个 agent 必须独立跑通：**建会话 → 提问 → 拿到回答 → 工具调用投影正确**，外加**权限请求被批准后回合继续**。

默认套件是封闭且快的，不跑这个。「你改了投影」之后、相信它可用之前，跑一次。

## 加一个新 agent 要动的地方

1. `packages/dsh-acp-agent/src/dialects/<name>.ts` — 实现 `AcpDialect`：工具名、输出、模型列表、token、噪声过滤
2. `packages/dsh-preset-dispatch/src/factory.ts` — 在 `DIALECTS` 里登记
3. preset 配置里声明 `agent` / `command`（或 `url`）
4. **实测抓帧**，存进 `tests/fixtures/captured-frames.json`，补一份本文档式的说明
5. 若目标只是一家模型、工具仍用 DSH：参照 zcode，做成模型插件，不要再包一层 ACP

第 4 步不能省。四家的差异全都不是从代码或文档里能看出来的——codex 把输出放在 `rawOutput` 里且 `set_model` 是坏的、grok 的工具名只在第一帧、claude 自己跟自己不一致、Cursor 的权限请求 id 是 0——全是跑起来才看见的。

**接新 agent 时额外要确认的两件事（本轮的教训）：**

1. **`initialize` 后能不能直接 `session/new`。** 四家里 Cursor 不能，必须先 `authenticate`。现有客户端流程里没有这一步，接 Cursor 时要补。
2. **`session/set_model` 是否真的可用。** codex 的这行报 `-32603`，而实机测试用 `.catch(() => {})` 把它吞了——**错误被藏了很久**。新 agent 的模型选择要么放进 `session/prompt`，要么确认这行有效，不要靠 catch 兜着。
