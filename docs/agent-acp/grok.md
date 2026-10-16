# grok 的 ACP 对接

> 核对时间：2026-10-09 首测；2026-09-14 补充 `initialize` 能力声明实测
> 状态：**本项目已实现并通过实测**。实现见 `packages/dsh-acp-agent/src/dialects/grok.ts`，回归夹具见 `packages/dsh-acp-agent/tests/fixtures/captured-frames.json`。

## 一句话结论

grok 是三者里唯一**不走 stdio**、也唯一**把 shell 执行外包给客户端**的。接它要解决两件事：WebSocket 传输，以及 terminal 子协议。两者都不做的话表现是「握手成功但回合静默卡住」。

## 怎么跑起来

```
grok agent serve --bind 127.0.0.1:<port> --secret <secret>
```

客户端连：`ws://127.0.0.1:<port>/ws?server-key=<secret>`

**密钥在查询参数里，没有 Authorization 头。** 这是从 agent 行为上测出来的，代码里看不出来，两处都必须对，否则握手被拒。

`--bind` 不带端口时回落到 grok 默认端口。仓库里的做法是给每次探测分配一个随机高位端口，避免撞车。

**就绪判定必须是真的握手，不是「端口开了」。** 端口检查分不出「带密钥的 serve」和任何别的监听器——密钥不匹配正是靠这个漏过去、直到会话晚些时候才失败的。

## 接口形状

标准流程与另外两家一致，**不需要 `authenticate`**（它声明了 `cached_token` / `grok.com` 两个 authMethods，但 `initialize` 后直接建会话即可）：

```
initialize → session/new → session/prompt
```

期间收 `session/update`，需要批准时收 `session/request_permission`。

`session/new` 返回 `{ sessionId, models: { currentModelId, availableModels } }`。

## 最容易踩的坑

### 1. 工具名只在第一帧，之后会被覆盖

grok 把工具名放在 `title` 里，但**只在开场那一帧**。后面每一帧 `tool_call_update` 都把 `title` 覆写成人类可读的活动行，比如 `Execute \`echo ...\``。

不锁定的话，最终显示的工具名会变成一整条命令。这是实测踩过的。

### 2. 输出嵌套两层

grok 的输出在 `content` 里，且比别家多一层：

```
[{ type: 'content', content: { type: 'text', text } }]
```

直接读 `content[].text` 全部读空。

### 3. token 数只在更新帧的 `_meta` 上

grok 是三者中唯一把 token 数放在 `session/update` 的 `params._meta.totalTokens` 的。codex 和 claude 都放在 `session/prompt` 的**响应**里。

### 4. 一条命令算一次工具调用（grok 会合并）

grok 会把多条命令用 `;` 串起来当成**一次**工具调用。所以「工具调用条数 ≠ 用户命令条数」，做统计或做断言时别按命令数对。

### 5. 失败状态不可靠

grok 即使命令失败也报 `status: 'completed'`。本项目的处理是**忠实反映、不自行推断**。因此界面上的错误提示可能不准，这是已知限制。若要改判断依据，只能从输出文本里看，不能从 status。

## terminal 子协议：不做就静默卡死

这是 grok 特有的一条，也是最容易漏的一条。

**grok 自己不执行 shell 命令，它要求客户端执行**，然后轮询结果。涉及五个方法，必须全部应答：

| 方法 | 作用 |
|---|---|
| `terminal/create` | 起进程，返回 `terminalId` |
| `terminal/wait_for_exit` | 等结束，返回退出码 |
| `terminal/output` | 取已产生的输出 |
| `terminal/kill` | 杀掉 |
| `terminal/release` | 释放 |

**只答前一个不答后面，看起来是「半能用」**：回合能结束，但工具结果是一句「后续调用无法提供」的抱怨。五个必须一起实现。

不提供时的正确姿势是**每个都回 JSON-RPC 错误**，让 agent 能报告失败，而不是永远等着。

**注意 DSH 自己拒绝了这个子协议**：把执行路由回客户端会把它fork成第二个后端，绕过它自己的环境清洗和后台任务归属。所以本项目的做法是**把 spawn 注入进来**——由宿主决定怎么起进程，但协议照样服务。这条路是通的。

**不提供终端服务时的症状**：agent 等一个永远不会出现的 terminal，回合无报错、无超时地挂住。

## 会话能力与私有扩展

`initialize` 声明 `sessionCapabilities` 的 `list` / `resume` / `close` 三项（**没有** `fork`、`delete`）、`loadSession: true`、`mcpCapabilities.http` / `sse`。注意 `promptCapabilities.image` 是 **false**。

私有扩展在 `_meta` 上：`x.ai/fs_notify`、`x.ai/hooks`（含 `pre_tool_use`/`stop`/`subagent_stop` 阻塞事件）、`x.ai/capabilities.toolOverrides`。

**本轮新增实测**：`initialize` 的完整能力声明、`authMethods`、`promptCapabilities.image` 为 false。

## 1.0.60 复测（2026-10-20）

本机 grok 已从 1.0.46 升到 1.0.60，三点复测结论：

- **`agent serve` 可用；冷启动慢、热启动秒起**：grok 1.0.60 把重活放在共享的后台主进程（`grok agent leader`）里——第一次启动要把认证/更新等做完才打印地址与密钥，之后的 serve 挂在现成 leader 上直接成功（正常终端实测，2026-10-20）。传输层的就绪等待默认 30 秒（`waitForPort`）：热启动绰绰有余，唯一暴露窗口是开机/登出后的第一次冷启动，其耗时未计时，若实际超过 30 秒需加长默认值。
- **`agent stdio` 也可用且接受子代理草案字段**：initialize 带 `clientCapabilities.subagents` 正常应答，可作备选传输。能力声明仍是 `list` / `resume` / `close` 三项（无 `subagents`），`_meta.x.ai/hooks` 仍含 `subagent_stop`。

## 子代理帧：grok 的私有一套（2026-10-20 真机抓包）

grok 不实现草案 #1992，但**确实报告子代理生命周期**，用自己的方法名和字段（真机抓包存 `tests/fixtures/captured-subagent-frames.json`，单测 `subagent-frames.spec.ts` 直接照它钉死）：

| 帧 | 方法 | 关键字段 | 投影 |
|---|---|---|---|
| `subagent_spawned` | `_x.ai/session_notification` | `child_session_id` / `subagent_type` / `description`（无 `task` 字段，description 即任务描述） | `subagent` 卡片（`{prompt: description, agent: subagent_type}`） |
| `subagent_progress` | 同上 | 纯指标：`tokens_used` / `duration_ms` / `context_usage_pct` 等 | 丢弃——没有正文，造进度行等于编造 |
| `subagent_finished` | 同上 | `status` / `output`（子代理的最终回答整段在此） | 卡片结果；非 completed 记错误 |

三个要点：全部帧挂在**父会话**名下（不像草案用子会话编号标内容帧，grok 不流子会话内容）；方法名是私有的 `_x.ai/session_notification`（方言的 `frameUpdate` 钩子认领它，否则帧进不了投影门）；委派同时还有一次普通的 `spawn_subagent` 工具调用帧——工具卡和子代理卡**并存**，各自如实。
- **排查时注意**：受限网络环境下 serve 拉不起来（启动时回连 grok.com 被挡，横幅后无声悬挂）——这是之前误判「serve 坏了」的原因，不代表生产故障。

## 权限请求

和其他家一样是阻塞式：**必须用 JSON-RPC 响应回同一个 id**。

用通知（无 id）回会被 agent 静默接受，然后回合永远不返回——实测挂满 240 秒预算，无错误、无超时、无后续帧。

选项映射按 `kind` 找 `allow_once` / `allow_always` / `reject_once`，回 `{outcome:{outcome:'selected', optionId}}`。

## 噪声帧

这几个不是会话内容，要滤掉：

- `available_commands_update`
- `usage_update`
- `session_info_update`

## 证据与未验证项

**已验证**（`tests/live.spec.ts`，需 `THREADHARBOR_LIVE_ACP=1`）：建会话、拿到非空模型列表、拿到回答、工具名含 `run_terminal_command`、工具输出含探针串。

**仍未验证**：失败命令的真实状态字段（已知不可靠）、多命令合并的具体边界、终端子协议之外是否还有别的子协议、`session/load` 加载旧会话。
