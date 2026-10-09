# Cursor 的 ACP 对接

> 核对时间：2026-09-14
> 来源：官方文档 <https://cursor.com/docs/cli/acp.md>（本文的接口定义以它为准）+ 本机实测
> 状态：**官方支持，本项目尚未接入。** 帧形状未做实机验证（原因见文末「为什么没跑实测」）。

## 一句话结论

Cursor 是四家里**唯一有官方 ACP 文档**的，接口定义清楚，可以照着写。但本项目**还没接**，且实测卡在登录态上——`initialize` / `session/new` 能过，真发提示词返回未授权。

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

## 完整接口定义

### 流程

```
1. initialize
2. authenticate           （methodId: "cursor_login"）
3. session/new  或  session/load
4. session/prompt
5. 处理 session/update 通知（流式输出）
6. 处理 session/request_permission 并返回决定
7. 需要时 session/cancel
```

### 鉴权

官方声明的 ACP 鉴权方法是 `cursor_login`。但**更实际的做法是启动前就带上凭据**：

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

**`session/load` 官方说是「恢复已有对话」，但能否加载桌面版建的会话未实测。** 如果能，Cursor 就是四家里「接进来直接看得到桌面版历史」的那一家——和 CodeBuddy（登录态与数据分离）正相反。这是接之前值得先验的一件事。

## 接进本项目要改的地方

本项目的扩展点集中在 preset 配置上，加一个 agent 需要：

1. **新增一个 dialect**（`dialects/cursor.ts`），实现工具名、输出、模型列表、token 的读取规则
2. **在 `factory.ts` 的 `DIALECTS` 里登记**
3. **实现两个阻塞式扩展方法**（否则会卡住）
4. **把可执行文件路径做成配置项**（避开 `~/.local/bin/agent` 冲突）
5. 确认 `session/new` 的模型列表从哪读——**官方文档没有列出** Cursor 的 `session/new` 返回模型列表，另外三家都是在 `session/new` 里给的

第 5 点是接之前必须实测确认的。

## 为什么没跑实测

`agent acp` 的二进制需要下载（约 350MB 的 SEA 包）。本机探测时：

- 官方安装脚本会覆盖本项目在用的 `~/.local/bin/agent`（见上），不能直接跑
- 改为手工下载解压到临时目录，但下载在核对时间内未完成（拉到约 95MB）

**所以本文的接口定义来自官方文档，帧形状未经实机验证。** 官方文档里有可直接运行的最小 Node 客户端示例，接入时以它为起点跑通，再抓真实帧补这份文档。

**不要把本文当成实测结论用**——尤其「模型列表来源」和「扩展方法的实际触发时机」两处，文档没写、必须实测。
