# 外部 agent 全量输出展示与子代理独立会话（设计）

- 日期：2026-10-19
- 状态：设计已获用户认可（组件解耦；未知块仅连续同类聚合；子会话等真实终态收尾）
- 前置：`docs/superpowers/specs/2026-10-18-acp-live-process-parity-design.md`（本规格复用其段落化流与 spawned 生命周期）
- 用户约束：只展示、不执行——插件不拦截、不注入提示词、不挂 MCP、不为子会话建代理（除非流通道载荷实测必须）

## 背景与目标

外部 agent（codex/claude/grok/cursor）通过 ACP 上报的帧里，有一批从未被映射成界面内容：
命令列表、会话信息、模式/配置变更、计划、用量帧、厂商私有生命周期帧（如 grok 的
`turn_completed`/`response_completed`）、以及子代理产生的各类状态帧。另有子代理本身
被压成父会话里的一张合成卡片（2026-10-18 规格的显式取舍），用户在会话列表里看不到它。

目标两条，**两个独立组件、一份设计**：

1. **未知输出块（通用）**：所有未映射的帧聚合成「未知块」落盘并展示，父会话、子会话、
   网关就地回答三处通用；默认收起、可点开。
2. **子会话独立会话化**：外部 agent 派出的子代理，在 DSH 会话列表（父会话顶部后代
   下拉树）里成为一个可打开的子会话，展示我们收到的全部信息。

组件一与组件二互不依赖，可分别验收；组件二复用组件一的通道。

## 组件一：未知输出块

### 1. 载体

新增插件自定义事件 `acp/raw-output`，落盘时带 `ignorable: true`
（`reference/deepseek-harness/packages/core/session/src/types.ts:511`：不认识的读者
必须跳过它；未知且有此标记不影响会话重建）。事件载荷：

| 字段 | 含义 |
|---|---|
| `turn` / `step` | 所属回合与步骤（与同会话其它事件同序） |
| `kind` | 帧种类（`sessionUpdate` 值或 `method` 值） |
| `format` | `'json'` 或 `'text'`（内容按 JSON 还是纯文本展示） |
| `content` | 聚合后的格式化内容（每帧一行，顶行注明帧数） |
| `count` | 聚合的帧数（1 表示单帧） |

落盘而非仅内存：运行中可见，刷新回放也在。

### 2. 纳入与排除

**纳入**：当前投影未映射的一切帧——
`available_commands_update`、`session_info_update`、`usage_update`、`current_mode_update`、
`config_option_update`、`plan`、厂商私有会话更新（grok 的私有方法与 `turn_completed`/
`response_completed` 等）、子代理/异步任务里未被卡片吸收的状态帧、以及今后新增的任何
`sessionUpdate` 种类。

**排除**：

- 已映射成内容/卡片的帧（正文、思考、工具调用、子代理卡片——不重复展示）；
- 我们发出去的请求与**客户端能力的应答**（我们替它读回的文件内容、终端输出）：那是我们
  执行的产物，不是它的输出，落进转录既吵又泄露内容；
- 客户端能力的**请求**（它要求我们读文件/跑终端）按「请求摘要」展示（`kind` 为
  `fs/read_text_file` 等，内容只含请求参数摘要，不含应答）；审批请求沿用现有审批卡片，
  不重复进未知块。

### 3. 聚合规则（用户拍板：仅连续同类）

- **只有连续出现的同类帧才合并**成一块；中间出现任何别的帧（已映射内容或不同种类）即
  另起一块。界面时间顺序严格保持。
- 单块内容超过大小上限（建议 8 KB 文本）时在连续段内切块。
- **步骤或回合结束时强制封块**：块不跨步骤、不跨回合，保证顺序与边界对齐。
- 封块时机决定事件的 seq：块出现在它「结束」的位置（日志追加写），即该连续段末尾。
  已知行为，写入规格。

### 4. 客户端组件

threadharbor 客户端插件新增一个会话节点定义（先例：
`packages/dsh-client/src/handover-card.ts` 的 `agentSwitchHandoverDefinition`）：

- 匹配 `acp/raw-output` 事件（非 surface 事件，DSH 自带的兜底节点不会与它竞争）；
- 渲染为一行折叠条：`外部输出 · <kind 标签>（N 帧）`，默认收起；点开展示格式化内容
  （JSON 缩进 / 纯文本按 `format`）；
- 文案进 `packages/dsh-client/src/locales.ts` 的 `zh`/`en` 词典（仓库本地化规则）；
- 纯展示组件，不发请求、不改会话。

## 组件二：子会话独立会话化

### 5. 建立

在 runner 的帧泵里（`packages/dsh-preset-dispatch/src/runner.ts` 的 `pumpNext` /
`trackSpawnedFrame` 路径，两条路径共用）：

- 收到子代理出生帧（`subagent_spawned`）时，用宿主接口创建一个带血缘的会话：
  `meta: { cwd: 父会话 cwd, parentSession: 父会话 id, origin: 'subagent',
  delegationDepth: 父+1, createdAt }`（字段依据
  `reference/deepseek-harness/packages/core/session/src/types.ts:138-153`）；
- 会话 id 用 `acp-sub-` 前缀 + 子代理会话 id，避免与 DSH 自身 id 撞车；
- 往**父会话**日志追加目录事件（`subagent/catalog`，`mode: 'one-shot'`，`label` 取名字），
  顶部下拉树据此列出并打开（客户端零改动；先例
  `reference/deepseek-harness/packages/subagent/subagent/src/catalog.ts:143-176`）；
- 名称优先级：出生帧 `name` → `task` 首段 → `description` → 会话 id；
- **前置门槛**：宿主必须组合了子代理能力包（下拉树的目录投影由它提供）。探测不到就整体
  跳过本组件（保留卡片）并记警告，绝不写宿主要拒绝的事件；
- **id 缺失降级**：grok 的出生帧不带子会话 id（实测），推迟到它的第一条子会话帧到达再建
  会话；若生命周期内始终没有子会话 id，只留卡片。

### 6. 内容与收尾

- 出生帧的任务/提示 → 子会话首条用户消息（它的输入）；无任务字段则用名称；
- 子会话的思考/正文增量 → 实时流逐帧显示（复用 2026-10-18 规格的流机制；用空壳会话对象
  满足载荷要求，见风险 1），到时落成带紧凑流的消息；段落规则沿用「段落化」设计（子会话
  的段落边界以其自身的回合结束帧为准，没有就整回合一段）；
- 未映射帧 → 走组件一的未知块（子会话内同样生效）；
- **收尾：只在真实终态到达时结束**（`subagent_state_update` 终态 / grok 的回合结束帧）：
  落最后一段消息 + 结束回合，结束原因如实映射（completed/failed/stopped）；用量若能读到
  就挂在该消息上，否则作为未知块展示；
- 父回合结束时仍未收尾 → **保持开放**（列表显示为未完成），不伪造结束，不写收尾事件；
- 父会话里的原合成卡片保持不变（回合末写「仍在运行」），与子会话互不冒充。

### 7. 与既有机制的关系

- 父会话卡片、spawned 结果的实时落盘（2026-10-18 规格）不变；子会话只是新增的**展示面**；
- 网关就地回答路径同样生效：父会话即被就地回答的原生会话，帧泵共用；
- 子会话只读，不提供续聊、不参与切换、不建代理。

## 明确不做

- 不执行、不拦截、不改外部 agent 的工具清单或提示词、不挂 MCP；
- 不为子会话创建真代理（除非风险 1 实测必须，才退而建一个空闲代理）；
- 子会话不可续聊；`async_task`（后台任务）不建子会话，保持卡片；
- 不改 DSH 宿主与 DSH 自带客户端包（只动 threadharbor 自己的客户端插件）。

## 风险（验收时实测）

1. **合成流载荷**：用空壳会话对象发 `agent/assistant-stream` 能否被宿主适配器接收（键为
   `agent.session.id`/`seq`）。不通则退「空闲代理」方案（建真代理只为发流）。
2. **子会话打开路径**：宿主对子代理来源会话有所有权限制，只读打开大概率可行；若被挡，
   组件二不成立，需回头再议（组件一不受影响）。
3. **事件准入**：`ignorable` 事件与 `subagent/catalog` 的落盘准入，以及旧客户端跳过行为。
4. **列表状态点**：无真代理时子会话行的「运行中」指示可能不准，内容不受影响。

## 测试

- 单测（组件一）：连续同类才合并；种类切换/已映射帧断开；超限切块；步骤/回合末强制封块；
  `ignorable` 事件落盘与回放；排除项（应答、审批）不进未知块；客户端节点的收起/展开/
  格式化与词典文案。
- 单测（组件二）：出生帧建会话 + 目录事件 + 血缘元数据；id 缺失降级（首条子会话帧建、
  始终缺失只留卡片）；任务提示映射为用户消息；终态收尾与原因映射；父回合结束保持开放；
  宿主无能力包时跳过且不写事件；父子会话 id 不串写。
- 活测：真实 codex 子代理回合——下拉树出现子会话、可打开、内容可读、终态收尾；未知块
  出现在对应位置且刷新后仍在。
- 验收：3081 实例（只经 `~/bin/dsh-web-3081`）跑真实回合，两条路径各看一轮。

## 证据索引

- 可忽略事件机制：`reference/deepseek-harness/packages/core/session/src/types.ts:511`
- 会话创建血缘元数据：`.../packages/core/session/src/types.ts:138-153`（`parentSession`/
  `origin: 'subagent'`/`delegationDepth`）
- 子代理目录事件：`.../packages/subagent/subagent/src/catalog.ts:143-176`；客户端目录投影
  `.../packages/api/session-controller/src/client/sessions/manager.ts:685`
- 客户端块渲染只认四类：`.../packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx:78-130`；
  未知块归「other」且不渲染：
  `.../packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts:110-120`
- 客户端节点先例（本地）：`packages/dsh-client/src/handover-card.ts:96-260`
- 帧泵与 spawned 生命周期：`packages/dsh-preset-dispatch/src/runner.ts`（`pumpNext`、
  `trackSpawnedFrame`、`closeSegment`）；投影 `packages/dsh-acp-agent/src/projection.ts`
  （`accumulate`、`readSpawnedFrame`、`spawnedCallOf`）
- 真实帧样本：`packages/dsh-acp-agent/tests/fixtures/captured-subagent-frames.json`
  （codex/claude 出生帧带 `subagentSessionId`，grok 不带；子会话帧含正文/思考/用户消息/
  回合结束）
