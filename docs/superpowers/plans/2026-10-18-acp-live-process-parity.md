# ACP 过程展现对齐原生：实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部 agent（codex-acp 等）的回合按「段落」投影为原生形状的多步骤回合：思考/正文按真实时间线成块、工具结果做完即落盘，接管路径获得原生的过程折叠与答案锚点。

**Architecture:** 分段器把帧流切成段；接管路径利用「替换步骤返回 null → 循环再调一次」的原生机制一段一步骤；网关路径保持单步骤，只吃两项共享修正（换向开块、实时结果）。DSH 宿主与 web 客户端零改动。

**Tech Stack:** TypeScript（ESM、`.ts` 相对导入）、vitest（根仓库 `pnpm vitest run` 可按路径过滤）。

**Spec:** `docs/superpowers/specs/2026-10-18-acp-live-process-parity-design.md`（实现时随计划一起读；分段规则、路径边界、兼容性以规格为准）。

## Global Constraints

- 不改 `reference/deepseek-harness`（只读参考）与任何 DSH 宿主/web 客户端代码。
- 直接切换，不加配置开关、不留双轨。
- 旧会话日志零影响；新写法产出的必须是原生多步骤回合形状。
- zcode 路径不动。
- 注释/提交信息遵循仓库现状（中文提交信息、模块头注释讲「为什么」）。
- 每个任务收尾跑 `pnpm typecheck`（根仓库）与该任务的测试文件。

## Review Focus

1. **段落边界帧**：宣布「新段开始」的那一帧属于新段，不得留在旧段（Task 1 断言闭合帧归新段；Task 5 断言该帧进下一段的流）。
2. **微任务间隙帧**：上一次调用返回与下一次调用开始之间到达的帧必须排队，由下一次调用按其步骤号处理（Task 5 专门用例）。
3. **实时结果写失败**：卡片已实时写、结果实时写抛错 → 回合末补写成对事件，不得孤儿化（Task 4 用例，仿 writeOpeningCard 的 catch 模式）。
4. **工具开卡后到回合结束都不收尾**：该段不因工具规则闭合，末段收编它，`[still running]` 语义不适用（有卡片无结果的补结果路径）（Task 5 用例）。
5. **中止半段**：中止时进行中的段写已到内容并以 aborted 收场，后续帧丢弃（Task 5 用例；run() 现有中止测试保持绿）。

---

### Task 1: 分段器（dsh-acp-agent）

**Files:**
- Create: `packages/dsh-acp-agent/src/segmentation.ts`
- Modify: `packages/dsh-acp-agent/src/index.ts`（导出）
- Test: `packages/dsh-acp-agent/tests/segmentation.spec.ts`

**Interfaces:**
- Produces: `class AcpSegmenter { constructor(dialect: AcpDialect); observe(frame: AcpFrame): boolean }`
  - `observe` 返回 true 表示「该帧宣告上一段闭合、自身属于新段」；调用方必须先闭合旧段再把它归入新段。
- Consumes: `AcpDialect`（`frameUpdate` 归一钩子，同 `projection.ts` accumulate 的取法）。

- [ ] **Step 1: 写失败测试**

`tests/segmentation.spec.ts`，用真实捕获帧与手工帧断言（导入 `./fixtures/captured-frames.json`、`./fixtures/captured-subagent-frames.json`）：

- `codex/frames`（文本×11 → 子代理 → 工具 → 文本 → 状态 → 工具收尾 → 文本）：在「工具收尾后的第一条文本帧」处恰好一次闭合，且该帧归新段；子代理帧不触发闭合。
- 手工序列：text → tool(in_progress) → tool_update(completed) → text → reply 前终止：第二条 text 触发闭合。
- 工具连工具（两次 in_progress → 两次 completed → text）：中间不闭合，text 处闭合一次。
- 未收尾工具 + 新文本：不闭合（段继续等）。
- 纯聊天（text×N）：零闭合。
- 空文本增量（`content.text === ''`）：不触发闭合。
- 杂讯帧（usage_update 等）：不影响状态。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/segmentation.spec.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `AcpSegmenter`**

状态机：每段内维护 `openCalls: Set<string>` 与 `anySettled: boolean`。工具帧（`tool_call`/`tool_call_update`）按 `status` 收尾则从 `openCalls` 删除并置 `anySettied`，否则加入；`agent_thought_chunk`/`agent_message_chunk` 非空文本且 `anySettied && openCalls.size === 0` 时返回 true 并重置两个状态。更新读取走 `dialect.frameUpdate`（无钩子则只认 `session/update`）。子代理/异步任务帧与杂讯不参与。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/segmentation.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

`git add packages/dsh-acp-agent/src/segmentation.ts packages/dsh-acp-agent/src/index.ts packages/dsh-acp-agent/tests/segmentation.spec.ts && git commit -m "acp：帧流分段器——工具批次收尾后的新内容帧切段"`

---

### Task 2: AcpAssistantStream 换向开块

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/stream.ts:143-176`（按类槽位 `blockIndexes`）
- Test: `packages/dsh-preset-dispatch/tests/stream.spec.ts`（更新断言两槽行为的旧用例）

**Interfaces:**
- 对外不变：`textDelta` / `reasoningDelta` / `records()`。行为变化：思考↔正文一换向即取下一个块号；同类增量续写当前块。

- [ ] **Step 1: 写/改测试**

`stream.spec.ts` 新增：
- 交错序列 reasoning,text,reasoning,text → 发出的 chunk 帧块号为 0,1,2,3；`records()` 四条记录 index 同序。
- 同类连续增量 → 同一块号，texts 合并。
- 换向后 `end.index` 语义不变（下一个 chunk 位置）。
- 旧「每类一槽」断言按新行为改写（行为变更随测试一起改，PR 说明里点明）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/stream.spec.ts`
Expected: FAIL（旧槽位行为）。

- [ ] **Step 3: 实现**

删除 `blockIndexes` 按类 Map，改记 `currentKind` 与递增 `index`：换向时 `index = 下一个号` 并开新 run；同类沿用当前 run。`pushDelta` 的 run 合并条件同步改为「同 run 同 index」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/stream.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

`git commit -m "acp 流：思考/正文换向即开新块——直播顺序与原生一致"`

---

### Task 3: GatewayChunkStream 换向开块

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/gateway.ts:173-244`（`byKind` Map）
- Test: `packages/dsh-preset-dispatch/tests/gateway.spec.ts`（相关 chunk 断言）

**Interfaces:**
- 对外不变（`port()` / `finish()`）。行为与 Task 2 对齐：换向发 `block-start` 取新 index，同类续写。

- [ ] **Step 1: 写/改测试**

`gateway.spec.ts`：交错 reasoning→text→reasoning 的 port 调用产出 block-start 序列 index 0,1,2；同类连续只一次 block-start；`finish` 按序发 block-end。旧按类断言改写。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/gateway.spec.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`byKind` Map 改为 `current` 单槽（blockType+index+text）：换向时 index=`blocks.length`、发 block-start；`finish` 不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/gateway.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

`git commit -m "acp 网关流：换向开块，与 assistant 流同一块序"`

---

### Task 4: 工具结果实时落盘（projection + runner）

**Files:**
- Modify: `packages/dsh-acp-agent/src/projection.ts`（新增导出）、`src/index.ts`
- Modify: `packages/dsh-preset-dispatch/src/runner.ts`（observe 路径 + 回合末过滤）
- Test: `packages/dsh-acp-agent/tests/projection-incremental.spec.ts`、`packages/dsh-preset-dispatch/tests/mid-turn-tools.spec.ts`

**Interfaces:**
- Produces（dsh-acp-agent）：`projectToolResultFrame(frame: AcpFrame, options: { turn: number; step: number; dialect: AcpDialect }): ProjectionEvent | undefined`——帧是收尾帧（foldTool 后 status 为 completed/failed）时返回 `tool/result` 事件，否则 undefined。与 `projectToolCallFrame` 同一折叠语义（无 carried 状态）。
- Consumes（runner）：既有 `liveCards` 结构扩展 `settled: Set<string>`（投影后的 callId）。

- [ ] **Step 1: 写失败测试（projection 侧）**

`projection-incremental.spec.ts`：对捕获的 codex `tool_call_update(completed)` 帧调用返回 tool/result 事件（output 取 `rawOutput.formatted_output`）；对 in_progress 帧返回 undefined；对 claude/grok 捕获帧同样成立。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/projection-incremental.spec.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现 `projectToolResultFrame`**

`foldTool(undefined, update)` 后按 status 判断，事件构造复用模块内现成的 `toolResultEvent`。

- [ ] **Step 4: 写失败测试（runner 侧）**

`mid-turn-tools.spec.ts` 新增：
- 收尾帧到达 → 立即一次 `write` 调用携带该 tool/result（announcement/card 已在之前写入）。
- 回合末 produce/write 不再重复该结果（过滤后 events 中无该 callId 的 tool/result）。
- 实时结果 `write` 抛错 → 不抛出（catch 仿 writeOpeningCard），回合末补写成对事件（Review Focus 3）。
- 卡片未实时写（如 liveCards 为 undefined）→ 收尾帧不写孤儿结果，回合末成对写入。

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/mid-turn-tools.spec.ts`
Expected: FAIL

- [ ] **Step 6: 实现 runner 侧**

`observe` 的帧处理链上加 `writeSettledResult(frame)`：`projectToolResultFrame` 有事件且 `live.written.has(callId)` 时 `live.write([事件])` 成功后记入 `settled`。回合末过滤（现有 flatMap）扩展：`tool/result` 事件的 `toolCallId` 在 `settled` 中则跳过。

- [ ] **Step 7: 跑两个包的相关测试确认通过**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/projection-incremental.spec.ts packages/dsh-preset-dispatch/tests/mid-turn-tools.spec.ts`
Expected: PASS

- [ ] **Step 8: 提交**

`git commit -m "acp：工具收尾帧即时落结果，回合末只补残余"`

---

### Task 5: runner 段落驱动 runSteps（接管多步骤核心）

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/runner.ts`（帧队列 + 分段泵 + `runSteps`）
- Modify: `packages/dsh-preset-dispatch/src/dispatch.ts`（`AcpPresetBinding.runSteps?` 类型）
- Test: `packages/dsh-preset-dispatch/tests/runsteps.spec.ts`（新建；helper 仿 runner.spec.ts 的 fakeClient，另支持延迟 resolve 的 `session/prompt` 与手工投帧 `deliver(frame)`）

**Interfaces:**
- Produces: `AcpTurnRunner.runSteps(decision: StepDecisionLike, turn: TurnContext, options: { readonly first: boolean }): Promise<StepEndReason | null>`——null=继续（还有段落或应答未回）；结束原因只在末段返回。
- Produces（dispatch.ts 类型）：`AcpPresetBinding.runSteps?: (decision, turn, options: { first: boolean }) => Promise<StepEndReason | null>`
- Consumes: Task 1 `AcpSegmenter`、Task 4 实时结果路径、既有 `projectStepContent`（经 `turn.produce`，段级 `AcpStepResult{frames, stream, end}`）。
- 内部结构（实现必须遵循）：帧入 `queue`（observe 只入队）；每次 runSteps 调用从队首泵帧直到段闭合或应答落定；段内动作序 = 流增量（`turn.openStream()` 该次调用的句柄）→ 开卡（现有 writeOpeningCard，位置用当次 position）→ 实时结果（Task 4）；闭合后 `turn.produce(段级 result)` → `turn.write` → `stream.settle` → 返回 null。首段职责（open/prompt/watchStop/primer/replay/promptContent）只在 `first` 时执行；`AcpSegmenter` 与中止旗标随 prompt 生命周期重建。

- [ ] **Step 1: 写失败测试**

`runsteps.spec.ts`（fakeClient：`session/prompt` 返回手动 resolve 的 promise；`deliver` 经捕获的 onFrame 投帧）：
- 序列 text → tool(in_progress) → tool(completed) → text → reply(end_turn)：第一次 `runSteps(first=true, position step=1)` 在第二条 text 前返回 null，已写事件（announcement+card+message+result）全部 step=1；第二次（step=2）在 reply 后返回 `{kind:'completed'}`，末段消息 step=2 且带 usage（reply 报了 usage 时）。
- 微任务间隙帧（Review Focus 2）：第一次调用返回后、第二次调用前 `deliver` 一帧文本 → 该帧由第二次调用处理、流增量走第二个 stream 句柄。
- 中止半段（Review Focus 5）：prompt 期间 abort → 当前段写已到内容、返回 aborted；后续 deliver 全部丢弃。
- 未收尾工具 + reply（Review Focus 4）：in_progress 工具后直接 reply → 单末段成对写卡+结果，无 `[still running]`。
- prompt 失败：`first` 调用返回分类错误原因（failureEndOf 语义不变），无段落事件。
- 回合中途应答被拒：已投若干帧后 reject prompt promise → 当次调用把已到内容按末段投影，返回分类错误原因。
- 首段职责只执行一次：两次调用只发一次 `session/prompt`、user 事件只写一次。
- 纯聊天：单段，一次调用直接返回 completed（与 run() 行为等价）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/runsteps.spec.ts`
Expected: FAIL（runSteps 不存在）

- [ ] **Step 3: 实现**

按上述内部结构改造：observe 改为入队（`run()` 路径改为「入队后立即泵空」，保持现有实时行为逐字节不变——stream/开卡/实时结果的调用点全部搬进泵内）；`runSteps` 按段推进。`run()` 与 `runSteps` 共用：open、prompt 发送、泵、段投影、中止。注意：`run()` 不引入分段（网关无段概念，回合末残余 produce 保持现状，只是结果已被 Task 4 实时写掉）。

- [ ] **Step 4: 跑测试确认通过（含回归）**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/runsteps.spec.ts packages/dsh-preset-dispatch/tests/runner.spec.ts packages/dsh-preset-dispatch/tests/mid-turn-tools.spec.ts packages/dsh-preset-dispatch/tests/cancel.spec.ts`
Expected: PASS（run() 既有行为不变）

- [ ] **Step 5: 提交**

`git commit -m "acp runner：段落驱动 runSteps——外部回合一段一个 DSH 步骤"`

---

### Task 6: dispatch / registry / entry 接线

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/dispatch.ts:421-502`（acpStep 分支）、`src/registry.ts`（binding 加 runSteps）、`src/entry.ts`（install 处透传）
- Test: `packages/dsh-preset-dispatch/tests/dispatch.spec.ts`、`tests/registry.spec.ts`

**Interfaces:**
- Consumes: Task 5 `runSteps`。
- Produces: 接管路径实际走多步骤：无 `runSteps` 的 binding（测试桩）回落现有 `run()` 单步行为。

- [ ] **Step 1: 写失败测试**

`dispatch.spec.ts` 新增：
- binding 带 runSteps：acpStep 首调（turnModel=userEvents 后）透传 `first:true` 并返回其结果；返回 null 后同回合再调 → `first:false`，且 turnModel/userEvents 不再执行；返回结束原因后状态复位（下一轮首调又 `first:true`）。
- 每次调用读取当次 `positionOf`（步骤号随调用变化）。
- 无 runSteps 的 binding：现状不变（run 单步）。
- 抛错路径：runSteps 抛错 → 状态复位（finally）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/dispatch.spec.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

acpStep 内以 WeakMap<agent, boolean> 记「外部回合进行中」：首调置位、返回非 null 或抛错时复位；`first` 据此传入。registry 的 binding 构造处绑定 `runner.runSteps`（含 first 透传）；entry 无需改 produce（段级 result 走同一 produce 闭包，位置取自当次 TurnContext）。

- [ ] **Step 4: 跑测试确认通过（含全包回归）**

Run: `pnpm vitest run packages/dsh-preset-dispatch`
Expected: PASS

- [ ] **Step 5: 提交**

`git commit -m "acp 接管：替换步骤按段迭代，首段独占提问与模型选择"`

---

### Task 7: 活测与整体回归

**Files:**
- Modify: `packages/dsh-preset-dispatch/tests/live.spec.ts`（takeover 活测，`THREADHARBOR_LIVE_ACP` 门控）
- 无产品代码改动（除非活测暴露问题，届时按 systematic-debugging 回到根因再改）

**Interfaces:**
- Consumes: Task 5 runSteps、真实 `THREADHARBOR_CODEX_ACP`。

- [ ] **Step 1: 新增活测用例**

真实 codex 回合（要求它跑至少一条 shell 命令的提问）：经 runSteps 驱动，断言 ≥2 次 `first:false` 之前的段调用（即至少两段）、每段消息内嵌各自的 stream 记录、收尾帧后即时出现 result 事件、末段消息带 usage。环境不可用时自跳过（沿用现有门控写法）。

- [ ] **Step 2: 跑活测与全量单测**

Run: `pnpm vitest run`（活测门控自跳过时只跑单测）；有真实环境再 `THREADHARBOR_LIVE_ACP=1 THREADHARBOR_CODEX_ACP=/Users/good/.local/bin/codex-acp pnpm vitest run packages/dsh-preset-dispatch/tests/live.spec.ts packages/dsh-preset-dispatch/tests/gateway-live.spec.ts packages/dsh-acp-agent/tests/live.spec.ts`
Expected: PASS

- [ ] **Step 3: typecheck + 提交**

Run: `pnpm typecheck`
`git commit -m "acp 活测：真实 codex 回合的多段落与实时结果断言"`

---

### Task 8: 3081 双路径人工验收

**Files:** 无代码；产物为验收记录（追加到规格文档的「验收」小节，含日期与会话 id）。

- [ ] **Step 1: 构建并更新 3081 实例插件**

`pnpm build` 后按 `docs/install-plugins.zh.md` 刷新 `~/.dsh-threadharbor-test` 实例的插件；实例只经 `~/bin/dsh-web-3081` 重启（仓库铁律）。

- [ ] **Step 2: 接管路径核对**

acp-codex 预设会话提一个需要 ≥2 轮命令的问题：思考/正文分段按真实顺序出现；每张工具卡做完即出结果；回合结束后过程折叠、答案单独展示；刷新页面回放一致。

- [ ] **Step 3: 网关路径核对**

原生会话选 codex 模型就地回答同类问题：流内段落按真实顺序成块；卡片+结果实时；答案消息为该步最后一条；刷新一致。

- [ ] **Step 4: 记录验收结果并提交**

把两条路径的会话 id、观察结论、遗留问题写进规格文档「验收」小节；`git commit -m "acp 过程对齐：3081 双路径验收记录"`
