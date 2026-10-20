# codex 的 ACP 对接

> 核对时间：2026-10-09 首测；2026-09-14 补充 `initialize`、set_model/set_mode、终端子协议三项实测
> 状态：**本项目已实现并通过实测**。实现见 `packages/dsh-acp-agent/src/dialects/codex.ts`，回归夹具见 `packages/dsh-acp-agent/tests/fixtures/captured-frames.json`。

## 一句话结论

codex 是三者里最「不配合」的一个：它**根本不给工具名**，也**把工具输出放在一个别人都不用的字段里**。照着 grok 或 claude 写投影会静默出错——工具名变成一整条命令，工具输出全空。

## 怎么跑起来

stdio 子进程，命令 `codex-acp`（Node 包 `@agentclientprotocol/codex-acp` 的 bin）。

实测时用环境变量 `THREADHARBOR_CODEX_ACP` 指定二进制路径，因为机器上装着的版本不一定等于项目固定的版本——**对着错的构建跑出来的结果，说明不了已发布版本的行为**。

## 接口形状

`initialize → session/new → session/prompt`，与另两家一致。**不需要 `authenticate`**——尽管它声明了 `api-key` / `chat-gpt` 两个 authMethods。

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

## 选模型：`session/set_model` 实测报错

**实测：`session/set_model` 返回 `-32603 Internal error`。**

现有实机测试里这行是 `session/set_model(...).catch(() => {})`——**错误被静默吞掉，所以这条路从来没走通过**。

真正生效的路子是**把 `modelId` 放进 `session/prompt`**：

```
session/prompt { sessionId, prompt: [...], modelId: '<选中的模型>' }
```

接 codex 时别写「先 set_model 再 prompt」，那样会静默失败、然后用错模型跑完整个回合。

（`session/set_mode` 正常：不存在的 mode 会回 `Invalid params`。）

## 会话能力：五家里声明得最全

codex 的 `initialize` 声明了 `sessionCapabilities` 的**全部七项**：`resume` / `list` / `close` / `delete` / `fork` / `subagents` / `additionalDirectories`。

对本项目直接相关的：**`fork`**（分叉会话）和 **`list`/`resume`**（枚举与恢复）目前没接。

**`subagents` 已接**（2026-10-20）：客户端握手声明 `clientCapabilities.subagents` 后，codex-acp 1.10.0 按[草案 #1992](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992)发送 `subagent_spawned` / `subagent_state_update`，子会话帧带子会话编号；投影规则见 [README.md](./README.md) 的帧表。

验证已闭环（2026-10-20）：**协商实测**——codex 回 `sessionCapabilities.subagents: {}`；**帧级真机验收通过**——委派小任务后 `subagent_spawned`（name: Calculate）与 `subagent_state_update` 按草案形状到达并投成 subagent 卡片（14.9 秒完成），原始帧存 `tests/fixtures/captured-subagent-frames.json` 的 `codex` 键、并有单测照它钉死。**关键教训**：只发草案字段时 SDK 会把它剥掉、codex 把委派退成「Start subagent …」普通工具卡——必须同时发 `_meta.jetbrains.air` 备用通道（见 README 的握手一节），失败取证在同文件的 `codex-failed` 键。

## 私有扩展

codex 会主动发 `_auth/status_update` 通知。本项目客户端遇到不认识的 agent 方法会回 JSON-RPC 错误，对通知式调用无害，但值得知道它的存在。

## 权限请求

标准阻塞式，回同一个 id 的 JSON-RPC 响应。用通知回会静默挂住（同 grok 那条实测）。

## 噪声帧

- `available_commands_update`
- `usage_update`
- `session_info_update`

codex 的 `session/new` 里那五个 `configOptions`（含 `reasoning_effort`、`fast-mode`）也值得留意——它们是可选能力，本项目目前只取了模型列表。

## 证据与未验证项

**已验证**（`tests/live.spec.ts`）：建会话拿到非空模型列表、拿到回答、产生了工具调用、工具输出含探针串（即 `rawOutput.formatted_output` 这条路走通了）。

**本轮新增实测**：`initialize` 的完整能力声明（见上）、`session/set_model` 报错、`session/set_mode` 的校验、**未观察到 `terminal/*` 调用**。

**仍未验证**：`configOptions` 里的 `reasoning_effort` / `fast-mode` 能否设置；工具失败时的 `status` 取值。collab 模式的委派行为已随 `subagents` 接入验证了单层委派；多层委派（子代理再开子代理）未测。
