# codex 的 ACP 对接

> 核对时间：2026-10-09 首测；2026-09-14 补充 `initialize`、set_model/set_mode、终端子协议三项实测；2026-10-22 复测模型写入路径；2026-10-23 复测推理档位与 agent 自己的默认模型
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

模型列表实测有 23 个，id 形如 `gpt-6-astra[high]`（基础模型 × 推理档位）。

## 最容易踩的坑

### 0. 「一直不出字」多半不是 agent 坏了，是它连不上 OpenAI（2026-10-26 现场）

codex 的模型请求走 chatgpt.com（登录也走它）。**网络走不通时，agent 不会报错退出，只会一遍遍重连**，界面上表现为「转圈、没有任何输出」，几分钟后才可能自己放弃。

判断办法（三条，从快到慢）：

1. 会话日志里只有一条 system/message「等待外部 agent——已静默 30s；agent 最近输出：（无输出）」，之后没有任何帧 → agent 起来了但没在说活；
2. 进程还在（`pgrep -f codex-acp`），CPU 几乎不动 → 它在等网络，不是在算；
3. **codex 自己的日志在 `~/.codex/logs_2.sqlite`（不是 stdout、不是 stderr）** —— 用 sqlite 读 `logs` 表，能看到它连的是哪个地址、报什么错。2026-10-26 那次：`stream_responses_websocket … tls handshake eof`、`error sending request for url (https://chatgpt.com/…)`，重试到 5 次。

本机那次的原因是**代理被切成了直连**：Clash Verge 的运行模式是 `direct` 时（`~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/config.yaml` 里的 `mode: direct`），所有流量直连，chatgpt.com 在这条网络上本来就走不通（本地 DNS 给的是被污染的地址），TLS 握手直接失败。**改成 `rule`（规则）模式就好了**——规则集最后一条 `Match -> ClashGit.com` 会把非国内域名交给代理节点，节点到 chatgpt.com 是通的（实测各节点延迟 111–251ms）。

顺带一条：这一轮**不是我们的写模型路径坏了**——codex 的日志里能看到 `model=gpt-6-astra codex.turn.reasoning_effort=medium`，说明选型与档位都送到了；DSH 这边只是看不到任何帧。

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

## 选模型：prompt 里的 `modelId` 不生效，走 `session/set_model`

2026-10-22 对 codex-acp 1.10.0 的握手实测（不跑回合）：

- `session/prompt` **不读** `params.modelId`；codex 的 prompt 处理只取会话状态里的 `currentModelId`。
- `session/set_config_option { configId: 'model', value: 'gpt-5.6-sol' }` 接受**基础 id**，返回更新后的 `configOptions`。
- 同一个方法送组合 id `gpt-6-astra[low]` 会报 `-32602 Invalid params`。
- `session/set_model { sessionId, modelId: 'gpt-6-astra[low]' }` 返回 `{}`，**组合 id 由它接收**。

`session/new` 的 `models.availableModels` 有 23 个 id，形如 `gpt-6-astra[low]`（基础模型 × 推理档位）；DSH 的模型选择器就是按这份列表展示的。所以本项目的写入口是 `session/set_model`（`modelVia: 'set_model'`），而不是 prompt 参数，也不是 `set_config_option`——后者的选项里只有 `gpt-6-astra` 这类基础 id，送组合 id 会被拒。

**列表外与裸基础 id 的实测**（2026-10-22，codex-acp 1.10.0）：

- 送列表里没有的组合 id（如 `definitely-removed-model[low]`）→ `-32603 Internal error`，`data.details: "Unknown model …"`。
- 送裸基础 id（如 `gpt-6-astra`）→ 同样 `-32603`，`data.details: "Unsupported format of modelId: … Expected: modelId[effort]."`——**`set_model` 只收带档位的组合 id**。

因此 runner 在写入前用同一份 `session/new` 报告的 id 集合校验：不在集合里 → 本地以「模型 … 已不在 agent 当前提供的模型列表中，请重新选择模型」结束；裸基础 id 且该模型仍有可用档位 → 本地提示「需要先选择推理档位」。两种情况都**不再把注定失败的请求送给 agent**。报告为空（agent 不公布模型）时不校验，保持原样透传。**每回合的选择门同样按这份最新报告判账**，而不是配置里的静态清单：报告里有、配置里没有的 id 能直接选中；报告为空时才退回配置清单。

> 历史记录：旧版 codex-acp 的 `session/set_model` 曾返回 `-32603 Internal error`，实机测试用 `.catch(() => {})` 把错误吞掉，导致“选型从未生效”被藏了很久。1.10.0 已恢复；接新版本时必须重新验证，别让错误再被 catch 掉。

（`session/set_mode` 正常：不存在的 mode 会回 `Invalid params`。）

## 推理档位：agent 只认带档位的 id，选中什么档位就得送什么档位（2026-10-23 复测）

模型选择器把 codex 的 23 个组合 id 收成「一个基础模型 + 一串档位」，选完之后发过来的是**基础 id + 档位**两样（如 `gpt-6-astra` 与 `xhigh`）。codex 那边只收组合 id，所以这两样必须在写入前重新合成 `gpt-6-astra[xhigh]`——**合成发生在 runner 里**：档位丢了或没带上，codex 只会回一句 `Unsupported format of modelId: … Expected: modelId[effort].`（桌面版会话 633df594，2026-10-23：同一轮先不带档位、再带 `xhigh`，两次都死在这句上）。

2026-10-23 对 codex-acp 1.10.0 的握手实测：

- `session/new` 的 `models.currentModelId` = **`gpt-6-astra[medium]`**——这是 agent 自己就在用的模型，**档位也在里面**。用户只点了基础模型（选择器里的「提供方默认」）时，它就是那个默认的答案：基础 id 对得上、档位取 agent 自己的。
- `configOptions` 里有 `model`（只列基础 id：`gpt-6-astra` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`）与 `reasoning_effort`（category `thought_level`，值 `low` / `medium` / `high` / `xhigh` / `max` / `ultra`，当前 `medium`）。**这是另一条可用的写入路径**（先写基础 id、再写档位），本项目仍走 `set_model`——组合 id 由它收，写一次就够。
- 送列表外的组合 id（`gpt-6-astra[ultra]` 这类没被公布的）→ 仍然是 `-32603`；本地先按报告里的 id 集合判账，不送注定失败的请求。

于是 runner 的写入规则是三条：**选中的 id agent 原样公布了 → 原样送**；**基础 id + 档位 → 合成 `基础[档位]` 再送**；**只有基础 id → 用 agent 自己当前的模型（`models.currentModelId`，基础对得上时）**，这样「提供方默认」这一档就是 agent 自己的默认，而不是一句注定失败的裸基础 id。三条都不成立时，仍然本地以「模型 … 已不在 agent 当前提供的模型列表中，请重新选择模型」结束。

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

codex 的 `session/new` 里那五个 `configOptions`（含 `reasoning_effort`、`fast-mode`）也值得留意——本项目目前取了模型列表，并用 `session/set_model` 写入选型；`reasoning_effort` / `fast-mode` 未接。

## 证据与未验证项

**已验证**（`tests/live.spec.ts`）：建会话拿到非空模型列表、拿到回答、产生了工具调用、工具输出含探针串（即 `rawOutput.formatted_output` 这条路走通了）。

**本轮新增实测**：`initialize` 的完整能力声明（见上）、`session/set_mode` 的校验、**未观察到 `terminal/*` 调用**；2026-10-22 复测模型写入：prompt 的 `modelId` 被忽略，`set_config_option` 只收基础 id，`set_model` 收组合 id。

**仍未验证**：`configOptions` 里的 `reasoning_effort` / `fast-mode` 能否设置；工具失败时的 `status` 取值。collab 模式的委派行为已随 `subagents` 接入验证了单层委派；多层委派（子代理再开子代理）未测。
