# Qoder 的 ACP 对接

> 核对时间：2026-10-20
> 来源：官方文档 <https://docs.qoder.com/zh/cli/acp>、<https://docs.qoder.com/zh/cli/cli-reference>、<https://docs.qoder.cn/cli/installation> + **本机实机探测**（qoder-cli-cn 1.1.6，已完成 `qoderclicn login`）
> 状态：**已实现，已实测。** qoder dialect（`packages/dsh-acp-agent/src/dialects/qoder.ts`）与 `acp-qoder` 预设行已落地；协议形状、工具投影、权限应答、取消、图像、新会话回放都跑过真回合，`live.spec.ts` 的 6 个 Qoder 用例全部通过（2026-10-20）。

## 一句话结论

Qoder **不开源**，但**官方支持 ACP**：`qoderclicn --acp`（国际版 `qodercli --acp`）把 CLI 变成 stdio 上的 JSON-RPC 服务，这是唯一受支持的接入方式。

帧形状**最接近 Cursor / codex**：工具名在 `_meta.qoder.toolName`，输出在 `rawOutput` 或 `_meta.terminal_output.data`，权限请求的 id 是 **0**。和 Cursor 不同的是，**认证不是硬门槛**：CLI 登录过之后 `session/new` 直接成功，反而主动调 `authenticate` 会偶发挂满超时。

## 开源与安装

**结论：不开源。** Qoder CLI 是闭源商业产品，npm 包里只有打包好的二进制（本机 CN 版是约 100 MB 的单文件可执行程序），没有可读源码；ACP 的协议行为只能靠实机抓帧确认。协议本身（ACP）是公开标准。

安装方式（官方文档）：

| 版本 | 命令 | 可执行文件 |
|---|---|---|
| 国际版 | `npm install -g @qoder-ai/qodercli` / `curl -fsSL https://qoder.com/install \| bash` / `brew install qoderai/qoder/qodercli --cask` | `qodercli` |
| 国内版 | `npm install -g @qodercn-ai/qoderclicn`（或官方安装脚本） | `qoderclicn` |

本项目默认按国内版二进制名写示例，国际版把命令换成 `qodercli` 即可；`agent: qoder` 的方言与启动参数两边通用。

登录是**一次性交互动作**，在终端完成：

```sh
qoderclicn login
```

凭据留在 CLI 自己的配置目录（本机在 `~/.qoder-cn`），本项目不读、不复制、不另设密钥。

## 启动方式

```sh
qoderclicn --acp
```

**裸启动不是 ACP。** 不带 `--acp` 时它是交互式终端，会一直等 stdin 上的按键，一个 JSON-RPC 字都不回——进程活着，握手只能等到超时，报「agent 没应答」，看不出是参数漏了。

项目里这条事实只写一次，在 `packages/dsh-acp-agent/src/spawn-args.ts` 的参数表：

```ts
qoder: ['--acp'],
```

生产 factory 与 live 测试都从这张表取，preset 里不需要再写 `args`（写了则以配置为准）。

## 两个坑

### （1）IDE 的环境变量会让 CLI 拒绝启动

从 Qoder IDE 的终端里启动时，环境里带着 IDE 自己的 SDK 入口标记。CLI 看到它们，会误判自己是被 IDE 当 SDK worker 拉起的，直接退出：

```
sdk_invalid_args: Agent SDK entrypoint env is set but required flags are missing
```

实测命中过的变量包括 `QODER_AGENT_SDK_ENTRYPOINT`、`QODER_SDK_AUTH_PAYLOAD_FILE`、`QODER_CONFIG_DIR`、`QODER_WORKER_*`、`QODERCN_*`，以及 VS Code 的 IPC 句柄（`VSCODE_*`）。**这些变量不影响 `qoderclicn login` 的结果，只影响无头启动。**

生产代码在拉起 qoder 子进程时剥掉这些前缀（`stdioEnvFor('qoder')`，见 `spawn-args.ts`）：spawn 的 `env` 是整体替换，所以返回的是一份完整过滤后的副本，`PATH` / `HOME` 等照常保留。其它 agent 不动，继续继承本进程环境。

### （2）`authenticate` 不是每回合必经步骤

**登录之后，`initialize` 完可以直接 `session/new`。** 实测 374 ms 建出会话，完全不需要 `authenticate`。

反过来，**即使已经登录，主动调 `authenticate` 也会偶发挂住**：三次抓包里两次等满 120 秒超时，一次秒回 `{}`。所以本项目对 Qoder 用**按需认证**：

1. 先直接 `session/new`；
2. 只有它报 `-32000 Authentication required` 时，才调 `authenticate`，然后重试一次；
3. 其它打开失败原样抛出，不认证、不重试。

方法 id 也不写死：CN 版是 `qoderclicn-login`，国际版不同。dialect 从 `initialize.authMethods` 里取带 `login` 的那个，取不到就用第一个。

> 这和 Cursor 正好相反。Cursor 的 `session/new` 永远要求先 `authenticate`，所以它保留「握手后立刻认证」的旧路径。两种策略由 dialect 的 `authenticateOnDemand` 决定，流程在 runner 里统一实现。

## 流程

```
1. initialize                        ← 正常
2. initialized                         （通知；本 build 回 -32601，无害）
3. session/new                       ← 登录后直接成功；未登录报 -32000
4. （仅 -32000 时）authenticate  → 重试 session/new 一次
5. session/set_mode  （可选）
6. session/prompt
```

`initialized` 被 Qoder 回 `-32601 Method not found`。它只是通知，客户端不等响应，所以这条拒绝只出现在 agent 日志里，不影响回合。

## initialize 返回（实测）

```json
{ "protocolVersion": 1,
  "authMethods": [ { "id": "qoderclicn-login", "name": "Use qoderclicn login", ... } ],
  "agentInfo": { "name": "qoder-cli-cn", "title": "Qoder CLI CN", "version": "1.1.6" },
  "agentCapabilities": {
    "_meta": { "qoder": { "promptQueueing": true } },
    "loadSession": true,
    "sessionCapabilities": { "additionalDirectories": {}, "close": {}, "delete": {},
                             "fork": {}, "list": {}, "resume": {} },
    "promptCapabilities": { "image": true, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true } } }
```

能力声明很全：会话的 list/resume/close/delete/fork 都在，图像输入声明为支持。`_meta.qoder.promptQueueing` 是它自己的扩展，与 ACP 标准无关。

## session/new 返回（实测）

```
{ sessionId,
  models: { availableModels: [ { modelId, name, description }, … ] },   // 15 个
  modes: { currentModeId: "default",
           availableModes: [default, acceptEdits, bypassPermissions, plan] },
  configOptions: [ … ] }
```

模型列表就在 `models.availableModels`，字段与 grok / codex / cursor 一致（`modelId` / `name` / `description`）。**`modelId` 没有 Cursor 那种方括号参数后缀**，可以原样展示、原样回传。

实测 15 个模型：

| modelId | 名称 | 档位说明 |
|---|---|---|
| `auto` | Auto (default) | Reasoning · Vision · 0.50x Credit |
| `fast` | Fast | Reasoning · Vision · 0.80x Credit |
| `qmodel_38max` | Qwen3.8-Max | 0.50x |
| `qfmodel` | Qwen3.8-Flash | 0.00x |
| `qmodel_latest` | Qwen3.7-Max | 0.50x |
| `qmodel` | Qwen3.7-Plus | 0.10x |
| `q37fmodel` | Qwen3.7-Flash | 0.10x |
| `dmodel` | DeepSeek-V4-Pro | 0.50x |
| `dfmodel` | DeepSeek-Flash | 0.00x |
| `gmodel` | GLM-5.3 | 0.80x |
| `gfmodel` | GLM-5.3-Flash | 0.10x |
| `gm51model` | GLM-5.2 | 0.60x |
| `kmodel_latest` | Kimi-K3 | 1.40x |
| `kmodel` | Kimi-K2.8-Preview | 0.80x |
| `mmodel` | MiniMax-M3.1-Flash | 0.10x |

**模式（实测 4 个，官方 ACP 文档只写了 2 个）**：`default`（动手前询问）、`acceptEdits`（自动批准编辑）、`bypassPermissions`（跳过权限检查）、`plan`（只读）。默认 `default`。

## 工具帧（实测）

| 阶段 | `sessionUpdate` | `status` | 携带字段 |
|---|---|---|---|
| 调用 | `tool_call` | `pending` | `_meta.qoder.toolName`、`kind`、`rawInput`、`content` |
| 中间输出（Bash） | `tool_call_update` | **没有** | `_meta.terminal_output.data` |
| 完成 | `tool_call_update` | `completed` | `rawOutput`（字符串）、`content` |

实测工具名：`Bash`、`Read`、`Edit`、`Write`、`Grep`、`Glob`。

```
title    = "echo ACP_LIVE_OK"          ← 人看的活动行，不是工具名
kind     = "execute"                    ← ACP 标准类别，不是具体工具
rawInput = { "command": "echo ACP_LIVE_OK", "description": "Echo ACP_LIVE_OK" }
_meta.qoder.toolName = "Bash"          ← 唯一可靠的工具身份
```

**三个要点：**

1. **工具名只能取 `_meta.qoder.toolName`。** `title` 会随帧变化（权限请求里同一个调用写的是 `Edit probe.txt`），`kind` 只有 `execute/search/edit/read` 之类的大类，都会把 Bash 和别的 shell 工具混成一类。
2. **输出只认 `rawOutput` 与 `_meta.terminal_output.data`。** 完成帧的 `rawOutput` 是**纯字符串**（不是 codex 那种对象）。Bash 的中间帧把终端字节放在 `_meta.terminal_output.data`。`content` 在**开始帧**是工具的**输入回显**（Read/Glob/Grep）或**预览 diff**（Write/Edit）——把它当输出读，等于把请求原样当成结果打印出来。
3. **`toolCallId` 是普通字符串**（`call_09222dd685024da097b9ce66`），没有 Cursor 那种内嵌换行符的毛病。

方言的 `toolFrameShape` 因此是 `two_frame`：开卡帧 + 可选的中间输出帧 + 完成帧，投影层按同一张卡折叠。

## 权限请求（实测）

**请求 id 是 `0`。** 和 Cursor 一样，`if (frame.id)` 会把它当成没有 id 的通知漏掉，回合永远不返回。客户端统一用 `typeof frame.id === 'number'` 判断。

请求帧：

```
params.options = [
  { optionId: "proceed_always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "proceed_once",   name: "Allow",                   kind: "allow_once"   },
  { optionId: "cancel",         name: "Reject",                  kind: "reject_once"  } ]
params.toolCall = { toolCallId, status, title, kind, rawInput, content,
                    _meta: { qoder: { toolName: "Write" } } }
```

两点要注意：

- **`toolCall` 里没有 `name` 字段**，工具名只在 `toolCall._meta.qoder.toolName`。共享客户端默认读 `name`，所以 dialect 提供了 `readPermissionToolName` 钩子。
- 选项 id 是 `proceed_*` / `cancel`，不是 Cursor 的 `allow-*`；客户端按 **kind** 选（`allow_once` 优先，其次 `allow_always`，再退到 `optionId` 以 `allow` 开头），不依赖 id 拼写。

回应形状（实测有效，回完回合正常走完）：

```json
{ "outcome": { "outcome": "selected", "optionId": "proceed_once" } }
```

## token 用量：v1.1.6 全为 0

`session/prompt` 的响应**带** `usage`，但每个字段都是 0；`_meta.quota` 里也是 0：

```json
{ "stopReason": "end_turn",
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
  "_meta": { "quota": { "token_count": { "input_tokens": 0, "output_tokens": 0 } } } }
```

一个明显用掉了 token 的回合报 0，说明这个版本的用量统计没接通。**0 不是测量值**，方言因此返回 `undefined`，界面上不显示，而不是写「0 进 / 0 出」。

## 取消：已实测

`session/cancel` 能中断进行中的回合。实测让 agent 跑 `sleep 90`，第一帧工具调用之后 3.7 秒发出取消，回复 `stopReason: "cancelled"`，之后不再有该回合的帧。`live.spec.ts` 的取消用例要求在 5 秒内结束。

## 噪声帧与私有扩展

过滤掉的会话更新：

- `available_commands_update`
- `current_mode_update`
- `config_option_update`
- `session_info_update`
- `usage_update`（带的是上下文窗口占用，不是 token 计数）

`_meta.qoder` 下还有 `promptQueueing`、`terminal_output`、`terminal_exit`、`terminal_info` 等私有字段。后三个只作为**输出/退出状态**读取，不发起 ACP 的 `terminal/*` 子协议。

> 官方文档说 Qoder 会「通过 ACP 协议使用 IDE 侧的 Terminal / 文件能力」。**本轮实测没有观察到它发 `terminal/*` 或 `fs/*`**——Bash 由它自己的工具循环执行，输出走 `_meta.terminal_output`。生产代码仍对所有 preset 挂载终端服务，这是正确的默认，不要因为「没观察到」去掉。

## 接进本项目要改的地方（已落地）

1. **新增 `dialects/qoder.ts`**：工具名取 `_meta.qoder.toolName`；输出取 `rawOutput` / `_meta.terminal_output.data`；模型取 `models.availableModels`；零用量报 `undefined`
2. **在 `factory.ts` 的 `DIALECTS` 登记** `qoder`
3. **`spawn-args.ts` 加 `--acp`**，并在同一张表旁边说明裸启动是交互式 CLI
4. **`stdioEnvFor('qoder')` 剥掉 IDE/SDK 环境变量**，生产与 live 测试共用
5. **按需认证**：`authenticateMethodIdFrom` + `authenticateOnDemand` + `sessionNeedsAuthenticate`
6. **权限请求工具名**：`readPermissionToolName` 读 `_meta.qoder.toolName`
7. **权限 id=0**：客户端本来就按 `typeof id === 'number'` 判断，无需改动，但测试必须钉住

## 证据

**已实测**：initialize 完整返回、登录后免认证直接 `session/new`、未登录的 `-32000`、主动 authenticate 的偶发挂起、15 个模型与 4 个模式、Bash/Read/Grep/Glob/Write 的完整工具帧、权限请求与应答、回合正常走完、取消、零用量、图像回合（四象限颜色识别）、工具帧一键一结果、新会话回放上一轮对话。

**抓到的原始帧已存为夹具**：`packages/dsh-acp-agent/tests/fixtures/captured-frames.qoder.json`，方言单测直接照它写。

**未实测**：工具失败时的 `status` 取值（只见过 `pending` / `completed`）、`session/load` / `resume` 的实际行为、`fs/*` 与 `terminal/*` 子协议、国际版的具体 `authMethods` id 与模型清单（CN 版实测，国际版按同一方言处理）。
