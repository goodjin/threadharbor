# claude code 的 ACP 对接

> 核对时间：2026-10-09 首测；2026-09-14 补充 `initialize` 与终端子协议实测；2026-10-22 复测模型写入路径
> 状态：**本项目已实现并通过实测**。实现见 `packages/dsh-acp-agent/src/dialects/claude.ts`，回归夹具见 `packages/dsh-acp-agent/tests/fixtures/captured-frames.json`。

## 一句话结论

claude 最好接（标准 stdio + 标准字段），但有两个反直觉的点：**工具名不在 `title` 里而在 `_meta` 里**，而且**它自己跟自己不一致**——权限请求帧用 `name`，更新帧用 `_meta`。

> **一个前提说明**：本机 `claude-agent-acp` 背后的模型是中转而非 Anthropic 的 Claude——夹具里 `opus`/`fable`/`sonnet` 三个模型的实际名字都是 `iquest-q1`。**这个 dialect 编码的是适配器的帧形状，那些是真实的**；但不能据此推断 Claude 本身的行为。

## 怎么跑起来

stdio 子进程，命令 `claude-agent-acp`（Node 包 `@agentclientprotocol/claude-agent-acp`）。

## 接口形状

`initialize → session/new → session/prompt`。**不需要 `authenticate`**——实测它的 `authMethods` 是**空数组**，是五家里唯一不声明任何鉴权方式的。

`session/new` 返回：

```
{ sessionId,
  configOptions: [ {id:'mode', ...}, {id:'model', ...}, {id:'effort', ...} ],
  modes: { currentModeId, availableModes } }
```

**注意：claude 的 `session/new` 里没有 `models` 字段。** 模型列表藏在 `configOptions` 里、找 `id === 'model'`（或 `category === 'model'`）那一项，读它的 `options`（每项用 `value` / `name`，不是 `modelId` / `name`）。

## 最容易踩的坑

### 1. 工具名在 `_meta.claudeCode.toolName` 里，不在 `title`

实测第一帧：

```
title = "Terminal"                                   ← 人类可读行
_meta.claudeCode.toolName = "Bash"                    ← 真正的工具名
```

第二帧 `title` 变成 `ls -la`（**这就是命令原文**），`_meta.claudeCode.toolName` 仍是 `Bash`，`_meta.claudeCode.title` 是 "List all files in current directory"。

所以 `title` 随进展变化，**只能从 `_meta` 取名**。且必须锁定，后续帧不带时不许被冲掉。

### 2. 它自己跟自己不一致

权限请求帧里，工具名在 `toolCall.name`；而更新帧里在 `_meta.claudeCode.toolName`。**同一个 agent、同一个工具、两个位置。**

本项目的处理是两种都接受（`meta.toolName` 优先，回退 `update.name`），让一个提取函数同时服务两种帧。

### 3. 输出有三处，读法各不相同

| 位置 | 说明 |
|---|---|
| `content` | 双层嵌套 `[{type:'content', content:{type:'text', text}}]`，与 grok 同 |
| `rawOutput` | 最后一帧实测同时带 `content` 和 `rawOutput` |
| `_meta.claudeCode.toolResponse.stdout` | 实测第三帧**只有**这个，`content` 和 `rawOutput` 都没有 |
| `_meta.claudeCode.toolResponse.content` | Task 委派的 Agent 工具完成帧；`[{type:'text',text}]`，同样没有 `content` / `rawOutput` |

**当前实现的读法**：`content` → `rawOutput.formatted_output` → `toolResponse.stdout` → `toolResponse.content`。第三处曾是一个已知缺口（回合若停在只有 `toolResponse` 的帧上会丢输出），2026-10-22 已补上并加了夹具测试。

### 4. 默认是 `bypassPermissions`，永远不会问你要批准

`session/new` 实测 `configOptions[id=mode].currentValue = "bypassPermissions"`。

**必须先 `session/set_mode` 切到 `default`（Manual），否则 agent 根本不发起权限请求。** 测试里若读到批准次数为 0，说明模式没生效，这条断言就什么都没证明——所以要断言它确实触发过，而不是容忍两种结果。

模式选项实测：`default`(Manual) / `acceptEdits` / `plan` / `auto`。

### 5. token 数在 `session/prompt` 的响应里

不在更新帧上。实测：

```json
{ "stopReason": "end_turn",
  "usage": { "inputTokens": 21411, "outputTokens": 721,
             "cachedReadTokens": 19344, "cachedWriteTokens": 0,
             "totalTokens": 41476 } }
```

`usage_update` 带的是 `{used, size}`，是**上下文窗口占用**，别当 token 数读。

## 会话能力

`initialize` 声明了 `sessionCapabilities` 的 `resume` / `list` / `close` / `delete` / `fork` / `subagents` / `additionalDirectories`，另有 `mcpCapabilities.http` / `sse` 与 `auth.logout`。

**图片能力有一处声明与实测不一致**：0.76.0 的 `initialize` 报 `promptCapabilities.image: true`（2026-10-22 复测），但 2026-10-13 的真机图片用例里服务端明确说没有处理图像。本项目按实测保留 `acceptsImageContent: false`，不把图片块送上 wire。

私有扩展：`_meta.claudeCode.promptQueueing: true`（表示支持提示队列）。

**`subagents` 已接**（2026-10-20）：claude-agent-acp 0.76.0 实现了[草案 #1992](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992)外加**异步任务扩展**——Task 委派走 `subagent_spawned` / `subagent_state_update`，后台任务走 `async_task_spawned` / `async_task_progress` / `async_task_state_update`（带进度摘要、token 数、时长、输出文件路径）。投影规则见 [README.md](./README.md) 的帧表；后台任务可能跨回合活着，回合结束仍 running 的结果文本带 `[still running]` 前缀。帧级真机验收已通过（2026-10-20）：Task 委派后 `subagent_spawned`（task 逐字带任务描述）与 `subagent_state_update` 到达并投成 subagent 卡片（3.5 秒完成），原始帧存 `tests/fixtures/captured-subagent-frames.json` 的 `claude` 键、并有单测照它钉死。与 codex 同一教训：草案字段会被 SDK 剥掉，握手须同时发 `_meta.jetbrains.air` 备用通道（见 README），否则 Agent 工具退成普通卡（失败取证在 `claude-failed` 键）。本轮抓包未触发后台任务，`async_task_*` 的真机帧待一次真实后台命令后补录。

**已知装饰性重复**：同一次 Task 委派还会来一条 `Agent` 工具的 `tool_call_update`（`_meta.claudeCode.toolResponse.agentId` 指回子会话）。子代理卡片由原生帧负责；这条工具帧目前会多投一张 Agent 工具卡。它不丢结果（`toolResponse.content` 已读），只是重复，与 grok 的 `spawn_subagent` + subagent 双卡同类；未做去重。

## 选模型：prompt 里的 `modelId` 不生效，走 `set_config_option`

2026-10-22 对 claude-agent-acp 0.76.0 的握手实测：

- `session/prompt` 的处理函数**不读** `params.modelId`，模型取自会话状态。
- `session/set_config_option { configId: 'model', value: 'opus' }` 成功，响应返回更新后的 `configOptions`（`currentValue` 变为 `opus`）。
- 模型选择器的 id 从 `session/new` 的 `configOptions[id=model]` 读，`configId` 也是 `model`。

所以本项目的 claude dialect 声明 `modelVia: 'config_option'`，选型在 prompt 之前写入，不再往 prompt 里塞 `modelId`。

## 权限请求

标准阻塞式，必须用 JSON-RPC 响应回同一个 id。用通知回会静默挂住（同 grok 那条实测）。

实测帧形状见 `tests/client.spec.ts` 与 `tests/approval.spec.ts` 里保存的原样帧。

## 噪声帧

比另两家多两个：

- `available_commands_update`
- `usage_update`
- `session_info_update`
- `current_mode_update`
- `config_option_update`

## 证据与未验证项

**已验证**（`tests/live.spec.ts`）：建会话、拿到回答、工具名含 `Bash`、工具输出含探针串；**权限请求被批准后回合继续完成**（批准后回答非空，这是关键——不回答会表现为回答为空）。

**本轮新增实测**：`initialize` 的完整能力声明、`authMethods` 为空、**未观察到 `terminal/*` 调用**。

**仍未验证**：`effort` 这个 configOption 能否设置；工具失败时的 `status` 取值。
