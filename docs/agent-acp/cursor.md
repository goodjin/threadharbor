# Cursor 的 ACP 对接

> 核对时间：2026-09-14（2026-10-13 复核接入状态；2026-10-21/22 补核子代理能力、模型选择与扩展方法）
> 来源：官方文档 <https://cursor.com/docs/cli/acp.md> + **本机实机探测**（`cursor-agent-sea` 构建 2026.10.01-e373342，已完成登录）
> 状态：**已实现，已实测。** cursor dialect（`packages/dsh-acp-agent/src/dialects/cursor.ts`）与 `acp-cursor` 预设行已落地并有测试覆盖；authenticate 前置、权限请求 id=0、原生子代理帧与模型配置项都在客户端里处理掉了。

## 一句话结论

Cursor 的帧形状**最接近 codex**：工具名在 `kind`、输出在 `rawOutput`。但它有两条别家没有的东西——**必须先 `authenticate` 才能建会话**，以及**权限请求的 id 是 0**。后者足以让「按 id 判断是否为请求」的代码漏掉它，然后挂死。

子代理上它的做法也独一份：**能力要发在 `clientCapabilities._meta.subagents`**；同一次委派会**发两遍**（`task` 工具调用 + 原生 `subagent_spawned`），工具调用在派发瞬间就报 `completed`，真正的完成信号是原生 `subagent_state_update`。

## 装机器时的两个坑

**（1）安装会覆盖 `~/.local/bin/agent`。** 官方安装脚本第 128 行 `rm -f ~/.local/bin/agent`，而本项目的 grok agent 正通过这个链接提供（指向 `~/.grok/bin/agent`）。**接 Cursor 前必须先把可执行文件路径做成配置项**，不能依赖这个名字。

**（2）二进制没有代码签名。** 安装包里的 `cursor-agent-sea` 完全未签名，macOS 会直接杀掉（退出码 137）。本地试跑要 `codesign --force --sign -` 补一个临时签名。官方正常安装不受影响，自建部署会踩到。

（手动下载的平台目录是 `darwin/arm64`，不是 `mac/arm64`，后者 403。）

## 流程：多一道硬门槛

```
1. initialize                        ← clientCapabilities 里要带 _meta.subagents，否则子代理帧不来
2. authenticate  methodId:"cursor_login"   ← 不做这步，下一步直接失败
3. session/new
4. session/set_mode          （可选）
5. session/set_config_option （换模型时；configId 取 session/new 报的模型选择项）
6. session/prompt
```

**实测未登录时的表现：**

| 调用 | 结果 |
|---|---|
| `initialize` | ✅ 正常 |
| `session/new` | ❌ `-32000 Authentication required` |
| `authenticate` | ⚠️ **不返回**，挂住等交互式登录 |
| `session/list` | ❌ `-32000 Authentication required` |

另外几家 `initialize` 完直接 `session/new`；**只有 Cursor 必须在终端先完成一次 `agent login`**。登录后 `authenticate` 即刻返回 OK。

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

### 子代理能力：只认 `_meta.subagents`

`agentCapabilities` 里**没有** `subagents`（不声明草案的服务端能力），但这不代表它不做委派。2026-10-21 逐项实测（构建 2026.10.01）：

| 客户端握手写法 | 结果 |
|---|---|
| 只发 `clientCapabilities.subagents: {}` | ❌ 没有原生帧；委派只剩一张 `task` 工具卡，子代理完成后父回合不被唤醒 |
| 只发 `clientCapabilities._meta.subagents: {}` | ✅ `subagent_spawned` / `subagent_state_update` 到达，子代理完成后父回合继续 |
| 两种都发 | 与只发 `_meta` 相同 |

原因在 Cursor 的读法：它检查 `clientCapabilities.subagents || clientCapabilities._meta.subagents`（bundle 2026.10.01），而已发布的 `@agentclientprotocol/sdk` 在 initialize 时会把顶层草案字段剥掉——能到达它的只有 `_meta` 这一份。本项目只对声明了 `metaSubagents` 的方言发这一项。

能力打开后 Cursor 的行为（bundle + 真机抓帧）：

- 子代理的 `session/update` 带 `params.sessionId = 子会话 id`，按会话 id 路由即可；
- 子代理完成时发 `subagent_state_update`，并在**同一个 `session/prompt` 内**自动唤醒父代理继续，客户端不需要补发 prompt；
- 关闭能力时这些帧与自动续跑都不存在——子代理跑完父代理不知道，回合停在半路（2026-10-20 的慢会话就是这种形态）。

#### 一次委派，两条消息

真机抓帧（2026-10-21）：

1. **`task` 工具调用**：`kind: "other"`，`rawInput._toolName: "task"`，`prompt` 是全量任务，`description` 是用户看到的代理名；
2. **原生 `subagent_spawned`**：`subagentSessionId` 是子会话 id，`task` 是**截断**的任务文本，`name` 是通用名。

两条通过 `_meta.cursor.toolCallId` 关联，值同样是换行拼接的 id（见下文的坑）。`task` 工具调用在派发后 0.1–1 秒就报 `status: "completed"`——那是**派发完成**，不是子代理完成；真正的终态只认 `subagent_state_update`。

本项目的处理：只开一张卡，id 取 `task` 工具调用折叠后的 id、参数取全量 `prompt` / `description`；`task` 的 `completed` 不落结果；子代文本按 `params.sessionId` 累积；`subagent_state_update` 到达时才落结果、关卡片。投影（`linkedTools`）与分段泵（`subagentTools` / `spawnedByChild`）两条路径同一套规则。

### session/new 返回（实测）

```
{ sessionId,
  models: { currentModelId, availableModels: [ { modelId, name }, … ] },
  modes: { currentModeId: "agent", availableModes: [agent, plan, ask] },
  configOptions: [ { id: "mode", category: "mode", … },
                   { id: "model", category: "model", … } ] }
```

**模型列表就在 `models.availableModels`，字段名与 grok / codex 一致**（`modelId` / `name`）。实测 29 个，含 grok、claude、gpt、gemini 等多厂商——**注意 `modelId` 里带了参数后缀**，例如：

```
grok-4.7[context=256k,reasoning_effort=high,fast=true]
claude-opus-5-5[context=300k,effort=medium,fast=false]
```

即**同一个模型的不同配置是不同的 modelId**。界面展示时需把方括号部分剥掉，提交时原样带回。

### 换模型：走 `session/set_config_option`

`session/prompt` **没有**文档化的 `modelId` 参数，Cursor 也不读它。换模型只有一条路：

```
session/set_config_option { sessionId, configId: "model", value: "<modelId 原样>" }
```

`configId` 取 `session/new` 的 `configOptions` 里 `category: "model"`（或 `id: "model"`）那一项，不要写死。实测（2026-10-21）：调用成功，后续回合按新模型跑；`value` 必须是 `models.availableModels` 里的完整 id（含方括号后缀）。本项目由 `modelVia: 'config_option'` + `modelConfigId` 走这条路，同一会话只在选择真正变化时发一次。

### 会话恢复：`session/resume` 不支持

`initialize` 声明 `loadSession: true`，但 **`session/resume` 探针返回 `-32601`（方法不存在）**，只有 `session/load` 存在。本项目的日志恢复路径用 `session/resume`，所以 Cursor 方言**不能声明 `supportsSessionResume`**；恢复时按文本回灌走，而不是指望 agent 端保留会话。`session/load` 的实际加载行为未测。

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

五家里只有 grok 通过更新帧报 token（Qoder 报的是全 0，等于没报）。**Cursor 在 ACP 模式下拿不到用量**，界面上的 token 统计对 Cursor 会是空的。

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

**文档上的通知式**：`cursor/update_todos`、`cursor/task`、`cursor/generate_image`。

**实测（2026-10-21，构建 2026.10.01）：这三个也带 JSON-RPC `id`，是按请求发来的，不回会让 agent 停等。** `cursor/task` 直接参与子代理派发，载荷形如：

```
{ toolCallId, description, prompt, subagentType, durationMs }
```

本项目对这三个一律回空结果 `{}`——按约定它们是发射后不管的，空结果只表示「收到了」，不冒充任何业务结论。`cursor/task` 不再单独渲染成「子代理任务完成」行：它和 `subagent_spawned` 是同一次委派，展示归子代理卡片（见上文），原始输出层把它列为专属方法丢弃。

两个阻塞式方法 `cursor/ask_question` / `cursor/create_plan` 早已接上，默认分别回 `skipped` / `cancelled`；宿主能问用户时，提问会走 `answerAskQuestion` 交给真人。**这两个的真实触发形状仍未实测**。

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

## 接进本项目要改的地方（均已落地）

1. **新增 `dialects/cursor.ts`**：工具名取 `kind`；输出取 `rawOutput.stdout`；模型取 `models.availableModels`；token 恒为 `undefined`
2. **在 `factory.ts` 的 `DIALECTS` 登记**
3. **补 `authenticate` 步骤**——直接 `session/new` 会失败
4. **确认客户端按 `typeof id === 'number'` 判断**（Cursor 的权限请求 id=0 不会漏）
5. **实现两个阻塞式扩展方法**；另外三个「通知式」方法实测也带 id，按请求回 `{}`
6. **`toolCallId` 里的换行符**折叠一次，日志、协议与关联键都用折叠后的 id
7. **可执行文件路径做成配置项**，避开 `~/.local/bin/agent` 冲突
8. **子代理**：握手发 `_meta.subagents`；`task` 工具调用与原生帧按 `_meta.cursor.toolCallId` 关联；只开一张卡、一个子会话；`task` 派发时的 `completed` 不落结果；完成以 `subagent_state_update` 为准
9. **模型选择**：`modelVia: 'config_option'`，配置项 id 从 `session/new` 读，不再往 `session/prompt` 塞 `modelId`

其中第 3 条最容易被漏——其余几家都不需要它（Qoder 也只在被拒时认证，见 [qoder.md](./qoder.md)）。第 8 条是本轮补的：能力发错位置时没有任何报错，只是子代理完成后父回合永远等不到通知。

## 证据

**已实测**：initialize 返回、authenticate 成功、`session/new` 的完整返回（含 29 个模型）、`session/list` 的实际结果、完整工具调用三帧、权限请求的形状与回应、回合正常走完（`stopReason: end_turn`）、token 缺失。

2026-10-21/22 补测：`_meta.subagents` 的能力开关（四种写法对照）、`subagent_spawned` / `subagent_state_update` 与子会话帧、`task` 工具调用的双发与派发即 `completed`、`session/set_config_option` 切模型、`session/resume → -32601`、三个「通知式」扩展方法按请求到达。

**抓到的原始帧已存为夹具**：`packages/dsh-acp-agent/tests/fixtures/captured-frames.cursor.json`（基础帧）。子代理的双发形状按真机抓帧写进 `tests/subagent-frames.spec.ts` 的 `cursor delegation published twice` 组，泵内去重由 `subagent-wiring.spec.ts`、`mid-turn-tools.spec.ts` 与 `runsteps.spec.ts` 分别钉住。

**未实测**：`cursor/ask_question` / `cursor/create_plan` 的真实触发形状；失败工具的 `status` 取值；`session/load` 加载旧会话的行为；多层委派（子代理再开子代理）。
