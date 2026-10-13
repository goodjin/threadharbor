# zcode 的 ACP 对接

> 核对时间：2026-10-13 底层通道实机复核（建会话 → 提问 → 工具调用 → 权限 → 取回回复，全部跑通）；
> 同日事件流补测（tool.lifecycle / usage.delta / permission.lifecycle 均已抓到实测帧）；
> 同日**实现落地并真机验收**（适配器冒烟：握手 1.6s、模型清单、Bash 工具帧、消息文本、usage、密钥零泄漏）。
> 状态：**已实现，已实测。** 适配器在 `packages/zcode-acp`（构建产物 `lib/zcode-acp.js`，单文件可执行），
> dialect 在 `dsh-acp-agent/src/dialects/zcode.ts`，factory 已注册 `agent: zcode`，组合里已有 `acp-zcode` 预设行。

## 一句话结论

zcode 桌面端**不是 ACP**，说的是自有协议（"ZCode Protocol"，ndjson、无 `jsonrpc` 键、zod strict 校验）。
所以它和其余四家都不同：光写 dialect 不够，**必须自带一个适配器进程**——对 DSH 说 ACP，对 zcode 的
`app-server` 子进程说自有协议。落地形态：`packages/zcode-acp` 做适配器，`dsh-acp-agent` 第五个 dialect，
factory 注册 `agent: zcode`，组合里一行 preset。装好即出现在模型列表。

## 与四家的根本差异

| | grok / codex / claude / cursor | **zcode** |
|---|---|---|
| 官方 ACP | 有（各自 CLI/serve） | **无**，自有协议 |
| 接入成本 | 一个 dialect | **dialect + 适配器进程**（新包） |
| 传输 | stdio / WebSocket | stdio（适配器内部再 spawn `zcode.cjs app-server`） |
| 鉴权 | 各家自带 | 本机凭证解密（见下）注入反向请求 |

对照表里其他列（工具名/输出/模型表位置）对 zcode **由我们自己的适配器决定**——两端都是自家代码，
帧形状照 codex 的惯例发（`.models.availableModels`、`session/prompt` 响应带 usage），dialect 就近复用，
不需要像四家那样迁就外部实现。

## 底层通道（全部实测）

### 拉起后端

```
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server
```

- `cwd` 设为工作区；stdin/stdout 各一行一个 JSON 对象。
- **必须带两个环境变量**，否则 Provider Registry 为空、一切模型调用报 provider_not_found：
  - `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=$HOME/.zcode/v2/runtime/provider/darwin-aarch64/<最新版本>/endpoint-*/zcode-builtin.json`（glob 取最新，勿写死 3.14.4）
  - `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=$HOME/.zcode/v2/provider_config.json`

### 消息形状（不是 JSON-RPC，与 ACP 封套恰好相反）

带 `jsonrpc` 键直接 -32600 拒绝。四种形状：客户端请求 `{id,method,params}`、响应 `{id,result|error}`、
服务端通知 `{method,params}`、**服务端反向请求 `{id,method,params}`——15 秒内必答**，漏答任何一个，
挂起的调用整体 -32022 超时。

### 启动握手（顺序执行）

1. 等约 1.5s（进程启动、写日志）。
2. `provider/updateAccountConfig` 声明账号权益（桌面就是这么注入子进程的）：
   `providers` 值只允许 `{builtinModelIds, access:{type,entitled}}`（strict，多传会被拒）；
   `basedOnZCodeBuiltinRevision` **强校验**——从本次进程新写入的 `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`
   里找 `event=="zcode_protocol.provider_registry.ready"` 的 `context.configRevision`（JSON 字符串数组）取 `[0]`。
   做法：spawn 前记录日志 offset，之后只读新增行。app 升级后靠这个动态解析自愈。
3. 应答服务端反向请求（核心，见下表）。

### 反向请求应答表

| 服务端反向请求 | 应答 result | 说明 |
|---|---|---|
| `session/requestRuntimePreferences` | `{"nativeSearchEnhancementsEnabled":true,"memoryEnabled":true}` | 勿传 subagentRuntimeConfigEnabled，可少触发一个请求 |
| `subagents/readRuntimeConfig` | `{"kind":"built-in-fallback"}` | 若仍来 |
| `interaction/requestProviderRuntimeHeaders` | `{"headersApplied":true,"requestAuth":{"apiKey":"<解密的key>"}}` | **每轮模型请求前都会来**，鉴权注入点，漏答=model_request_failed |
| `interaction/requestPermission` | **转发给 DSH 审批**（见下） | 工具权限 |
| `interaction/requestUserInput` | error -32001 | 暂不支持的问答式输入 |
| 其余未知 `interaction/*` | 一律 error 防挂起 | create 等不受影响 |

### 会话生命周期

- 建：`session/create` `{workspace:{workspacePath:X,workspaceKey:X}(两键同值), persistence:"immediate", mode:"build|yolo|plan|edit|guarded"}`。
- 恢复：`session/resume` `{sessionId, workspace}`。
- 发消息：`session/send` `{sessionId, content, modelSelection:{providerId:"account:bigmodel-individual-coding-plan", modelId, options:{reasoningLevel}}}`。
  **GLM-5.3 必带 reasoningLevel**（low/high/max，缺了 invalid_model_request）。返回 `{accepted:true}` 只是排队成功。
- 取消：`session/stop` `{sessionId}`。
- 取历史：`session/messages` → 最后一条 assistant 的 text parts（正文兜底路径）。
- 订阅：`session/subscribe` `{sessionId, deliveryKind:"desktop-continuous", includeSnapshot:false}`。

### 事件流（2026-10-13 补测，工具信号比预期丰富）

| 事件 | 关键字段 | 用途 |
|---|---|---|
| `v4/telemetry/event kind=tool.lifecycle` | `phase: scheduled\|started\|…`、`toolCallId`、`toolName` | **工具卡片**：scheduled→开头帧，完成→结束帧 |
| `v4/telemetry/event kind=permission.lifecycle` | `phase: requested`、`requestId`、`toolCallId` | 与权限请求对账 |
| `v4/telemetry/event kind=usage.delta` | `inputTokens`、`outputTokens`、`totalTokens`（分项！） | **turn usage**：取轮内最后一次汇总 |
| `v4/telemetry/event kind=turn.terminal` | `status: success\|failed`、`tokenCount`、`toolCallCount`、`durationMs` | 轮次终态 |
| `v4/telemetry/event kind=stream.chunk` | `channel: thought\|text`、`chunkLength`（**无正文**） | 只能驱动"生成中"，不能出增量文本 |
| `session/event`（完成帧） | `payload.content` = 完整助手正文、`stopReason`、`usage` | **agent_message_chunk 的正文来源** |
| `state.updated` | `patch.status: running`、`reason: prompt_started` | 轮次开始的旁证 |

**没有的东西**：工具输出正文、流式正文。工具卡片输出留空（结束帧照发），消息走轮末一次性全文——
与 codex 的 two_frame 形状兼容，投影层无需改动。

### 权限转发（零猜测设计）

`interaction/requestPermission` 的 params 自带 `options` 数组，每个选项带 `{optionId, name, kind, response:{decision,…}}`——
**ZCode 把答案模板发给你了**。所以：

1. 把 ZCode 的 options 原样翻成 ACP 的（`optionId` 不变，`kind` 映射：allow→allow_once/allow_always，deny→reject_once）；
2. 以 agent→client 请求 `session/request_permission` 转给 DSH 审批服务；
3. 客户端选中某 `optionId` 后，**把对应 ZCode 选项的 `response` 原样回给 ZCode**；
4. 取消/未匹配 → 找 deny 选项的 response 兜底。

不需要猜协议形状，升级也不易坏。实测样例（Write 工具）：`allow_once` / `allow_project`（带 permissionUpdates
规则模板）/ `deny` 三个选项，response 里 `decision: allow|deny`。

### 凭证（无需抓包/钥匙串）

`~/.zcode/v2/credentials.json` 键 `account-provider:coding-plan:…:api-key`，值 `enc:v1:<iv>.<tag>.<ct>`（b64url），
AES-256-GCM：key = sha256(`zcode-credential-fallback:<platform>:<homedir>:<username>`)。
**username 必须用 `os.userInfo().username` 等价物**（按 uid 查），`os.login()` 之类会取错导致 InvalidTag。
解出即 api-key（约 49 字符），只在内存用，勿打印/落盘。node 内置 `crypto` 即可，**无第三方依赖**。

## 实施清单（已全部落地，2026-10-13）

1. **新包 `packages/zcode-acp`**：TS 适配器，入口打成带 `#!/usr/bin/env node` 的单文件可执行（`command:` 直接指它）。
   职责：凭证解密 → spawn app-server（两个 env）→ updateAccountConfig 握手（日志尾读 revision）→
   应答全部反向请求 → 会话生命周期映射 → 事件投影成 ACP 帧。协议事实照抄本文，勿再逆向。
2. **方言 `dsh-acp-agent/src/dialects/zcode.ts`**：模型表读 `.models.availableModels`（codex 式）、
   工具名开头帧 `title` 锁定（grok 式铁律）、usage 直通（自家发标准名）、capabilities：
   `cancelsTurns: true`、`acceptsImageContent: false`、`toolFrameShape: 'two_frame'`、
   `toolNameMap`: Write→edit、Read→read、Bash→bash、Grep→grep、Glob→glob…（claude 式短名）。
3. **注册**：`dsh-acp-agent/src/index.ts` 导出；`dsh-preset-dispatch/src/factory.ts` 的 `DIALECTS` 加 `zcode`。
4. **preset 行**（`cordis.patch.yml` + `docs/install-plugins.zh.md`）：`presetId: acp-zcode`、`agent: zcode`、
   `command: <适配器路径>`、静态 `models`（GLM-5.3 / GLM-5.3-Flash / GLM-5.2，可带 contextWindow）。
   静态表先让选择器渲染，首轮 `session/new` 上报后运行时表替换。
5. **测试**：方言单测（夹具用本文事件表的实测帧）；适配器对假 app-server 的单测
   （`packages/zcode-acp/tests/`，假后端 `fixtures/fake-app-server.mjs`）；真机活测挂 `THREADHARBOR_ZCODE_ACP`。
6. 模式映射：ACP `session/set_mode` → `session/setMode`（build/plan/edit/yolo/guarded ↔ 自定义 modeId）。

## 坑清单（全部踩过）

1. 两端封套相反：对 ACP 加 `jsonrpc`，对 ZCode **绝不能加**。
2. 反向请求 15s 必答；`interaction/requestProviderRuntimeHeaders` 每轮模型请求都来，漏答表现为 model_request_failed。
3. `basedOnZCodeBuiltinRevision` 强校验 → 日志动态解析（见握手）。
4. GLM-5.3 必带 reasoningLevel。
5. 空会话不落库；桌面侧栏只收跑过 turn 的会话——别拿"侧栏看不到"当失败。
6. CLI `-p` 无头模式是死路（registry 空、不走 updateAccountConfig 注入），别试。
7. 并发写库：桥与桌面共用 `~/.zcode/cli/db/db.sqlite`（WAL），并发安全，但别手工写库。
8. 事件路由按 `params.sessionId`（所有事件都带）；单活跃轮次兜底。
9. 适配器内部权限转发要在**独立线程/异步任务**里等 DSH 应答，不能堵住 app-server 的读取循环，
   否则后续反向请求（鉴权头等）排队超时。
10. **真机反向请求用的是字符串 id**（实测 2026-10-13：`session/requestRuntimePreferences` 以字符串 id 到达，
    只认数字 id 的分支会把它当普通通知丢掉，15s 后报 -32022）。识别分支要放宽到"有 id 且有 method 即反向请求"，
    应答时原样回传收到的 id。这条只适用 ZCode 侧；ACP 侧面向 DSH 仍必须用数字 id。

## 验收（已执行，2026-10-13 真机）

1. ✅ 模型列表出现 zcode（preset 行静态表），建会话提问得回复，stopReason=end_turn，usage 齐全
   （冒烟脚本两轮：纯文本轮与 Bash 工具轮，握手 1.6s）。
2. ✅ 工具调用投影：tool_call（Bash/execute/pending）→ in_progress → completed，消息文本完整送达。
3. ✅ 权限转发：假后端单测验证选项翻译与 response 模板原样回传（真机该轮 ZCode 自行放行 echo，未触发弹窗）。
4. ✅ 取消路径：假后端 FAKE_HANG 单测验证 session/stop → turn.terminal → stopReason=cancelled。
5. ✅ 密钥不出现在任何日志/打印（真机 stdout+stderr 全量扫描 CLEAN；适配器 stderr 透传便于诊断）。
6. ✅ 现有四家回归不受影响（全量 736 通过 / 24 跳过；方言注册是纯新增）。
