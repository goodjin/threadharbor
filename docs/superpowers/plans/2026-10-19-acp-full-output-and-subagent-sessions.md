# 外部 agent 全量输出展示与子代理独立会话 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把外部 agent 所有未映射的帧聚合成「未知输出块」展示（默认收起、点开可看），并把它的子代理投影成 DSH 会话列表里的独立子会话（只展示、不执行、等真实终态收尾）。

**Architecture:** 帧泵（`runner.ts`）在两条路径（接管/网关）共用；未知块由 `dsh-acp-agent` 的纯聚合器分类成块、经「可忽略」插件事件落盘，客户端插件新增折叠节点渲染；子会话由 `dsh-preset-dispatch` 新建模块按宿主会话接口创建带血缘的会话、追加父会话目录事件、复用既有流机制喂实时内容。

**Tech Stack:** TypeScript（ESM、`.ts` 相对导入）、vitest（根仓库 `pnpm vitest run <path>`）、jsdom + React 测试（客户端组件）。

**Spec:** `docs/superpowers/specs/2026-10-19-acp-full-output-and-subagent-sessions-design.md`（实现时随计划一起读；纳入/排除、聚合规则、收尾语义以规格为准）。

## Global Constraints

- **只展示不执行**：不拦截、不注入提示词、不挂 MCP、不为子会话建真代理；所有执行都在外部 agent 进程。
- 不改 `reference/deepseek-harness`（只读参考）与 DSH 宿主；客户端只动 threadharbor 自己的 `packages/dsh-client`。
- 未知块事件必须带 `ignorable: true`（不认识的读者跳过、不影响会话重建）。
- 聚合只合并**连续同类**帧；块不跨步骤、不跨回合；单块内容上限 8 KB。
- 子会话 id 加 `acp-sub-` 前缀；宿主无子代理能力包时零写入（只留卡片 + 警告）。
- 客户端可见文案进 `packages/dsh-client/src/locales.ts` 的 zh/en 词典。
- 3081 实例只能经 `~/bin/dsh-web-3081` 启停（数据目录由脚本固化）。
- 提交信息中文、动词开头，风格同仓库既有提交。

## Review Focus

1. **连续段边界**：已映射帧、种类切换、步骤/回合结束都必须断开未知块；块序与界面时间顺序一致（T1 聚合测试 + T5 泵内顺序测试）。
2. **grok 无 id 出生帧**：出生帧不带子会话 id 时不得丢信息——首次出现子会话帧才建会话，标签取自出生帧；始终没有子会话帧则只留卡片（T3 用例 + T4 接线用例）。
3. **无能力包零写入**：宿主没组合子代理能力包时不写目录事件、不写任何未知事件，只记警告（T3 门禁用例 + T4 无宿主用例）。
4. **父回合结束子会话保持开放**：不写 `turn/end`、不写伪造消息、实时流只放弃不收尾（T3 `parentTurnEnd` 用例 + T4）。
5. **排除项与串写**：协议应答、审批请求、我们替它执行的应答不进未知块；子会话的未知块只写子会话日志，不串进父会话（T1 分类测试 + T5 串写测试）。

---

### Task 1: 未知输出块聚合器（dsh-acp-agent）

**Files:**
- Create: `packages/dsh-acp-agent/src/raw-output.ts`
- Modify: `packages/dsh-acp-agent/src/index.ts`（导出）
- Test: `packages/dsh-acp-agent/tests/raw-output.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RawOutputBlock = {
    readonly turn: number
    readonly step: number
    readonly kind: string
    readonly format: 'json' | 'text'
    /** 首行「（N 帧）」，其后每帧一行。 */
    readonly content: string
    readonly count: number
  }
  export type RawOutputClassification =
    | { readonly kind: string; readonly format: 'json' | 'text'; readonly line: string }
    | 'mapped'     // 已映射成内容/卡片：不在这里展示
    | undefined    // 协议应答 / 我们自己的请求：不是它的输出
  export function classifyRawOutput(
    frame: AcpFrame,
    context: { readonly childSession: boolean },
  ): RawOutputClassification
  export class RawOutputAggregator {
    constructor(options?: { readonly maxBytes?: number })   // 默认 8192
    /**
     * 喂一帧。返回「必须在处理本帧之前写入」的已闭合块：
     * 本帧打断了当前连续段（不同种类/已映射/应答）或内容超过上限时返回；
     * 否则返回 undefined。
     */
    observe(
      frame: AcpFrame,
      position: { readonly turn: number; readonly step: number },
      context: { readonly childSession: boolean },
    ): RawOutputBlock | undefined
    /** 步骤/回合结束：闭合当前连续段。 */
    flush(position: { readonly turn: number; readonly step: number }): RawOutputBlock | undefined
  }
  ```
- 分类规则（映射集合）：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`subagent_spawned`、`subagent_state_update`、`async_task_spawned`、`async_task_progress`、`async_task_state_update`、`user_message_chunk` → `'mapped'`；`session/request_permission`、`cursor/ask_question` → `undefined`；`fs/*`、`terminal/*` 请求 → 摘要行（`kind` 为方法名、`format:'text'`、`line` 为参数摘要 JSON）；无 `method` 的应答帧 → `undefined`；其余 `session/update` 与未知方法 → JSON 行。`line` 用单行 `JSON.stringify`（含 method 时 `{"method":…,"params":…}`）。

- [ ] **Step 1: 写失败测试**（`tests/raw-output.spec.ts`）
  - 连续同类三帧 → `observe` 全程 undefined，`flush` 返回一块：`count:3`、`kind` 正确、`content` 首行为「（3 帧）」、其后三行。
  - 种类切换 → 切换帧的 `observe` 返回前一块（count 1），新段从切换帧起。
  - 中间夹已映射帧（`agent_message_chunk`）→ 返回前一块，且已映射帧不进入任何块。
  - 应答帧（有 `id` 无 `method`）与审批请求 → 不闭段、不入块（返回 undefined、flush 仍只含原段）。
  - `fs/read_text_file` 请求 → 生成摘要块（kind 为方法名、format 'text'）。
  - 上限：`maxBytes` 调小后连续同类帧在第 N 帧 `observe` 返回切块，下一块从第 N 帧继续。
  - 位置：块用**段起点**的 turn/step（步内跨段位置变化时验证）。
  - `childSession: true` 时 `user_message_chunk` 归 mapped；`childSession: false` 时 `user_message_chunk` 也归 mapped（两处都跳过，避免与任务提示重复）。
- [ ] **Step 2: 跑测试确认失败**：`pnpm vitest run packages/dsh-acp-agent/tests/raw-output.spec.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现 `raw-output.ts` + index 导出**。聚合器只记当前段（kind、起点 position、行数组、字节数）；`observe` 先分类，再决定闭合/续写/切块。
- [ ] **Step 4: 跑测试确认通过**：同命令 → PASS。
- [ ] **Step 5: 提交**：`git add packages/dsh-acp-agent/src/raw-output.ts packages/dsh-acp-agent/src/index.ts packages/dsh-acp-agent/tests/raw-output.spec.ts && git commit -m "acp：未知输出聚合器——连续同类成块，排除应答与已映射帧"`

---

### Task 2: 客户端折叠节点（dsh-client）

**Files:**
- Create: `packages/dsh-client/src/raw-output-card.ts`
- Modify: `packages/dsh-client/src/locales.ts`（zh/en 词条）、`packages/dsh-client/src/index.ts`（安装）
- Test: `packages/dsh-client/tests/raw-output-card.spec.ts`
- 模式参照：`packages/dsh-client/src/handover-card.ts`（Definition + 卡片 + install 函数）与其测试。

**Interfaces:**
- Consumes: Task 1 的事件形状——事件类型字符串 `'acp/raw-output'`，载荷字段 `turn/step/kind/format/content/count`（客户端本地声明同名类型，不跨包导入）。
- Produces（组件与注册）：
  - `export const rawOutputDefinition: ConversationNodeDefinition`（match：`event.type === 'acp/raw-output'`）。
  - `export function RawOutputCard(props)`：默认收起的一行（`外部输出 · {kind}（{count} 帧）` + 展开按钮，`aria-expanded`），展开后 `<pre>` 显示 `content`（`format` 决定等宽字体样式即可）。
  - `installRawOutputSurface(ctx, uiConversation)`：`uiConversation.events.register(rawOutputDefinition)` + `ctx.slots.register({ name: 'conversation.chat.node', key: 'acp-raw-output', locale: NAMESPACE }, RawOutputCard)`。

- [ ] **Step 1: 写失败测试**（jsdom + React act，仿 `handover-card.spec.ts`）
  - 渲染一块（kind `session_info_update`、count 2、两行内容）→ 内容不可见、行标题可见、按钮 `aria-expanded="false"`。
  - 点击 → 内容可见、`aria-expanded="true"`；再点 → 收起。
  - 词条检查：`zh`/`en` 词典含 `rawOutput.title`（含 `{kind}`、`{count}` 占位）与 `rawOutput.expand/collapse`。
  - Definition 的 match：`acp/raw-output` 事件命中、其他事件不命中。
- [ ] **Step 2: 跑测试确认失败**：`pnpm vitest run packages/dsh-client/tests/raw-output-card.spec.ts` → FAIL。
- [ ] **Step 3: 实现组件、词典与安装**（照 handover-card 的注册模式；文案全部走 `t`）。
- [ ] **Step 4: 跑测试确认通过**；同时跑 `pnpm vitest run packages/dsh-client` 保持绿。
- [ ] **Step 5: 提交**：`git commit -m "客户端：未知输出折叠节点——默认收起，点开看原始内容"`

---

### Task 3: 子会话构建器（dsh-preset-dispatch）

**Files:**
- Create: `packages/dsh-preset-dispatch/src/subagent-sessions.ts`
- Test: `packages/dsh-preset-dispatch/tests/subagent-sessions.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ChildSessionLike = {
    readonly id: string
    readonly header?: { readonly createdAt?: number }
    append(type: string, payload: unknown, intent?: unknown): { readonly seq: number }
    /** 事件计数，供合成流载荷的 session.seq 使用。 */
    readonly seq: number
  }
  export type SubagentSessionHost = {
    readonly available: boolean
    /** 建带血缘的子会话；宿主无能力包时返回 undefined（调用方据此跳过）。 */
    openChild(parentSessionId: string, childId: string): ChildSessionLike | undefined
    /** 往父会话日志追加一条事件（目录事件走这里）。 */
    appendParent(parentSessionId: string, type: string, payload: unknown): void
    /** 为子会话发一帧实时流（载荷形状由宿主适配，见风险 1）。 */
    emitChildStream(child: ChildSessionLike, frame: Record<string, unknown>): void
  }
  export class SubagentSessions {
    constructor(host: SubagentSessionHost, dialect: AcpDialect)
    /** 出生帧：有 id 立即建会话；无 id 记下标签等首次子会话帧（grok）。 */
    spawn(parentSessionId: string, childId: string | undefined, label: string, task: string): void
    /** 子会话正文/思考增量：懒建会话 + 实时流。 */
    chunk(parentSessionId: string, childSessionId: string, kind: 'thought' | 'message', text: string): void
    /** 真实终态：落最后一段消息 + 结束子回合。status → turn/end 原因。 */
    terminal(parentSessionId: string, childSessionId: string, status: 'completed' | 'failed', output: string | undefined): void
    /** 父回合结束：只放弃实时流，子会话保持开放（不写 turn/end）。 */
    parentTurnEnd(parentSessionId: string): void
    /** 该子会话的未知块聚合器（Task 5 用；不存在返回 undefined）。 */
    rawOutputOf(childSessionId: string): RawOutputAggregator | undefined
  }
  ```
- 固定值（实现时逐字使用）：
  - 子会话 id：`acp-sub-${childId}`；
  - 目录事件：`appendParent(id, 'subagent/catalog', { version: 0, childId: 'acp-sub-…', childCreatedAt, mode: 'one-shot', label })`（`childCreatedAt` 取子会话 `header.createdAt ?? Date.now()`）；
  - 子会话日志：创建后 `turn/start {turn:1}` → `step/start {turn:1,step:1}` → `user/message`（内容为 `task || label`，source `{kind:'user'}`，带 `surfaceOp:'append'`）；
  - 增量：复用 `AcpAssistantStream`（`packages/dsh-preset-dispatch/src/stream.ts`），`emit = frame => host.emitChildStream(child, frame)`，`sessionId = child.id`，`turn:1, step:1`；
  - 终态：`assistant/message`（`content` 为思考块+正文块，`source {kind:'model', provider:'acp-subagent', model: dialect.id}`，`stream: records`，`surfaceOp:'append'`）→ `step/end` → `turn/end`；`completed` → `{kind:'completed'}`，`failed` → `{kind:'error', error:{message: output ?? '子代理未完成', code:'SUBAGENT_FAILED'}}`；随后 `stream.settle('assistant/message', () => messageSeq)`。

- [ ] **Step 1: 写失败测试**（假 host 记录所有写入）
  - 有 id 出生帧 → `openChild` 被调、目录事件字段逐字匹配、`user/message` 内容为 task。
  - 无 id 出生帧 → 不建会话；随后首个 `chunk` → 懒建会话，label 用出生帧给的。
  - 始终无 id 且无 chunk → 零写入。
  - `chunk` 两次（思考+正文）→ 一次 `start` + 两次 delta 帧、kind 正确。
  - `terminal(completed)` → 消息含累积文本与 stream 记录、`step/end`、`turn/end completed`、settle 携带消息 seq。
  - `terminal(failed, '出错了')` → `turn/end` 为 error 且 message 含「出错了」。
  - `parentTurnEnd` → 只 abandon 流；此后无任何追加（Review Focus 4）。
  - `host.available === false` → 全部 no-op，零 `openChild`/`appendParent` 调用（Review Focus 3）。
  - 两个子会话交错 chunk → 互不串写。
- [ ] **Step 2: 跑测试确认失败**：`pnpm vitest run packages/dsh-preset-dispatch/tests/subagent-sessions.spec.ts`。
- [ ] **Step 3: 实现 `subagent-sessions.ts`**（按固定值；每子会话一棵状态：child、stream、thought/text 累积、settled 旗标、未知聚合器）。
- [ ] **Step 4: 跑测试确认通过**；`pnpm vitest run packages/dsh-preset-dispatch` 保持绿。
- [ ] **Step 5: 提交**：`git commit -m "acp 子会话：出生建会话、目录事件、实时流与真实终态收尾"`

---

### Task 4: runner 接线（子会话）

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/runner.ts`（pumpNext 的子会话路由、回合结束钩子、RunnerOptions 新端口）、`src/entry.ts`（用宿主服务构造端口）、`src/registry.ts`/`src/factory.ts`（把端口透传给 runner 构造）
- Test: `packages/dsh-preset-dispatch/tests/subagent-wiring.spec.ts`（新，仿 `runsteps.spec.ts` 的假客户端投帧）

**Interfaces:**
- Consumes: Task 3 `SubagentSessions`（runner 持有一个实例，per session）；既有 `readSpawnedFrame`（`kind:'spawn'` 给出 `call.callId` 与 `call.title`，`kind:'state'` 给出 settled/status/output）。
- Produces: `RunnerOptions.subagents?: SubagentSessionHost`（端口实现放 `entry.ts`：`openChild` 用宿主 `sessions.create` + `meta {cwd, parentSession, origin:'subagent', delegationDepth, createdAt}`；`appendParent` 用宿主会话 store 的 append；`emitChildStream` 用宿主 ctx 发 `agent/assistant-stream`，载荷 `{agent: {session: child}, frame}`；`available` = 宿主 `get('subagent')` 存在）。
- pumpNext 行为：
  - `kind:'spawn'` 的 frames：有 id → `spawn(parentId, id, label, task)`；无 id → `spawn(parentId, undefined, label, task)`（label = `name` ?? `task` 首段 ?? `description` ?? id；task = `task` ?? label）；
  - 子会话帧（params.sessionId ≠ 父会话 id）：`chunk(parentId, childSessionId, 'thought'|'message', text)`；
  - `kind:'state'` 且 settled：`terminal(parentId, callId, status, output)`；
  - 回合结束（`run()` 的 prompt settle 后、`runSteps()` 的末段 close 后）：`parentTurnEnd(parentId)`。
- 无端口或 `available:false` → 全部 no-op（Review Focus 3 的接线层）。

- [ ] **Step 1: 写失败测试**
  - 投「出生帧（有 id）→ 子会话 chunk → 终态帧 → 应答」：断言 openChild/appendParent/emit 调用序与内容。
  - 投「出生帧（无 id）→ 子会话 chunk」：懒建会话、label 正确。
  - 无端口：不建会话、不写目录事件、turn 正常收尾（Review Focus 3）。
  - 父回合结束先于终态：`parentTurnEnd` 被调、子会话无 `turn/end`（Review Focus 4）。
  - 网关模式（`run()`）同样生效：同一组帧走 run() 断言。
- [ ] **Step 2: 跑测试确认失败**；Step 3 实现；Step 4 跑测试确认通过 + `pnpm vitest run packages/dsh-preset-dispatch` 绿。
- [ ] **Step 5: 提交**：`git commit -m "acp runner：子代理帧接入影子子会话，两条路径共用"`

---

### Task 5: 未知块接线（runner + 子会话）

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/runner.ts`（聚合器与 flush 时机）、`src/dispatch.ts`（`TurnContext.append?: (type: string, payload: unknown) => void`）、`src/entry.ts`（实现 append 并传入）、`src/subagent-sessions.ts`（子会话未知块写入）
- Test: `packages/dsh-preset-dispatch/tests/raw-output-wiring.spec.ts`（新）

**Interfaces:**
- Consumes: Task 1 `classifyRawOutput`/`RawOutputAggregator`；Task 3 `SubagentSessions.rawOutputOf`。
- Produces: `TurnContext.append`（父会话直写插件事件；entry 用宿主会话 append 实现）；未知块事件形状 `{ type: 'acp/raw-output', payload: RawOutputBlock }`，落盘时必须带 `ignorable: true`（entry 的 append 实现负责加）。
- 行为：
  - 泵内每帧：父会话帧先 `aggregator.observe(frame, position, {childSession:false})`，返回块 → `turn.append('acp/raw-output', block)` 后再处理本帧；`closeSegment` 前 `flush`；`run()` 回合末 `flush`；
  - 子会话帧：`SubagentSessions` 内的每子会话聚合器同样 observe/flush，块写入子会话（`child.append`），不写父会话（Review Focus 5）；
  - 无 `turn.append`（老宿主/测试桩）→ 跳过写入但聚合器照常工作（不抛错）。

- [ ] **Step 1: 写失败测试**
  - 父会话投「未知帧 A×2 → 已映射正文帧 → 未知帧 A」：两次 append 事件（count 2 与 count 1），顺序在正文事件之前（Review Focus 1）。
  - 应答/审批帧夹在同类未知帧之间：不闭段（仍一块）。
  - 步骤末 flush：块携带段起点的 turn/step。
  - 子会话未知帧 → 写子会话、父会话零写入（Review Focus 5）。
  - 无 `append` 的 TurnContext → 不抛错、会话照常收尾。
- [ ] **Step 2: 跑测试确认失败**；Step 3 实现；Step 4 跑测试确认通过 + 两包全量绿 + `pnpm tsc -b packages/dsh-acp-agent packages/dsh-preset-dispatch` 干净。
- [ ] **Step 5: 提交**：`git commit -m "acp：未知输出块接入帧泵，父子会话各写各的"`

---

### Task 6: 活测、全量回归与验收

**Files:**
- Modify: `packages/dsh-preset-dispatch/tests/live.spec.ts`（真实 codex 子代理回合）
- 无产品代码改动（暴露问题按 systematic-debugging 回根因再改）

- [ ] **Step 1: 新增活测用例**（`THREADHARBOR_LIVE_ACP` 门控，沿用既有 harness）：真实 codex 回合要求它派一个子代理（例如让子代理算一道题）；断言：宿主侧子会话被创建（id 前缀、父会话血缘、目录事件）、子会话日志含任务用户消息与收尾消息、终态后 `turn/end`；未知块事件在该会话/父会话出现且带 ignorable（若本回合产生了未映射帧）；父回合结束先于终态时子会话保持开放（条件断言）。
- [ ] **Step 2: 跑活测与全量单测**：`THREADHARBOR_LIVE_ACP=1 THREADHARBOR_CODEX_ACP=/Users/good/.local/bin/codex-acp pnpm vitest run packages/dsh-preset-dispatch/tests/live.spec.ts packages/dsh-preset-dispatch/tests/gateway-live.spec.ts packages/dsh-acp-agent/tests/live.spec.ts`；随后 `pnpm vitest run`（全仓；既有失败集合核对为 dsh-client 4 文件 + dsh-host-federation 1 文件，与本次无关）。
- [ ] **Step 3: typecheck + 提交**：`pnpm typecheck`（两包零错误；全仓既有失败不变）→ `git commit -m "acp 活测：真实子代理回合的影子会话与未知块断言"`。
- [ ] **Step 4: 3081 验收**：`~/bin/dsh-web-3081` 重启（数据目录与插件指向由脚本固化；如部署分支代码需按既有做法临时改 profile 软链并在验收后复原）；真实 codex 回合核对：顶部下拉出现子会话、可打开、内容可读、终态收尾；未知块默认收起、点开可看、刷新仍在。把会话 id 与观察结论记进规格文档「验收」小节并提交。**若实时流载荷不被接收（风险 1）**：退路是给每个子会话建一个空闲代理、改用其 dispatch 发流——记录实测结果与改动，不改验收口径；**若子会话打开路径被宿主所有权检查挡住（风险 2）**：记录为已知限制并回报，组件一继续验收。
