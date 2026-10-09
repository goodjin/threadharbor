# grok 的 ACP 对接

> 核对时间：2026-10-09（`grok agent serve`，grok 1.0.46）
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

标准流程与另外两家一致：

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

**未验证**：失败命令的真实状态字段（已知不可靠）、多命令合并的具体边界。
