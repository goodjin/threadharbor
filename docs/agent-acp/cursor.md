# Cursor 的 ACP 对接

> 核对时间：2026-09-14
> 来源：官方文档 <https://cursor.com/docs/cli/acp.md> + 本机实机探测（`cursor-agent-sea`，构建 2026.10.01-e373342）
> 状态：**官方支持，本项目尚未接入。** 握手与鉴权行为已实测；**模型列表来源和扩展方法的实际触发时机未实测**（需先完成登录）。

## 一句话结论

Cursor 是四家里**唯一有官方 ACP 文档**的，接口定义清楚。但**它是唯一一家「握手之后还有一道硬门槛」的**：`initialize` 能过，但 `session/new` 直接返回「需要鉴权」，`authenticate` 又会**挂住等交互式登录**。不先完成 `agent login`，后面一步都走不了。

## 一个必须先知道的坑：安装会覆盖本项目在用的 `agent`

Cursor 的安装脚本第 128 行会执行：

```
rm -f ~/.local/bin/agent ~/.local/bin/cursor-agent
ln -s ~/.local/share/cursor-agent/versions/<版本>/cursor-agent ~/.local/bin/agent
```

**本项目的 grok agent 正是通过 `~/.local/bin/agent` 这个符号链接提供的**（它指向 `~/.grok/bin/agent`）。装 Cursor 的 agent 会把这个链接删掉，**grok 随即不可用**。

本项目同时依赖 grok 和其他 agent，**接 Cursor 前必须先把可执行文件路径做成可配置项**，不要依赖 `~/.local/bin/agent` 这个名字。这是接入前的硬前置，不是可选项。

## 怎么跑起来

```
agent acp
```

- 传输：stdio
- 封装：JSON-RPC 2.0
- 分帧：一行一个 JSON（换行分隔）

日志走 stderr，不在协议里——和另外三家一样，客户端要能忽略 stderr 的噪声。

**本机探测还发现两件装机器的事：**

- 官方安装包（约 350MB）里的 `cursor-agent-sea` **完全没有代码签名**，macOS 会直接杀掉它（退出码 137）。本地试跑需要先 `codesign --force --sign -` 补一个临时签名。这不影响官方正常安装路径，但**自建部署时会踩到**。
- 手动下载的平台目录是 `darwin/arm64`，不是 `mac/arm64`（后者 403）。

## 完整接口定义

### 流程（实测确认：鉴权是硬门槛）

```
1. initialize                        ← 能过
2. authenticate  methodId:"cursor_login"   ← 不做这步，下一步直接失败
3. session/new  或  session/load
4. session/prompt
5. 处理 session/update 通知（流式输出）
6. 处理 session/request_permission 并返回决定
7. 需要时 session/cancel
```

**实测的三个结果：**

| 调用 | 未登录时的结果 |
|---|---|
| `initialize` | ✅ 正常返回 |
| `session/new` | ❌ `-32000 Authentication required`，提示先跑 `agent login` 再调 `authenticate` |
| `authenticate {methodId:'cursor_login'}` | ⚠️ **不返回**——挂住等交互式登录 |
| `session/list` | ❌ `-32000 Authentication required` |

所以流程的实际前置是：**必须先在终端完成一次 `agent login`**，之后 `authenticate` 才能秒回。另外三家都是 `initialize` 完直接 `session/new`，**只有 Cursor 多这一道**。

### initialize 返回的实测内容

```json
{ "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "audio": false, "embeddedContext": false, "image": true },
    "sessionCapabilities": { "list": {} } },
  "authMethods": [ { "id": "cursor_login", "name": "Cursor Login", ... } ] }
```

注意 `loadSession: true` 和 `sessionCapabilities.list`——**Cursor 声称能列出和加载已有会话**，这正是下面「与桌面版的关系」那一节的关键。

### 鉴权

官方声明的 ACP 鉴权方法是 `cursor_login`。更实际的做法是启动前就带上凭据：

```
agent login
agent --api-key "$CURSOR_API_KEY" acp
agent --auth-token "$CURSOR_AUTH_TOKEN" acp
```

也可走环境变量 `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`。根命令还支持 `-e`（端点）和 `-k`（TLS）。

### 模式

| 模式 | 含义 |
|---|---|
| `agent` | 完整工具权限 |
| `plan` | 规划、只读 |
| `ask` | 问答、只读 |

这三个可以直接映射到本项目的审批模式。

### 权限请求

`session/request_permission`，返回三种之一：

- `allow-once`
- `allow-always`
- `reject-once`

**官方明确写着：不回应权限请求，工具执行会卡住。** 这不是推测——和 grok 那条实测的挂死是同一类问题，也印证了本项目设计里「权限桥接必做」这条。

### MCP

- 支持项目级 / 用户级 `.cursor/mcp.json`
- **不支持** dashboard 上配置的团队级 MCP（ACP 模式下）
- 从项目目录启动 `agent`，并批准要用的 server

## 需要额外处理的：ACP 之外的自定义扩展方法

Cursor 会发**标准 ACP 里没有**的自定义方法。这是接 Cursor 时最需要额外写代码的地方。

**阻塞式**（agent 等你回，回不回决定它走不走）：

| 方法 | 用途 | 回什么 |
|---|---|---|
| `cursor/ask_question` | 多选提问 | `{outcome:{outcome:"answered", answers:[{questionId, selectedOptionIds}]}}`，或 `skipped` / `cancelled` |
| `cursor/create_plan` | 请求批准计划 | `{outcome:{outcome:"accepted", planUri?}}`，或 `rejected` / `cancelled` |

**通知式**（发了就发了，不回也没关系）：

| 方法 | 用途 |
|---|---|
| `cursor/update_todos` | 待办状态更新 |
| `cursor/task` | 子 agent 完成 |
| `cursor/generate_image` | 生成了图片 |

**对本项目的直接影响**：本项目的 ACP 客户端遇到不认识的方法会回 JSON-RPC 错误（`client cannot serve <method>`）。对通知式方法这没影响，但对**两个阻塞式方法，这意味着 agent 会停下来等一个永远不会来的回应**。

所以接 Cursor 必须实现 `cursor/ask_question` 和 `cursor/create_plan`——否则多轮对话会在提问处停死。这两条本项目现在都没有。

其中 `cursor/update_todos` 值得单独接：DSH 的会话界面有 todo 展示，接上能白得一个 UI 能力。

## 与桌面版的关系

**ACP 在 CLI 上，不在桌面版。** 本机实测：Cursor.app 3.24.9 全包检索，`session/new`、`session/prompt`、`agentclientprotocol`、`agent-client-protocol` 全部为 0。（`sessionUpdate` 有命中，但上下文是语音功能的 `sessionUpdateFrame()` / `speakGreeting`，与 ACP 无关。）

**CLI 和桌面版共用同一套 worker，CLI 侧没有独立会话库：**

- 桌面版 globalStorage 下有 `cursor-agent-worker` 进程目录
- `~/.cursor/agent-cli-state.json` 按项目路径记录 workerId
- `~/.cursor` 下**没有任何** chat / conversation / session 文件；会话正文在桌面版的存储里（`state.vscdb` 的 `glass.agentConversationPanes.*` 键，以及 `conversation-search.db`，436 条）

**`session/load` 官方说是「恢复已有对话」，但能否加载桌面版建的会话未实测。** 初始化返回里明确声明了 `loadSession: true` 和 `sessionCapabilities.list`，**说明枚举和加载会话的能力是存在的**——但这两个方法在未登录时同样返回鉴权错误，所以必须先完成 `agent login` 才能验。

如果能通，Cursor 就是四家里「接进来直接看得到桌面版历史」的那一家——和 CodeBuddy（登录态与数据分离）正相反。**这是接 Cursor 之前最值得先验的一件事**，验法：登录后调 `session/list`，看列出来的会话与桌面版 `conversation-search.db`（436 条）里的 ID 是否对得上。

## 接进本项目要改的地方

本项目的扩展点集中在 preset 配置上，加一个 agent 需要：

1. **新增一个 dialect**（`dialects/cursor.ts`），实现工具名、输出、模型列表、token 的读取规则
2. **在 `factory.ts` 的 `DIALECTS` 里登记**
3. **实现两个阻塞式扩展方法**（否则会卡住）
4. **把可执行文件路径做成配置项**（避开 `~/.local/bin/agent` 冲突）
5. 确认 `session/new` 的模型列表从哪读——**官方文档没有列出** Cursor 的 `session/new` 返回模型列表，另外三家都是在 `session/new` 里给的

第 5 点是接之前必须实测确认的。

## 剩下没验的两件事

实机探测卡在登录态上，所以下面两项**没有实测数据，不要当结论用**：

1. **`session/new` 返回的模型列表从哪读。** 另外三家都是在 `session/new` 里给（`models.availableModels` 或 `configOptions[id=model]`）。官方文档**没有列出** Cursor 的 `session/new` 返回内容，这一项必须登录后抓真实帧才能写进 dialect。
2. **两个阻塞式扩展方法的实际触发时机。** `cursor/ask_question` 和 `cursor/create_plan` 在什么情况下会发、发的频率如何，文档只给了类型定义。

## 接入前的准备顺序

1. 先把可执行文件路径做成配置项，**避开 `~/.local/bin/agent` 冲突**（见上）
2. 终端里完成一次 `agent login`，确认 `authenticate` 能秒回
3. 登录后重跑探测，**把真实的 `session/new` 返回和工具帧存进 `tests/fixtures/captured-frames.json`**
4. 据此写 `dialects/cursor.ts`，实现两个阻塞式扩展方法
5. 按 `live.spec.ts` 的标准验收

第 3 步不能省——本文的其余部分都是从官方文档和探针推出来的，只有第 3 步之后的内容才是实测的。
