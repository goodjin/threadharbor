# Cursor 的 ACP 对接

> 核对时间：2026-09-14（2026-10-13 复核接入状态）
> 来源：官方文档 <https://cursor.com/docs/cli/acp.md> + **本机实机探测**（`cursor-agent-sea` 构建 2026.10.01-e373342，已完成登录）
> 状态：**已实现，已实测。** cursor dialect（`packages/dsh-acp-agent/src/dialects/cursor.ts`）与 `acp-cursor` 预设行已落地并有测试覆盖；authenticate 前置与权限请求 id=0 两个坑都在客户端里处理掉了。

## 一句话结论

Cursor 的帧形状**最接近 codex**：工具名在 `kind`、输出在 `rawOutput`。但它有两条别家没有的东西——**必须先 `authenticate` 才能建会话**，以及**权限请求的 id 是 0**。后者足以让「按 id 判断是否为请求」的代码漏掉它，然后挂死。

## 装机器时的两个坑

**（1）安装会覆盖 `~/.local/bin/agent`。** 官方安装脚本第 128 行 `rm -f ~/.local/bin/agent`，而本项目的 grok agent 正通过这个链接提供（指向 `~/.grok/bin/agent`）。**接 Cursor 前必须先把可执行文件路径做成配置项**，不能依赖这个名字。

**（2）二进制没有代码签名。** 安装包里的 `cursor-agent-sea` 完全未签名，macOS 会直接杀掉（退出码 137）。本地试跑要 `codesign --force --sign -` 补一个临时签名。官方正常安装不受影响，自建部署会踩到。

（手动下载的平台目录是 `darwin/arm64`，不是 `mac/arm64`，后者 403。）

## 流程：多一道硬门槛

```
1. initialize                        ← 能过
2. authenticate  methodId:"cursor_login"   ← 不做这步，下一步直接失败
3. session/new
4. session/set_mode  （可选）
5. session/prompt
```

**实测未登录时的表现：**

| 调用 | 结果 |
|---|---|
| `initialize` | ✅ 正常 |
| `session/new` | ❌ `-32000 Authentication required` |
| `authenticate` | ⚠️ **不返回**，挂住等交互式登录 |
| `session/list` | ❌ `-32000 Authentication required` |

另外三家里 `initialize` 完直接 `session/new`；**只有 Cursor 必须在终端先完成一次 `agent login`**。登录后 `authenticate` 即刻返回 OK。

### 鉴权方式

```
agent login                                        # 交互式，一次性
agent --api-key "$CURSOR_API_KEY" acp
agent --auth-token "$CURSOR_AUTH_TOKEN" acp
```

也可用环境变量 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`。凭据存在系统钥匙串，`~/.cursor/cli-config.json` 里只有编辑器与权限配置、无密钥——所以别指望从配置文件里读出来复用。

### initialize 返回（实测）

```json
{ "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "image": true, "embeddedContext": false, "audio": false },
    "sessionCapabilities": { "list": {} } },
  "authMethods": [ { "id": "cursor_login", "name": "Cursor Login", ... } ] }
```

### session/new 返回（实测）

```
{ sessionId,
  models: { currentModelId, availableModels: [ { modelId, name }, … ] },
  modes: { currentModeId: "agent", availableModes: [agent, plan, ask] },
  configOptions: [ { id: "mode", … } ] }
```

**模型列表就在 `models.availableModels`，字段名与 grok / codex 一致**（`modelId` / `name`）。实测 29 个，含 grok、claude、gpt、gemini 等多厂商——**注意 `modelId` 里带了参数后缀**，例如：

```
grok-4.7[context=256k,reasoning_effort=high,fast=true]
claude-opus-5-5[context=300k,effort=medium,fast=false]
```

即**同一个模型的不同配置是不同的 modelId**。界面展示时需把方括号部分剥掉，提交时原样带回。

## 工具帧（实测）

| 阶段 | `status` | 携带字段 |
|---|---|---|
| `tool_call` | `pending` | `kind`、`rawInput`、`title` |
| `tool_call_update` | `in_progress` | 只有 `toolCallId` |
| `tool_call_update` | `completed` | `rawOutput` |

实测值：

```
title    = "`echo CURSOR_ACP_OK`"          ← 命令本身，不是工具名
kind     = "execute"                        ← 唯一的身份标识
rawInput = { "command": "echo CURSOR_ACP_OK" }
rawOutput= { "exitCode": 0, "stdout": "CURSOR_ACP_OK\n", "stderr": "" }
```

**三个要点：**

1. **工具名只能取 `kind`**（`execute`），和 codex 一样。`title` 是命令原文，套上去等于把命令当工具名。
2. **输出在 `rawOutput.stdout`**——结构像 codex 的 `rawOutput.formatted_output`，但**字段名不同**（`stdout` vs `formatted_output`、`exitCode` vs `exit_code`）。**不能直接复用 codex 的 dialect，要新写或加分支。**
3. **失败判定看 `status === 'failed'`**，与投影层现有的一致。

### 一个隐蔽的坑：toolCallId 里带换行符

实测值形如：

```
call-4d0f535c-5c13-44ee-aff2-849388a0b5ff-0\nfc_f219a4ef-c92d-9f5b-a3dc-e2fb1ab644e1_0
```

**中间是一个字面的换行符。** 按行分帧的传输层不受影响，但任何把这个 id 写进日志、单行协议、或按行解析的环节都会出错。存进 `tool/call` 的 `callId` 前要处理。

## 权限请求（实测，也是最容易挂死的地方）

**请求 id 是 `0`。**

`if (frame.id)` 这种判断会把它当成「没有 id」的通知跳过，然后**回合永远不返回**——本项目实测挂满 180 秒无报错。代码里必须用 `typeof frame.id === 'number'`。

请求帧形状：

```
params.options = [
  { optionId: "allow-once",    name: "Allow once",    kind: "allow_once" },
  { optionId: "allow-always",  name: "Allow always",  kind: "allow_always" },
  { optionId: "reject-once",   name: "Reject",        kind: "reject_once" } ]
params.toolCall = { toolCallId, title, kind, status, content }
```

两点要注意：

- **`toolCall` 里没有 `name` 字段**，只有 `kind`。所以从权限请求里取工具名也要读 `kind`（本项目的 `claude` dialect 正是从 `toolCall.name` 取的，照抄会取空）。
- `toolCall.content` 是**双层嵌套**的 `[{type:'content', content:{...}}]`，与 grok / claude 同。

**回应形状**（实测有效，回完回合正常走完）：

```
{ "outcome": { "outcome": "selected", "optionId": "allow-once" } }
```

## token 用量：ACP 下完全没有

实测 `session/prompt` 的响应只有 `{"stopReason": "end_turn"}`，**不带任何 usage**；更新帧的 `_meta` 里也没有。

四家里只有 grok 通过更新帧报 token。**Cursor 在 ACP 模式下拿不到用量**，界面上的 token 统计对 Cursor 会是空的。

## 噪声帧

- `current_mode_update`
- `available_commands_update`
- `session_info_update`

## 标准 ACP 之外的自定义扩展方法

官方文档列出两组。**阻塞式的不实现会让 agent 停等**（本项目的客户端遇到未知方法会回 JSON-RPC 错误）：

**阻塞式**：

| 方法 | 用途 | 回什么 |
|---|---|---|
| `cursor/ask_question` | 多选提问 | `{outcome:{outcome:"answered", answers:[{questionId, selectedOptionIds}]}}`，或 `skipped` / `cancelled` |
| `cursor/create_plan` | 请求批准计划 | `{outcome:{outcome:"accepted", planUri?}}`，或 `rejected` / `cancelled` |

**通知式**（不回无妨）：`cursor/update_todos`、`cursor/task`、`cursor/generate_image`。

其中 `cursor/update_todos` 值得单独接——DSH 会话界面本来就有 todo 展示。

> **未实测**：本次探测的提示词没有触发这两个扩展方法，实际触发时机与帧形状需在真实使用中补抓。

## 与桌面版的关系：ACP 看不到桌面版的对话

你问过这个问题，这里给结论。

**结论：不能。** Cursor 的 ACP 与桌面版**共用同一套 worker、同一份存储，但 `session/list` 只列 ACP 自己建的会话。**

实测：

- 登录后调 `session/list`（带 cwd 和不带 cwd 都试了）→ **各只返回 1 个会话**，就是探测时刚建的那个（`cwd: /tmp`，时间戳是当时）
- 桌面版的会话在 `conversation-search.db` 里有 **436 条**，另有 `state.vscdb` 的 `glass.agentConversationPanes.*` 键
- **一条都没出现在 ACP 的列表里**

结构上的证据是有的——两边共用 worker（桌面版 globalStorage 下有 `cursor-agent-worker` 进程目录；`~/.cursor/agent-cli-state.json` 按项目路径记录 workerId）、CLI 侧没有独立会话库（`~/.cursor` 下没有任何 chat / conversation / session 文件）。**但「共用底层」不等于「ACP 能枚举到桌面版的对话」**，实测否定了后者。

所以接 Cursor 只能拿到**从 ACP 侧新建的**会话，看不到桌面版的历史。

## MCP 限制

- 支持项目级 / 用户级 `.cursor/mcp.json`
- **不支持** dashboard 上配置的团队级 MCP（ACP 模式下）
- 从项目目录启动 `agent`，并批准要用的 server

## 接进本项目要改的地方

1. **新增 `dialects/cursor.ts`**：工具名取 `kind`；输出取 `rawOutput.stdout`；模型取 `models.availableModels`；token 恒为 `undefined`
2. **在 `factory.ts` 的 `DIALECTS` 登记**
3. **补 `authenticate` 步骤**——现有 `AcpClient` 流程里没有这一步，直接 `session/new` 会失败
4. **确认客户端按 `typeof id === 'number'` 判断**（本项目已如此，Cursor 的 id=0 不会漏）
5. **实现两个阻塞式扩展方法**
6. **`toolCallId` 里的换行符**要处理，否则日志和单行协议会出问题
7. **可执行文件路径做成配置项**，避开 `~/.local/bin/agent` 冲突

其中第 3 条最容易被漏——现有三家都不需要它。

## 证据

**已实测**：initialize 返回、authenticate 成功、`session/new` 的完整返回（含 29 个模型）、`session/list` 的实际结果、完整工具调用三帧、权限请求的形状与回应、回合正常走完（`stopReason: end_turn`）、token 缺失。

**抓到的原始帧已存为夹具**：`packages/dsh-acp-agent/tests/fixtures/captured-frames.cursor.json`，写 dialect 时直接照它写。

**未实测**：两个 `cursor/*` 扩展方法的实际触发；失败工具的 `status` 取值；`session/load` 加载旧会话的行为。
