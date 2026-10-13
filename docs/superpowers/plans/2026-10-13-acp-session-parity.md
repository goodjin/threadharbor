# ACP 会话补齐 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让外部 agent（ACP）会话在停止、工具可见性、历史、附件、提问、收尾六件事上对齐 DSH 原生会话。

**Architecture:** 先立一张"能力表"（四家 agent 各自声明支持什么），所有修补只读这张表，避免四家差异散落各处；再在回合驱动、投影、提问组装、收尾各层按表逐项接上。

**Tech Stack:** TypeScript、Vitest（默认套件）、JSON-RPC over stdio/WebSocket（ACP）、cordis 插件、DSH 运行时（`reference/deepseek-harness` 为只读参照）。

**Spec:** `docs/superpowers/specs/2026-10-13-acp-session-parity-design.md`

## Global Constraints

- 四家 agent 的能力差异只写在能力表里，别处只读表，不重复判断。
- 不改动 DSH 运行时源码；外部 agent 的行为差异通过方言与能力表表达（与现有架构一致）。
- 默认测试套件保持 hermetic（不起真实 agent、不连网）；真机活测默认跳过，设 `THREADHARBOR_LIVE_ACP=1` 才跑。
- 用户可见文案走 DSH 的 locale 字典，不写死（插件过 `verify-client-ui-i18n`）。
- 工具名映射到 DSH 的工具视图键（`reference/deepseek-harness` 的 `ui-tool/toolviews` 里的键），命不中的落通用卡。
- 回合内工具调用编号唯一；跨回合若重复，编号前加回合号兜底。
- 中止后到达的帧一律丢弃，不补写。

## Review Focus

规格暗示、但没有哪个任务的测试会真正跑到的输入，最可能咬人的：

1. **用户按停止后、外部 agent 自己随后跑完**——回合必须按中止落账，中止之前的内容保留，之后到达的结果丢弃。归 Task 2 的测试。
2. **工具调用编号跨回合重复**——第二轮出现第一轮用过的编号时，不能配对到上一轮的结果。归 Task 3 的测试。
3. **claude 的图片被拦下时**——必须发一条明确"未送达"的行，且图片仍留在转录里。归 Task 6 的测试。
4. **历史回灌被拒**——agent 返回错误或不收时，转录里要有"历史回灌被拒绝"行，不能静默。归 Task 5 的测试。
5. **grok 的终端子协议帧**——不得再被当成"未知帧"丢弃或报错；它照常由进程内终端服务代答，工具帧照常投影。归 Task 3/9 的测试。

---

### Task 1: 能力表（骨架）

**Files:**
- Modify: `packages/dsh-acp-agent/src/dialects/types.ts`
- Modify: `packages/dsh-acp-agent/src/dialects/claude.ts`
- Modify: `packages/dsh-acp-agent/src/dialects/codex.ts`
- Modify: `packages/dsh-acp-agent/src/dialects/grok.ts`
- Modify: `packages/dsh-acp-agent/src/dialects/cursor.ts`
- Test: `packages/dsh-acp-agent/tests/capabilities.spec.ts`（新建）

**Interfaces:**
- Produces: `AcpDialect.capabilities: AcpCapabilities`，其中
  ```ts
  type AcpCapabilities = {
    readonly cancelsTurns: boolean
    readonly acceptsImageContent: boolean
    readonly toolFrameShape: 'in_progress' | 'two_frame'
    readonly commandVia: 'tool_frame'
    readonly toolNameMap: Readonly<Record<string, string>>
  }
  ```
  后续 Task 2/3/4/6 都读这个字段。

- [ ] **Step 1: 写失败测试**——四家的能力值各断言一条：

```ts
import { describe, expect, it } from 'vitest'
import { claudeDialect } from '../src/dialects/claude'
import { codexDialect } from '../src/dialects/codex'
import { grokDialect } from '../src/dialects/grok'
import { cursorDialect } from '../src/dialects/cursor'

describe('capabilities', () => {
  it('claude: 不认图片、工具帧有执行中', () => {
    expect(claudeDialect.capabilities.acceptsImageContent).toBe(false)
    expect(claudeDialect.capabilities.toolFrameShape).toBe('in_progress')
  })
  it('codex: 认图片、工具帧两段', () => {
    expect(codexDialect.capabilities.acceptsImageContent).toBe(true)
    expect(codexDialect.capabilities.toolFrameShape).toBe('two_frame')
  })
  it('grok: 认图片、工具帧两段、命令经工具帧', () => {
    expect(grokDialect.capabilities.acceptsImageContent).toBe(true)
    expect(grokDialect.capabilities.toolFrameShape).toBe('two_frame')
    expect(grokDialect.capabilities.commandVia).toBe('tool_frame')
  })
  it('cursor: 认图片、工具帧有执行中', () => {
    expect(cursorDialect.capabilities.acceptsImageContent).toBe(true)
    expect(cursorDialect.capabilities.toolFrameShape).toBe('in_progress')
  })
  it('四家都认取消', () => {
    for (const d of [claudeDialect, codexDialect, grokDialect, cursorDialect]) {
      expect(d.capabilities.cancelsTurns).toBe(true)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/capabilities.spec.ts`
Expected: FAIL（`capabilities` 不存在）

- [ ] **Step 3: 在 `types.ts` 定义 `AcpCapabilities` 类型并给 `AcpDialect` 加 `capabilities` 字段**（必填，四家都要填，否则类型报错）。工具名映射 `toolNameMap` 按各家命名习惯填初值：claude 填 `Read→read`、`Edit→edit`、`Bash→bash`、`Write→write`、`Grep→grep`、`Glob→glob`、`TodoWrite→todo`；codex/grok/cursor 先填空对象（后续 Task 4 按实际帧填）。

- [ ] **Step 4: 在四个方言文件里填 `capabilities`**（值见 Step 1 断言）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/capabilities.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-acp-agent/src/dialects packages/dsh-acp-agent/tests/capabilities.spec.ts
git commit -m "能力表：四家声明取消/图片/工具帧形状/命令路径/工具名映射"
```

---

### Task 2: 停止当前回合

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/dispatch.ts`（`installAcpDispatch` 实例上包一层取消方法）
- Modify: `packages/dsh-preset-dispatch/src/runner.ts`（`AcpTurnRunner.run()` 监听中止信号、发取消、丢弃中止后的帧）
- Test: `packages/dsh-preset-dispatch/tests/cancel.spec.ts`（新建，hermetic：假客户端 + 假中止信号）

**Interfaces:**
- Consumes: Task 1 的 `dialect.capabilities.cancelsTurns`。
- Produces: `AcpTurnRunner` 新增 `abort?: () => AbortSignal`（构造选项）；runner 在 `run()` 里监听它，中止时发 `session/cancel`。

- [ ] **Step 1: 写失败测试**——假客户端在收到 `session/prompt` 后，外部 agent 迟迟不结束；外部触发中止信号；断言 runner 发了 `session/cancel` 且回合以中止落账：

```ts
it('runner 收到中止信号就发取消并中止落账', async () => {
  const frames: unknown[] = []
  let cancelled = false
  const client = {
    onFrame: () => {},
    notify: (method: string) => { if (method === 'session/cancel') cancelled = true },
    request: async (method: string) => {
      if (method === 'initialize') return {}
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') {
        // 模拟外部 agent 被取消后才结束
        await new Promise(r => setTimeout(r, 50))
        return { stopReason: 'cancelled' }
      }
      return {}
    },
  }
  const abort = new AbortController()
  const runner = new AcpTurnRunner(client, { cwd: '/tmp', abort: () => abort.signal })
  const turn = { sessionId: 'dsh1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 }
  const p = runner.run({ messages: [] }, turn)
  setTimeout(() => abort.abort(), 10)
  const result = await p
  expect(cancelled).toBe(true)
  expect(result.end.kind).toBe('aborted')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/cancel.spec.ts`
Expected: FAIL（`abort` 选项不存在）

- [ ] **Step 3: runner 支持中止信号**——`RunnerOptions` 加 `abort?: () => AbortSignal`；`run()` 里 `const signal = this.options.abort?.()`，若 `signal` 存在则 `signal.addEventListener('abort', …)`，回调里发 `session/cancel` 并置一个 `aborted` 标志；`session/prompt` 的 reply 若 `aborted` 或 `stopReason === 'cancelled'`，回合按 `{ kind: 'aborted', reason: … }` 落账，且 `this.turnFrames` 里中止之后到达的帧不再投影（`observe` 里检查标志）。

- [ ] **Step 4: dispatch 把中止信号喂给 runner**——`installAcpDispatch` 在实例上包一层 `cancel`：包里读 `this.phase?.abort?.signal`（运行时属性，TS 私有是编译期的），记到一个 WeakMap；把该信号经 `binding.run` 的调用链传下去。`AcpPresetBinding.run` 的签名不变，改由 `factory.ts` 组装 runner 时传入 `abort`。若实例没有 `cancel` 或读不到信号，runner 照常工作（无中止能力，行为不变）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/cancel.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-preset-dispatch/src packages/dsh-preset-dispatch/tests/cancel.spec.ts
git commit -m "停止当前回合：取消通知接线 + 中止信号进回合驱动"
```

---

### Task 3: 工具帧增量写入

**Files:**
- Modify: `packages/dsh-acp-agent/src/projection.ts`（投影改为"收到即写"的增量事件流，而非回合末一次性）
- Modify: `packages/dsh-preset-dispatch/src/content-writer.ts`（处理增量工具事件：调用先落、更新就地改、完成落结果）
- Test: `packages/dsh-acp-agent/tests/projection-incremental.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `toolFrameShape`（决定增量事件的粒度）。
- Produces: 新增 `projectTurnIncremental(frames, { turn, dialect })`，返回 `ProjectionEvent[]`（含中间态），与现有 `projectTurn` 并存（`projectTurn` 供活测与旧路径用）。

- [ ] **Step 1: 写失败测试**——claude 形状的帧序列（tool_call 执行中 → 更新 → 完成）投影出三事件（调用、更新、结果），且编号配对正确；codex 形状（调用→完成）投影出两事件：

```ts
it('claude 形状投影出执行中、更新、完成三事件', () => {
  const frames = [
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'in_progress' } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' } } },
    { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'text', text: 'ok' }] } } },
  ]
  const events = projectTurnIncremental(frames, { turn: 1, dialect: claudeDialect })
  expect(events.filter(e => e.type === 'tool/call').length).toBe(1)
  expect(events.filter(e => e.type === 'tool/update').length).toBe(1)
  expect(events.filter(e => e.type === 'tool/result').length).toBe(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/projection-incremental.spec.ts`
Expected: FAIL（`projectTurnIncremental` 不存在）

- [ ] **Step 3: 实现 `projectTurnIncremental`**——复用 `accumulate` 的折叠逻辑，但产出按帧顺序的增量事件：`tool_call` 帧 → `tool/call`；`tool_call_update` 且 `status === 'in_progress'` → `tool/update`（就地改同 callId 的调用）；`status === 'completed'`/`failed` → `tool/result`。`tool/update` 的 payload 带 `turn/step/callId` 与更新后的字段。编号配对沿用 content-writer 的 `turn:callId` 键。

- [ ] **Step 4: content-writer 处理 `tool/update`**——在 `makeContentWriter` 里加分支：`tool/update` 找到 `answers` 里同 `turn:callId` 的 seq，以 surface intent 写一条更新（`surfaceOp: 'update'`）；找不到就忽略（无调用可改）。保持 `tool/call`/`tool/result` 现有行为不变。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/projection-incremental.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-acp-agent/src/projection.ts packages/dsh-preset-dispatch/src/content-writer.ts packages/dsh-acp-agent/tests/projection-incremental.spec.ts
git commit -m "工具帧增量写入：执行中/更新/完成三态按帧落库"
```

---

### Task 4: 工具名映射到 DSH 视图键

**Files:**
- Modify: `packages/dsh-acp-agent/src/projection.ts`（`tool/call` 的 `name` 经能力表的 `toolNameMap` 映射）
- Modify: `packages/dsh-acp-agent/src/dialects/{claude,codex,grok,cursor}.ts`（填 `toolNameMap`）
- Test: `packages/dsh-acp-agent/tests/tool-name-map.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `toolNameMap`。
- Produces: 映射函数 `mapToolName(dialect, rawName): string`（命不中的原样返回，落通用卡）。

- [ ] **Step 1: 写失败测试**——claude 的 `Read` 映射成 `read`；grok 的标题 `run_terminal_command` 映射成 `bash`（或按实测填）；未知名原样返回：

```ts
it('claude 的 Read 映射成 read', () => {
  expect(mapToolName(claudeDialect, 'Read')).toBe('read')
})
it('未知名原样返回', () => {
  expect(mapToolName(claudeDialect, 'SomethingNew')).toBe('SomethingNew')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/tool-name-map.spec.ts`
Expected: FAIL（`mapToolName` 不存在）

- [ ] **Step 3: 实现 `mapToolName` 并在投影里用它**——`contentEvents` 里 `tool/call` 的 `name` 改为 `mapToolName(dialect, tool.name)`。映射表按各家实测填：claude 填标准 Anthropic 工具名；codex 命令行（无固定名，填命令行前缀→`bash`）；grok 标题→`bash`/`read`/`edit`（按实测填）；cursor 同 claude（按实测填）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/tool-name-map.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-acp-agent/src packages/dsh-acp-agent/tests/tool-name-map.spec.ts
git commit -m "工具名映射：agent 工器名 → DSH 视图键，命中专用视图"
```

---

### Task 5: 历史回灌

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/runner.ts`（外部会话首开时读本地转录、整理成"之前对话"文本、随首条提问发出）
- Modify: `packages/dsh-preset-dispatch/src/switch-shared.ts`（新增 `replayPrimer`：按 DSH 会话读转录）
- Test: `packages/dsh-preset-dispatch/tests/replay.spec.ts`（新建，hermetic：假会话读取器）

**Interfaces:**
- Produces: `RunnerOptions.replay?: { take(sessionId): string | undefined }`——与现有 `primer` 并存：先取 `primer.take`，没有再取 `replay.take`，都没有就只发当前提问。

- [ ] **Step 1: 写失败测试**——外部会话首开、本地有转录，首条提问前出现"之前对话"文本；被拒（agent 返回错误）时出现"历史回灌被拒绝"行：

```ts
it('首开时把转录整理成之前对话随首条提问发出', async () => {
  const sent: string[] = []
  const client = { /* …request 里把 prompt 文本推给 sent… */ }
  const replay = { take: () => '用户：上次聊了重构\n助手：好' }
  const runner = new AcpTurnRunner(client, { cwd: '/tmp', replay })
  await runner.run({ messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }] }, turn)
  expect(sent[0]).toContain('之前对话')
  expect(sent[0]).toContain('继续')
})
it('被拒时出现历史回灌被拒绝行', async () => {
  /* session/prompt 返回错误，断言 produce 出一条错误事件 */
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/replay.spec.ts`
Expected: FAIL（`replay` 选项不存在）

- [ ] **Step 3: runner 接入回灌**——`run()` 里在组装 `text` 时，`primer.take` 之后取 `replay.take(turn.sessionId)`；有内容则拼成 `【之前对话】\n<文本>\n\n【当前问题】\n<文本>`。`session/prompt` 抛错时，若是回灌导致（文本超长/被拒），`produce` 里写一条 `error` 事件（"历史回灌被拒绝：原因"）。

- [ ] **Step 4: 实现 `replayPrimer`**——在 `switch-shared.ts` 加 `replayPrimer(sessionId)`：经 host 的会话读取器拿该 DSH 会话的转录事件，按顺序整理成文本（用户消息、助手正文、工具标题；工具结果每条截断最多 500 字；轮次整段不省略）。读不到会话或转录为空，返回 undefined。被拒判定：`session/prompt` 抛错且错误信息与"上下文/过长/不支持"相关。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/replay.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-preset-dispatch/src packages/dsh-preset-dispatch/tests/replay.spec.ts
git commit -m "历史回灌：外部会话首开时把本地转录交给外部 agent，被拒时写明"
```

---

### Task 6: 图片附件

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/runner.ts`（`promptText` 扩展为 `promptContent`：提取文本块 + 图片块；按能力表决定是否带图片）
- Modify: `packages/dsh-preset-dispatch/src/content-writer.ts`（被拦下的图片写一条"未送达"行）
- Test: `packages/dsh-preset-dispatch/tests/image.spec.ts`（新建，hermetic）

**Interfaces:**
- Consumes: Task 1 的 `acceptsImageContent`；`dialect` 在 runner 里可见（经 `AcpClientPort` 或新端口）。
- Produces: `promptContent(messages, dialect): { text: string; images: { type: 'image'; data: string; mimeType: string }[] }`。

- [ ] **Step 1: 写失败测试**——claude（不收图片）：prompt 不带图片块，且 produce 出"未送达"行；codex（收）：prompt 带图片块：

```ts
it('claude 拦下图片并写明未送达', async () => {
  const sent: unknown[] = []
  /* …client.request 把 prompt 推给 sent… */
  const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: claudeDialect })
  await runner.run({ messages: [{ role: 'user', content: [
    { type: 'text', text: '这是什么颜色' },
    { type: 'image', data: 'base64…', mimeType: 'image/png' },
  ] }] }, turn)
  const prompt = sent.find(/* session/prompt */) as { prompt: unknown[] }
  expect(prompt.prompt.some(b => b.type === 'image')).toBe(false)
  /* 断言 produce 里有"未送达"行 */
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/image.spec.ts`
Expected: FAIL（`dialect` 选项不存在 / 不带图片）

- [ ] **Step 3: 实现 `promptContent` 与图片分流**——runner 构造选项加 `dialect`；`run()` 里用 `promptContent` 取代 `promptText`：`acceptsImageContent` 为 true 时把消息里的图片块原样放进 `prompt`；为 false 时只发文本，且把被拦的图片记到 `turn` 上，由 `produce` 写一条 `tool/result`（isError）或一条自定义"未送达"行（用原生错误行样式）。

- [ ] **Step 4: 文件附件**——文件块（`type: 'file'` 或 resource）暂不发，与图片同一条"未送达"规则（规格 §8）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-preset-dispatch/tests/image.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-preset-dispatch/src packages/dsh-preset-dispatch/tests/image.spec.ts
git commit -m "图片附件：按能力表分流，claude 拦下并写明未送达"
```

---

### Task 7: agent 提问接回提问卡（cursor）

**Files:**
- Modify: `packages/dsh-acp-agent/src/client.ts`（`cursor/ask_question` 不再自动应答，改走可接的钩子）
- Modify: `packages/dsh-preset-dispatch/src/approval-bridge.ts`（或新模块：把 agent 提问桥到 DSH 提问服务）
- Test: `packages/dsh-acp-agent/tests/ask-question.spec.ts`（新建，hermetic）

**Interfaces:**
- Produces: `AcpClient.onAskQuestion?: (request) => Promise<{ answer: string }>`；缺省维持现状（自动应答"无法服务"）。

- [ ] **Step 1: 写失败测试**——cursor 发 `cursor/ask_question`，客户端把它交给 `onAskQuestion`，用户答了回传：

```ts
it('cursor 的提问交给钩子、答案回传', async () => {
  let asked = false
  const client = new AcpClient(transport, cursorDialect)
  client.onAskQuestion = async () => { asked = true; return { answer: 'yes' } }
  /* 驱动 cursor/ask_question 帧，断言回传答案 */
  expect(asked).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/ask-question.spec.ts`
Expected: FAIL（`onAskQuestion` 不存在）

- [ ] **Step 3: client 暴露提问钩子**——`answerAgentRequest` 里 `cursor/ask_question`（及同类 elicitation）不再自动应答，若 `onAskQuestion` 存在则调用它并回传答案；不存在时维持"无法服务"的现有行为。

- [ ] **Step 4: preset-dispatch 接钩子到 DSH 提问服务**——在 `factory.ts` 组装 client 时把 `onAskQuestion` 接到 host 的 ask service（`ui-user-questions` 的 pending question）。接不到时维持自动应答。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/ask-question.spec.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-acp-agent/src packages/dsh-preset-dispatch/src packages/dsh-acp-agent/tests/ask-question.spec.ts
git commit -m "agent 提问：cursor 的 ask_question 桥到 DSH 提问卡"
```

---

### Task 8: 近似项与收尾

**Files:**
- Modify: `packages/dsh-acp-agent/src/projection.ts`（上下文占用：能算才算）
- Modify: `packages/dsh-acp-agent/src/catalog.ts`（模型清单读运行时）
- Modify: `packages/dsh-client/src/`（插件文案走 locale）
- Test: `packages/dsh-acp-agent/tests/approximations.spec.ts`（新建）

**Interfaces:**
- Consumes: Task 1 能力表；方言 `readReplyUsage`。
- Produces: 上下文占用在 agent 报了每轮输入 token 时才有值（codex/claude），否则无值。

- [ ] **Step 1: 写失败测试**——codex 报了 usage 时 assistant/message 带 usage；grok 没报时 usage 缺省；插件文案键在 locale 字典里存在：

```ts
it('grok 回合不带 usage', () => {
  const events = projectTurn([/* grok 帧，无 usage */], { turn: 1, dialect: grokDialect })
  const msg = events.find(e => e.type === 'assistant/message')
  expect(msg.payload.usage).toBeUndefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/approximations.spec.ts`
Expected: FAIL

- [ ] **Step 3: 实现各项**——上下文占用：沿用现有 `writableUsage`（已只写完整对），确认 grok/cursor 无 usage 时不写；模型清单：把方言 `readModels` 接进 `catalogAdapter.listModels`；错误行文案：连接类→重连提示、权限类→审批提示（在 dispatch 的 produce 里映射）；插件文案：进度条、交接卡的硬编码中文改走 locale 字典键，过 `verify-client-ui-i18n`。统计 pill 步数如实（不造数字）——确认 produce 的 step 字段就是 1，不额外伪造。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/dsh-acp-agent/tests/approximations.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-acp-agent/src packages/dsh-client/src packages/dsh-acp-agent/tests/approximations.spec.ts
git commit -m "收尾：上下文占用能算才算、模型清单读运行时、文案走 locale"
```

---

### Task 9: 活测扩项（验收）

**Files:**
- Modify: `packages/dsh-acp-agent/tests/live.spec.ts`（新增取消/图片/工具帧增量的活测用例）

**Interfaces:**
- Consumes: Task 1-8 的全部产出。

- [ ] **Step 1: 新增活测用例**——在 `live.spec.ts` 加：
  - **取消**：发一个长任务，收到首帧后发 `session/cancel`，断言 5 秒内回合结束、`stopReason === 'cancelled'`、中止后无内容落库。
  - **图片**：codex/grok/cursor 发测试图，断言答出四色；claude 断言出现"拦下"分支（产生"未送达"行）。
  - **工具帧增量**：claude 断言出现 `tool/update` 事件；codex/grok 断言只有调用+完成。
  - **历史回灌**：开会话→问一句→关掉→重开同一 DSH 会话，断言 agent 能答出上一句的内容。

- [ ] **Step 2: 跑活测**

Run: `THREADHARBOR_LIVE_ACP=1 pnpm vitest run packages/dsh-acp-agent/tests/live.spec.ts`
Expected: PASS（四家全过）

- [ ] **Step 3: 跑默认套件确认无回归**

Run: `pnpm vitest run`
Expected: 全绿（不含活测）

- [ ] **Step 4: 提交**

```bash
git add packages/dsh-acp-agent/tests/live.spec.ts
git commit -m "活测扩项：取消/图片/工具帧增量/历史回灌（四家）"
```

---

## 执行顺序与依赖

Task 1（能力表）→ 2/3/4/6 可并行（都只读能力表）→ 5（回灌，独立）→ 7（提问，独立）→ 8（收尾，依赖 1）→ 9（验收，依赖全部）。
