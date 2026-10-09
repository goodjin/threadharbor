# claude code 的 ACP 对接

> 核对时间：2026-10-09（`claude-agent-acp@0.76.0`）
> 状态：**本项目已实现并通过实测**。实现见 `packages/dsh-acp-agent/src/dialects/claude.ts`，回归夹具见 `packages/dsh-acp-agent/tests/fixtures/captured-frames.json`。

## 一句话结论

claude 最好接（标准 stdio + 标准字段），但有两个反直觉的点：**工具名不在 `title` 里而在 `_meta` 里**，而且**它自己跟自己不一致**——权限请求帧用 `name`，更新帧用 `_meta`。

> **一个前提说明**：本机 `claude-agent-acp` 背后的模型是中转而非 Anthropic 的 Claude——夹具里 `opus`/`fable`/`sonnet` 三个模型的实际名字都是 `iquest-q1`。**这个 dialect 编码的是适配器的帧形状，那些是真实的**；但不能据此推断 Claude 本身的行为。

## 怎么跑起来

stdio 子进程，命令 `claude-agent-acp`（Node 包 `@agentclientprotocol/claude-agent-acp`）。

## 接口形状

`initialize → session/new → session/prompt`。

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

**当前实现的 `toolOutput` 读 `content` 再读 `rawOutput`，不读第三处。** 实测中第三帧后面跟了带 `content` 的第四帧，所以没出问题；**但如果一个回合停在只有 `toolResponse.stdout` 那一帧上，输出会丢。** 后续接入时建议补上这条回退。

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

**未验证**：回合停在只有 `toolResponse.stdout` 那一帧时的行为（见坑 3）；`effort` 这个 configOption 能否设置。
