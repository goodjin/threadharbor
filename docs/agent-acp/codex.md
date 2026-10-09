# codex 的 ACP 对接

> 核对时间：2026-10-09（`codex-acp`，本项目固定 `@agentclientprotocol/codex-acp@1.6.2`）
> 状态：**本项目已实现并通过实测**。实现见 `packages/dsh-acp-agent/src/dialects/codex.ts`，回归夹具见 `packages/dsh-acp-agent/tests/fixtures/captured-frames.json`。

## 一句话结论

codex 是三者里最「不配合」的一个：它**根本不给工具名**，也**把工具输出放在一个别人都不用的字段里**。照着 grok 或 claude 写投影会静默出错——工具名变成一整条命令，工具输出全空。

## 怎么跑起来

stdio 子进程，命令 `codex-acp`（Node 包 `@agentclientprotocol/codex-acp` 的 bin）。

实测时用环境变量 `THREADHARBOR_CODEX_ACP` 指定二进制路径，因为机器上装着的版本不一定等于项目固定的版本——**对着错的构建跑出来的结果，说明不了已发布版本的行为**。

## 接口形状

`initialize → session/new → session/prompt`，与另两家一致。

`session/new` 返回的字段比 grok 全：

```
{ sessionId,
  models: { availableModels, currentModelId },
  configOptions: [ mode, collaboration_mode, model, reasoning_effort, fast-mode ],
  modes: { currentModeId, availableModes } }
```

模型列表实测有 23 个。

> **一处注释与夹具不符**：`codex.ts` 的注释写「returns `models.availableModels` like grok, but **without** `currentModelId`」，但夹具里 codex 是带 `currentModelId` 的（实测值 `gpt-6-astra[high]`）。因为代码只读 `availableModels`，功能上无影响，但注释该修。

## 最容易踩的坑

### 1. 它从不报告工具名

`title` 里放的是**agent 想执行的命令原文**（实测：`ls -la\nfind . -maxdepth 1 -type f | wc -l`）。另一个像身份的字段是 `kind`，实测值 `execute`，那是工具**类别**不是名字。

所以用 `kind` 当工具名——这是它能给的最近似物。**照 grok 那样把 `title` 当名字，会把一整条 shell 命令塞进工具名的位置。**

`kind` 也要锁定：后续帧实测不带 `kind`，不锁定会被后面的帧冲掉。

### 2. 工具输出不在 `content` 里

`tool_call_update` 帧**根本没有 `content` 字段**（实测键：`sessionUpdate, toolCallId, status, rawOutput, _meta`）。

结果在：

```
rawOutput.formatted_output    // 输出文本
rawOutput.exit_code           // 退出码
```

按 grok 的办法读 `content`，会得到**每一个 codex 工具调用都是空输出**，而且不报错。

### 3. token 数在 `session/prompt` 的响应里

不在任何更新帧上。实测响应：

```json
{ "stopReason": "end_turn",
  "usage": { "totalTokens": 18050, "inputTokens": 1182,
             "cachedReadTokens": 16768, "outputTokens": 100, "thoughtTokens": 0 } }
```

注意 `cachedReadTokens` 是 codex 特有的。

### 4. `usage_update` 不是 token 数

它带的是 `{used, size}`，那是**上下文窗口占用**，不是 token 计数。别把它当用量读。

## 权限请求

标准阻塞式，回同一个 id 的 JSON-RPC 响应。用通知回会静默挂住（同 grok 那条实测）。

## 噪声帧

- `available_commands_update`
- `usage_update`
- `session_info_update`

codex 的 `session/new` 里那五个 `configOptions`（含 `reasoning_effort`、`fast-mode`）也值得留意——它们是可选能力，本项目目前只取了模型列表。

## 证据与未验证项

**已验证**（`tests/live.spec.ts`）：建会话拿到非空模型列表、拿到回答、产生了工具调用、工具输出含探针串（即 `rawOutput.formatted_output` 这条路走通了）。

**未验证**：`configOptions` 里的 `reasoning_effort` / `fast-mode` 能否通过 `session/set_config` 之类的方法设置；collab 模式的行为。
