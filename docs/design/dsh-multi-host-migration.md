# ThreadHarbor 迁移到 DSH 原生多主机架构 · 设计与实施方案

> 状态：设计已定，待执行
> 核对时间：2026-09-14
> 核对基准：`deepseek-harness` 官方 master `5badb15009`；本机 DSH 0.2.0-rc.2；grok 1.0.46
> 修订：补入界面适配一章（§七）；更正 claude 支持状态的误述（§五）
> 原型验证：ThreadHarbor `packages/dsh-grok-agent`，已对真实 grok 跑通

---

## 一、目标

把 ThreadHarbor 从「gateway + hostd + 独立 ACP 桥」的自研栈，迁移到「**每台机器跑一个 DSH，agent 由插件提供**」的架构，消除 hostd 这一独立监督进程。

迁移后应当成立：

1. 每台被管理的机器运行一个 DSH（含本机）
2. codex / grok / claude 作为 DSH 插件存在，不再需要 hostd 常驻
3. 界面按 **主机 → 项目 → 会话** 分组
4. 每台主机自报可用 preset、模型、设置，互不影响
5. 中途切换 agent 可用（历史完整交接）
6. 旧 hostd 路径在全部迁移完成前一直可用

---

## 二、已核对的关键事实

以下每条都来自官方源码或真实运行，不含推测。新会话执行时请勿凭印象推翻，但若 DSH 升级需重新核对。

### 2.1 关于 DSH agent 架构

| 事实 | 出处 | 影响 |
|---|---|---|
| 全仓唯一实现完整 `Agent` 能力的是 `ReactLoopAgent` | `packages/core/agent-loop/src/agent.ts` | 我们要做的是第二个实现 |
| `Agent` 是**开放接口**，可被任意插件实现 | `packages/core/agent/src/runtime-types.ts` 的 `interface Agent` 合并声明 | 方案成立的前提 |
| agent 工厂位**只能占一个**，重复注册直接抛错 | `packages/core/agent/src/index.ts` 的 `setFactory` | 不能靠注册第二个工厂接进去 |
| 工厂槽字段是 TS `private`，**不是** `#private` | 同上，`private factory: FactorySlot \| undefined` | 运行时可读可改 |
| `createAgent` 里**写死** `new ReactLoopAgent(...)` | `packages/core/agent-loop/src/index.ts` L576 | 没有构造器注入口 |
| `CreateAgentOptions` 里 `meta.agentPreset` **被 agent-loop 完全忽略** | agent-loop 源码中零处引用 preset | preset 不参与选择实现 |
| 会话头里带 preset：`session.header.meta.agentPreset` | `packages/core/session/src/types.ts` L158 | **可以在运行时按 preset 分流** |
| `turn()` 负责全部回合/步骤边界记账，把模型工作交给 `step()` | `packages/core/agent-loop/src/agent.ts` L296–397 | `step()` 是唯一需要替换的接缝 |
| `step()` 返回 `StepEndReason \| null`，完成时返回 `{ kind: 'completed' }` | 同上 L398；`TurnEndReason.completed` 见 session types L202 | 替换契约极简 |
| `step()` 是 TS `private`，运行时只是原型方法 | 同上 | 可通过原型改写替换 |
| agent-loop 服务名是 `ctx.agentLoop` | `packages/core/agent-loop/src/index.ts` L355 | 可用 `inject` 约束加载顺序 |
| 生命周期相关私有方法（`prepare`/`setupAndPublish`/`initializeAgent` 等）**外部零引用** | 全仓搜索确认 | 但我们仍然选择不抄（见 §四） |

### 2.2 关于会话事件词汇

DSH 会话日志能表达 ACP 的全部输出，无需扩展：

| ACP 侧 | DSH 侧 |
|---|---|
| 助手正文 | `assistant/message`（`text` 内容块） |
| 助手思考 | `assistant/message`（`reasoning` 内容块，`packages/llm/llm/src/types.ts` L67） |
| 工具调用 | `tool/call { callId, name, arguments }`（arguments 保持原始字符串，不解析） |
| 工具结果 | `tool/result { message: ToolResultMessage }`，message 含 `role:'tool'`、`source:{kind:'tool',callId}`、`toolCallId`、`isError` |
| 回合/步骤边界 | `turn/start`、`turn/end`、`step/start`、`step/end` |

读日志的代码**明确容忍「没有 turn 事件的 agent」**（`packages/core/agent/src/types.ts` 中 `TurnBoundaryProjection` 注释：能力缺失 ≠ 数据损坏）。这是官方对「agent 不发 turn 事件」的显式让步。

### 2.3 关于模型列表（重要，修正早期误判）

- **DSH 原生 agent**：模型列表来自 `modelCatalog()`，是 **Host 级**能力（`packages/api/session-controller`），能实时查，不需要会话。
- **外部 agent（codex/grok/claude）**：模型列表只有 ACP `session/new` 的返回里才有，**没有「列出模型」的公开接口**。

**结论**：外部 agent 的模型列表**只能在建会话时获得**。但由于我们的建会话流程本身就是「建会话时拿到模型」，所以**正常建会话路径不需要任何探测**。仅在「不建会话偷看另一台主机的模型」这一非主流场景才需要探测，且可复用已有会话缓存。

grok 实测：`session/new` 返回 `{ sessionId, models: { currentModelId, availableModels[] } }`，同一帧内。

### 2.4 关于中途切换 agent

DSH **硬拦**：`AgentPresetRegistry.select()` 检查回合边界，会话已开始即抛 `agent-preset/locked`（`packages/preset/agent-preset-registry/src/index.ts`）。

**结论**：中途切换只能走「新会话 + 完整历史交接」。ThreadHarbor 现有 `session.switch` 已实现并测试，直接复用。

### 2.5 实测得到的 grok ACP 细节（读代码看不出来）

1. 连接地址是 `ws://host:port/ws?server-key=<secret>`，**不是** Authorization 头
2. 建会话前后有十余条 `_x.ai/session/setup` 阶段通知（auth / resolve_workspace / folder_trust / plugin_registry / mcp_merge / persistence_init / spawn_session_actor / agent_build / model_switch）与 `_x.ai/mcp/servers_updated`，**均非对话内容，必须过滤**
3. 回合过程中会发 `available_commands_update`，同样不是对话内容
4. 思考与正文是两种不同的更新类型，分别投影为 reasoning / text 内容块
5. `_meta.totalTokens` 携带 token 计数 → **跨 agent 交接会保留 token 数**（优于现有实现）
6. **工具调用有 bug 陷阱**：首个 `tool_call` 的 `title` 是工具身份（`run_terminal_command`），后续 `tool_call_update` 会把 `title` 覆写成人话描述（`Execute \`echo ...\``）。**工具名只能取首帧**
7. 工具输出是**双层嵌套**：`content: [{ type:'content', content:{ type:'text', text } }]`，需剥两层
8. **grok 对失败的工具也报 `completed`**，`isError` 只能忠实反映 grok 的状态，不能自行推断

---

## 三、总体架构

```
┌─────────────────────────────────────────────┐
│ 本机 DSH（Gateway / 界面宿主）                │
│  ├─ ThreadHarbor UI 插件（主机树、会话树）     │
│  ├─ ACP agent 插件（按 preset 分流）          │
│  └─ agent-loop 原生（dsh preset 走这里）       │
└─────────────────────────────────────────────┘
        │  DSH 原生 remote 机制
        ▼
┌─────────────────────────────────────────────┐
│ 远端主机 DSH（每台一个）                       │
│  ├─ ThreadHarbor UI 插件（可只读投影）         │
│  ├─ ACP agent 插件（grok/codex/claude）        │
│  └─ agent-loop 原生                           │
└─────────────────────────────────────────────┘
```

要点：

- **不再有 hostd**。它看护 agent 进程、管理会话、把事件推给界面的职责，由 DSH 插件系统承担。
- **不再有 gateway 自研会话存储**。会话归各自主机的 DSH。
- 主机身份由我们的代码携带（见 §七），不依赖 DSH——DSH 的 `RemoteHostFacts` 只有 `home` 和 `isLoopback`，**没有主机身份**。

---

## 四、ACP agent 接入方案（方案乙）

### 4.1 为什么选这条路

三种接法对比：

| 方案 | 代码量 | 风险 |
|---|---|---|
| 甲：接管工厂，抄生命周期 | ~300 行 | 漂移风险集中在被抄的 300 行，官方一改就得对 |
| 乙：原型改写 + 按 preset 分流 | ~130 行 | 依赖一个私有方法的契约；失败时立刻报错 |
| 丙：纯工厂包裹 | ~30 行 | 生命周期仍要自己写，绕回甲的问题 |

**选乙**：被抄的代码越少，漂移面越小。

### 4.2 实际做法（比原计划更简洁）

原计划是「包装工厂位 + 继承 agent」。核对后发现**连工厂都不用碰**：

`session.header.meta.agentPreset` 运行时可读，所以：

1. 在插件加载时改写 `ReactLoopAgent.prototype.step`
2. 改写后的 `step()` 先看 `this.session.header.meta?.agentPreset`
3. 命中 ACP preset → 走 ACP 转发路径；未命中 → 调用原实现

**收益**：

- 不碰工厂位 → 无加载顺序依赖，无 `inject` 约束
- 不抄生命周期 → 收件箱、取消、空闲等待、作用域销毁、通知顺序全部原生
- 原生 agent 走原路径，**零行为变化**

### 4.3 ACP 路径的职责

替换掉的 `step()` 需要做：

1. 从 `decision.messages` 取出用户文本（**只取新增部分**，不重发历史——外部 agent 自己记历史）
2. 发送 ACP `session/prompt`
3. 收集期间到达的 `session/update` 帧
4. 用已验证的投影逻辑翻译成 DSH 会话事件并 append
5. 返回 `{ kind: 'completed' }`

**回合/步骤边界由原生 `turn()` 记账**，我们不重复发。

### 4.4 ACP 生命周期挂载

ACP 连接（`grok agent serve` 进程 + secret + sessionId）按 sessionId 惰性建立，与 agent 实例解耦：

- 首次 `step()` 时确保连接与原生会话存在
- 连接失败 → 按回合失败记账，不崩宿主
- 进程退出/重启后按 sessionId 重建；原生会话若已丢失则用 transcript 重建（复用现有 seedContext 思路）

### 4.5 已验证的部分

`packages/dsh-grok-agent/` 已完成并对真实 grok 验证：

- ACP 连接与握手（`initialize` protocolVersion 1 → `session/new`）
- 帧 → 会话事件投影（含工具名不被覆写、双层输出解包、token 计数保留）
- 7 个回归测试，用的是从真实 grok 抓下来的帧
- 全仓 520 个测试通过，类型检查干净

**执行时**：直接复用，不要重写。

---

## 五、多个 agent 的接入

### 5.1 统一抽象

每个外部 agent 实现同一套接入：

| 组成 | 职责 |
|---|---|
| Transport | 如何连（stdio / WebSocket） |
| Handshake | `initialize` + `session/new` |
| FrameProjection | `session/update` → DSH 会话事件 |
| Lifecycle | 进程拉起、secret 管理、重连 |

### 5.2 三个 agent 的差异

| agent | 连接方式 | 特有事项 |
|---|---|---|
| **grok** | `grok agent serve` + WebSocket + `server-key` | 已实测；阶段通知多需过滤；工具失败仍报 completed |
| **codex** | `codex-acp` 子进程 stdio | ThreadHarbor 已支持，接入层需新写 |
| **claude** | claude 的 ACP 适配器进程 | **ThreadHarbor 已支持**；接入层需新写 |

**重要更正**：本项目**已经支持 claude code 的 ACP**，迁移时 claude 不是从零开始。此前误以为它不支持会话，来源是读错了测试桩——真实代码里 `sessionCapable` 对 claude 取的是「claude 的 ACP 适配器是否装在这台机器上」，装了就为真，与「支不支持会话」无关。

因此三个 agent 的迁移起点是一样的：**ThreadHarbor 侧都已有可用的 ACP 通路**，要搬的是把它们接到 DSH agent 接口上，而不是实现 ACP 本身。

**grok 之外的两个仍需核对真实帧形状**（协议细节与 grok 不同，不能照抄）。

### 5.3 preset 注册

每个 agent 注册为一条 preset（`AgentPresetDefinition` = `id` + `name` + `plugins` 的 Cordis 组合）。

**preset 按主机独立**：DSH 的 preset 注册表本就是每进程一份，远端 DSH 只注册自己实际装了/登录了的 agent。因此**未装 codex 的主机不会显示 codex preset**，天然满足需求。

### 5.4 zcode（Z.ai / GLM）：不作为外部 agent 接入

**核对结论（2026-09-14，ZCode 3.14.5）：zcode 不支持 ACP，无法按外部 agent 接入。**

证据（对 `/Applications/ZCode.app/Contents/Resources/app.asar` 做符号检索）：

| ACP 必需标记 | 出现次数 |
|---|---|
| `session/new` | 0 |
| `session/prompt` | 0 |
| `session/update` | 0 |
| `agent-client-protocol` | 0 |

zcode 内部确实出现 `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` 这些名字，但它们读的是 `event.type`，是**zcode 自己的任务事件格式**，不是 ACP 的 `sessionUpdate` 结构。其 JSON-RPC 代码里带 `_meta`、`relatedRequestId`、`resumptionToken`，那是 **MCP（模型上下文协议）**——zcode 是 MCP 的使用者，不是 ACP 的提供者。

zcode 是 Electron 桌面应用，没有可被外部驱动的无头服务入口（`--headless` / `--serve` 均来自打包进来的 Playwright 依赖，不是 zcode 自己的命令行）。

**但这不等于接不进来——换一条路即可。**

zcode 自己调模型走的是 **Anthropic 兼容端点**：

```
https://open.bigmodel.cn/api/anthropic     （BigModel API Key）
https://api.z.ai/api/anthropic             （Z.ai）
https://zcode.z.ai/api/v1/zcode-plan/anthropic （编码套餐）
```

模型为 `GLM-5.3`、`GLM-5.3-Flash`。

而 DSH 的 `dsh-llm-pi-ai` **原生支持 `anthropic-messages` 协议**（含 `x-api-key` + `anthropic-version` 的模型发现）。

**所以正确做法是把 GLM 配成 DSH 的一个模型提供方，而不是把 zcode 当外部 agent 驱动：**

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      glm:
        api: anthropic-messages
        apiKeyEnv: ZAI_API_KEY
        baseURL: https://api.z.ai/api/anthropic
        models:
          - id: GLM-5.3
            contextWindow: 200000
          - id: GLM-5.3-Flash
```

**这样得到的好处远大于「又一个外部 agent」：**

- GLM 走 **DSH 原生 agent**，自带工具、审批、权限、会话恢复
- 不需要 ACP 桥接、不需要进程看护、不需要新写一套帧投影
- 模型列表由 DSH 的 Host 级目录提供，**实时可查**
- 在界面上它就是一个普通模型，而不是一个需要单独适配的 agent

**代价**：GLM 是「模型」不是「agent」。它没有 zcode 自己的工具集与工作流，走的是 DSH 的工具和循环。这是取舍，不是缺陷——若需要 zcode 那套特定行为，则另当别论（但那需要 zcode 提供 ACP 或 API，目前没有）。

**执行时**：阶段 2 之前先按上面配一条 GLM 路由验证可用（需 Z.ai 的 API Key，从 zcode 凭据处取或单独申请）。这一步独立于其他 agent，成功即可多一个可用模型。

---

## 六、模型列表在新建会话流程中的位置

```
用户点「新建会话」
  → 选 preset（按当前主机过滤）
  → 建会话（ACP session/new 或原生）
  → 此刻拿到真实模型列表
  → 选模型
  → 发出第一条消息
```

**与现有 ThreadHarbor 的草稿会话流程一致，无需改造。**

外部 agent 的探测会话（catalog probe）在新架构下**不再是常规路径**：
- 正常建会话天然拿到列表
- 仅「不建会话查看某主机某 agent 的模型」需要探测，且复用长驻会话缓存（30 分钟空闲回收）

---

## 七、界面适配

> 本章为后补。原设计只考虑了数据通路，漏掉了界面。这一节是实施前必须读的部分。

### 7.1 基本判断：会话区可以不变

DSH 的会话区是**渲染器**，不执行工具（工具由 agent 执行，界面只显示）。我们的投影写入的会话事件与原生循环写入的**完全同构**：

| 界面元素 | 依赖的事件 | ACP 路径是否提供 |
|---|---|---|
| 用户消息 | `user/message` | ✅ 原生 `turn()` 写 |
| 助手正文 | `assistant/message`（text） | ✅ |
| 思考过程 | `assistant/message`（reasoning） | ✅ |
| 工具调用与结果 | `tool/call` / `tool/result` | ✅ |
| 回合/步骤边界 | `turn/*`、`step/*` | ✅ 原生记账 |
| 停止生成 | `agent.cancel()` | ✅ 原生契约 |

**结论：切换 agent 不需要重写会话区。** 这是把 ACP 帧投影成 DSH 原生事件的核心回报——界面层完全复用。

### 7.2 但有四处真实差异，必须处理

**（1）流式输出会变成一次性出现。**

原生循环逐块产出，界面文字是逐步显现的。我们的原型在回合结束时一次性提交完整文本，用户会看到「等半天然后整段出现」。

处置建议：在 ACP 帧到达时增量提交（用 DSH 的流记录机制），而不是等回合结束。**这是体验差异里最明显的一条**，需在阶段 3 处理。

**（2）权限请求要接到 DSH 的审批界面。**

ACP 协议里外部 agent 会主动发权限请求（grok 执行命令前可能问）。ThreadHarbor 现有实现已经处理这个——遇到后端请求会把回合停在用户处，等回答再继续。

DSH 侧有**自己的**审批服务（`ask`/`never` 两种策略）。需要把 ACP 的权限请求桥接过去，否则外部 agent 要批准时会卡住。

**原型的 grok 测试没有触发过权限请求，这条未验证。** 需在阶段 2 专门验证。

**（3）输入框的模型选择器要能显示外部 agent 的模型。**

DSH 的模型选择器读的是 Host 级模型目录（来自 DSH 自己的厂商适配器）。外部 agent 不走这套，所以**选择器会显示 DSH 的模型，而不是 grok/codex 的**。

处置：外部 agent 会话的模型列表来自 ACP `session/new` 的返回，需要让选择器在 ACP 会话下改读这个来源。

**（4）工具的「执行中」状态会一闪而过。**

原生是「发出调用 → 执行 → 返回结果」，界面能看到中间态。我们把调用和结果在回合末一起提交，界面基本同时显示。

可接受，但若要精确还原执行进度，需要在 `tool_call_update` 到达时增量更新（grok 会发 `in_progress` / `completed` 状态）。

### 7.3 需要改动的地方汇总

| 位置 | 改动 | 阶段 |
|---|---|---|
| 会话区渲染 | **不改** | — |
| 工具执行中状态 | 可选优化 | 阶段 3 |
| 权限请求桥接 | **必做** | 阶段 2 |
| 输入框模型选择器 | **必做**（ACP 会话下换数据源） | 阶段 3 |
| agent/preset 选择器 | 按主机过滤可用 preset | 阶段 4 |

---

## 八、多主机互通

### 8.1 传输层

复用 DSH 原生 remote 机制：`dsh-api-gateway`（Gateway 持有 WebSocket mux）、`dsh-api-remotes`（转发 `api-session/*`、`approval/request`、`agent-preset/selected` 等事件）。

**重要边界**（来自官方 README）：
- 能力集合**构建时显式导入**，Client **不会在运行时发现** Host 上启用的服务 → 新增能力需显式挂载
- 单向通知是 **best-effort，不回放**；需要可靠恢复的状态必须由拥有方提供查询/游标/初始基线
- `dsh-api-remotes` **不拥有**物理传输和 Host 服务发现

### 8.2 主机身份（必须自己带）

`RemoteHostFacts` 只有 `home` / `isLoopback`，**没有主机身份**。所以：

- 每台 DSH 需配置一个稳定 **hostId**（建议 `hostname` 或显式配置）与人类可读 **hostTitle**
- 通过 remote 通道随会话/事件一起上报
- 界面按 hostId 分组；设置按 hostId 绑定

### 8.3 界面分组

```
主机 A
  ├─ 项目 X
  │   ├─ 会话 1（grok-4.7）
  │   └─ 会话 2（codex）
  └─ 项目 Y
主机 B
  └─ 项目 X        ← 同名项目在不同主机上是两个项目
```

- **主机分组**：按上报的 hostId
- **项目归属**：项目恰好属于一台主机；两台主机上的相同 basename 是两个项目
- **preset 可用性**：来自该主机自己的注册表
- **设置**：按 hostId 绑定，凭证留在主机侧不下发到浏览器

---

## 九、中途切换 agent

### 8.1 事实

DSH 硬拦（§2.4），不可绕过。

### 8.2 做法

复用 ThreadHarbor 已实现的 `session.switch`：

1. 读当前会话完整 transcript
2. 目标主机上选目标 preset（+模型）
3. 建新会话，把 transcript **完整交接**（不截断）
4. 目标 agent 承担不了那么长时**如实报错**，让用户换一个，而不是静默截断

跨主机切换时，交接文本需通过 remote 通道送达目标主机。

### 8.3 与「重新选择 preset」的区别

- **第一个回合之前**：DSH 原生支持改 preset（`select()`），可直接改
- **已经开始对话**：只能新会话 + 历史交接

---

## 十、实施计划

分阶段，每阶段独立可验证、可回退。**旧 hostd 路径在阶段 6 完成前一直保留。**

### 阶段 1：核对与固化（不写生产代码）

1. 把 DSH 源码更新到最新官方 master
2. 核对 §二 中所有事实是否仍成立（重点：工厂槽、`step()` 签名、`agentPreset` 在会话头）
3. 核对 **codex / claude** 的真实帧形状（grok 已核对；两者 ThreadHarbor 侧均已有可用通路）
4. **配置并验证 GLM 路由**（§5.4）：zcode 无 ACP，改走 DSH 原生模型提供方，需 Z.ai API Key
5. **验证 ACP 权限请求**：强制外部 agent 请求批准，确认桥接到 DSH 审批可用（§7.2-(2)，原型未覆盖）
6. 确认 DSH `remote` 的配对配置入口（认证、地址注册）

**产出**：一份核对结论，更新本文档 §二。

### 阶段 2：ACP 接入层通用化

1. 把 `packages/dsh-grok-agent` 的 transport / projection 抽成通用 ACP 接入层
2. 让 claude / codex 各实现一套 transport + projection
3. **桥接 ACP 权限请求到 DSH 审批服务**（§7.2-(2)，否则外部 agent 会卡住等批准）
4. 每套都用真实 agent 抓帧做回归测试

**验证**：每个 agent 独立跑通「建会话 → 提问 → 收到回答 → 工具调用正确投影」，且**权限请求能被批准并让回合继续**。

### 阶段 3：接进 DSH（方案乙）

1. 实现原型改写 + 按 preset 分流
2. 原生 dsh preset 回归验证零行为变化
3. grok preset 跑通完整会话
4. **输入框模型选择器在 ACP 会话下改读 ACP 模型列表**（§7.2-(3)）
5. **增量提交 assistant 内容，恢复流式观感**（§7.2-(1)）

**验证**：同一台 DSH 里，dsh 会话和 grok 会话共存，界面都能正常对话。

### 阶段 4：多主机

1. 每台 DSH 配置 hostId / hostTitle
2. 主机身份随会话上报
3. 界面按主机 → 项目 → 会话 分组
4. 设置按主机绑定
5. preset 可用性按主机过滤

**验证**：两台 DSH，界面能看到两边会话并按主机分组。

### 阶段 5：中途切换 agent

1. 复用 `session.switch`，支持跨 preset、跨主机
2. 历史完整交接

**验证**：在 grok 会话里切到 codex，历史完整保留；目标承担不了时报错而非截断。

### 阶段 6：下线 hostd

1. 三个 agent 全部迁移完成并稳定后
2. 删除 hostd 包与相关部署流程
3. gateway 退化为薄路由层或一并下线

---

## 十一、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `step()` 私有方法契约变化 | ACP 路径失效 | 阶段 1 每次 DSH 升级重新核对；改写处加断言，形状不符立即抛错 |
| 原型改写影响原生 agent | 回归 | 未命中 preset 必须严格走原实现；补原生 agent 回归测试 |
| codex / claude 帧形状未知 | 阶段 2 返工 | 阶段 1 先抓真实帧，不照抄 grok |
| 工具失败状态不可靠 | 界面错误提示不准 | 忠实反映外部 agent 状态，不自行推断；必要时从输出文本判断 |
| 权限请求未桥接 | 外部 agent 卡住等批准 | 阶段 2 专门验证；桥接到 DSH 审批服务 |
| 模型选择器仍显示 DSH 模型 | 选不到外部 agent 的模型 | 阶段 3 换数据源 |
| 流式观感丢失 | 「等半天整段出现」 | 阶段 3 增量提交 |
| DSH remote 不回放单向通知 | 丢事件 | 拥有方提供查询/游标/初始基线 |
| 主机身份需自建 | 分组做不出来 | 阶段 4 显式加 hostId 配置 |
| 历史交接超长 | 目标 agent 承担不了 | 按既定决策：**报错让用户换**，不静默截断 |

---

## 十二、给执行会话的提醒

1. **不要凭印象**。本文档 §二 每条都有出处；改动前先读源码，改动后更新本文档并标注核对时间。
2. **不要照抄 grok 到 claude/codex**。三者协议细节不同（已实测出 grok 至少两处代码里看不出来的坑）。但要注意：这三个的 ACP 通路 ThreadHarbor 侧**都已有可用实现**，是搬运不是从零实现。
3. **不要重写已验证部分**。`packages/dsh-grok-agent` 有真实帧回归测试，直接复用。
4. **每阶段做完先验证再进下一阶段**，别攒着一起验。
5. **hostd 在阶段 6 之前不要删**。