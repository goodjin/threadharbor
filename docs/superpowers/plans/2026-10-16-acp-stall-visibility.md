# 外部 agent 卡死：立停、静默超时与运行可见性 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部 agent「活着但连不上后端」时：停止立即生效（宽限后杀进程）、帧静默超时自动收场、收场带 stderr 诊断包。

**Architecture:** 传输层加「活动信标」（帧进展与 stderr 诊断分开）；AcpSession 暴露 diagnostics()；网关统一持有三条强制收场路径（用户停止 / 静默超时 / 总上限），都走「立即收场 + 杀进程 + 丢弃缓存会话，下一请求重开」。

**Tech Stack:** TypeScript（宿主直载、无参数属性风格）、vitest（含 fake timers）、ACP JSON-RPC。

**Spec:** `docs/superpowers/specs/2026-10-16-acp-stall-visibility-design.md`（含事故证据索引；本计划的一切语义以它为准）

## Global Constraints

- 网关/注册表/工厂是宿主无转译直载的模块：**不用 TS 参数属性**，字段逐一赋值（gateway.ts:267 的既有约定）。
- 注释语言跟随所在文件的既有主流（gateway/transport 英文为主，可夹中文；引用事故时写日期+会话号，同现有注释风格）。
- 测试从仓库根运行：`npx vitest run <file>`；涉及定时的用例用 `vi.useFakeTimers()` + `vi.setSystemTime()`/`vi.advanceTimersByTime()`，不真 sleep。
- 每个任务结束跑该包全部测试；最后一个任务跑 `pnpm run build`。
- 错误码沿用现有命名风格：新增 `ACP_STALLED`；`ACP_TIMEOUT` 已存在。
- 默认值（spec 固定）：stall 120 000、total 1 800 000、warn 30 000、grace 3 000；`0` 一律表示关闭该项（total 0 = 不限）。

## Review Focus

1. **stderr 周期警告不得重置静默计时**（codex 重试循环会周期打警告；若算进展则卡死回合永远等不到静默超时）— Task 4 测试钉死。
2. **warnMs ≥ stallMs 倒挂**：提示作废、不报错、stall 照常（spec「配置」节）— Task 4。
3. **宽限期内 run() 自行了结**：不杀进程、不丢会话，下一回合复用 — Task 3。
4. **0 值语义**：stallMs=0 不做静默收场、totalMs=0 不限、warnMs=0 不写提示 — Task 4/5。
5. **强制收场后同会话下一请求**：必须重开新外部会话（primer 重放已有，勿破坏）— Task 3/5 的 reopen 断言。

---

### Task 1: 活动信标 ActivityBeacon（dsh-acp-agent 传输层）

**Files:**
- Modify: `packages/dsh-acp-agent/src/transport.ts`
- Modify: `packages/dsh-acp-agent/src/index.ts`（若 transport 导出经它汇总——按现状决定）
- Test: `packages/dsh-acp-agent/tests/transport.spec.ts`

**Interfaces:**
- Produces: `export class ActivityBeacon { frame(): void; diagnostic(line: string): void; lastFrameAt(): number; lastDiagnosticAt(): number; stderrTail(): readonly string[] }`（epoch ms；构造时刻为两个时间戳的初值；ring 上限 20 行）
- Produces: `AcpTransport` 接口新增 `lastFrameAt(): number; lastDiagnosticAt(): number; stderrTail(): readonly string[]`
- 三个实现类（Stdio / WebSocket / GrokServe）各持一个 `ActivityBeacon`：
  - Stdio：stdout 每行 `beacon.frame()`；stderr 每行 `beacon.diagnostic(trimmed)`（在现有 stderrTail.push 处替换；进程死亡「遗言」改读 `beacon.stderrTail()`，现有死亡消息拼接不变）
  - WebSocket：socket onMessage 每行 `beacon.frame()`；无 stderr，`lastDiagnosticAt()` 返回构造时刻、`stderrTail()` 返回 `[]`
  - GrokServe：帧与 stderr 委托自己持有的 beacon（子进程 stderr 在现有 onDiagnostic 转发处同时 `beacon.diagnostic()`）；三个新方法暴露 beacon 的值

- [ ] **Step 1: 写失败测试**

在 `tests/transport.spec.ts` 追加三组：

```ts
describe('ActivityBeacon', () => {
  it('帧与诊断分开计时，stderr 进环形缓冲且上限 20 行', () => {
    // vi.useFakeTimers + vi.setSystemTime 推进；diagnostic 25 行后 stderrTail().length === 20 且首行是第 6 行
  })
})
describe('WebSocketAcpTransport 信标', () => {
  it('socket 收到帧后 lastFrameAt 前移，lastDiagnosticAt 不动', () => {
    // fakeSocket()（文件里已有）+ transport 构造后 emit 一行 JSON
  })
})
describe('StdioAcpTransport 信标', () => {
  it('stdout 行计帧、stderr 行计诊断', async () => {
    // spawn node -e：先写 stdout 一行 JSON，再写 stderr 一行，再写 stdout 一行；
    // 断言三个时间戳的相对次序与 stderrTail 内容
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-acp-agent/tests/transport.spec.ts`
Expected: FAIL（ActivityBeacon 未定义 / 方法不存在）

- [ ] **Step 3: 实现**

`transport.ts`：新增 `ActivityBeacon` 类（时间源 `Date.now()`，便于 fake timers）；`AcpTransport` 接口加三个方法；三个传输类按 Interfaces 接线。GrokServe 的死亡「遗言」如复用 Stdio 的拼接模式，改读各自 beacon。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-acp-agent/tests/transport.spec.ts`
Expected: PASS（含原有用例）

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-acp-agent/src/transport.ts packages/dsh-acp-agent/src/index.ts packages/dsh-acp-agent/tests/transport.spec.ts
git commit -m "acp: 传输层活动信标——帧进展与 stderr 诊断分计"
```

---

### Task 2: AcpSession.diagnostics()（注册表与工厂）

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/registry.ts`（AcpSession 类型 + AcpPresetConfig 字段）
- Modify: `packages/dsh-preset-dispatch/src/factory.ts`（DeathFanoutTransport 转发 + session 装配）
- Test: `packages/dsh-preset-dispatch/tests/factory.spec.ts`

**Interfaces:**
- Consumes: Task 1 的传输层三方法。
- Produces（registry.ts）: `export type AcpSessionDiagnostics = { readonly lastFrameAt: number; readonly lastDiagnosticAt: number; readonly stderrTail: readonly string[] }`；`AcpSession` 新增 `diagnostics(): AcpSessionDiagnostics`
- Produces（registry.ts）: `AcpPresetConfig` 删除 `answerTimeoutMs`，新增 `totalMs?: number; stallMs?: number; warnMs?: number; graceMs?: number`（注释说明默认值与 0 语义，替换原 answerTimeoutMs 注释块）
- factory.ts：`DeathFanoutTransport` 三个新方法直接 `return this.inner.…()`；`open()` 返回的 session 增加 `diagnostics: () => ({ lastFrameAt: transport.lastFrameAt(), lastDiagnosticAt: transport.lastDiagnosticAt(), stderrTail: transport.stderrTail() })`（读外层 fanout 包装）

- [ ] **Step 1: 写失败测试**

factory.spec.ts：注入 `deps.transport` 假传输（含三个信标方法，可被测试推进）→ `makeSessionFactory(...).open(...)` → 断言返回的 session `.diagnostics()` 透传三个值；假传输不含新方法时 TS 类型报错即失败信号。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-preset-dispatch/tests/factory.spec.ts`
Expected: FAIL（diagnostics 不是函数 / 类型缺成员）

- [ ] **Step 3: 实现**

按 Interfaces；registry 的 AcpSession 是纯类型，factory 是唯一装配点。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-preset-dispatch/tests/factory.spec.ts tests/registry.spec.ts`
Expected: PASS（registry.spec 若引用 answerTimeoutMs 需同步改到新字段名）

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-preset-dispatch/src/registry.ts packages/dsh-preset-dispatch/src/factory.ts packages/dsh-preset-dispatch/tests/
git commit -m "acp: 会话暴露诊断信标；preset 配置 totalMs/stallMs/warnMs/graceMs 取代 answerTimeoutMs"
```

---

### Task 3: 网关立停与宽限杀

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/gateway.ts`（`GatewayConversations.answerOnce`）
- Test: `packages/dsh-preset-dispatch/tests/gateway.spec.ts`

**Interfaces:**
- Consumes: 现有 `request.signal` → controller 转发（gateway.ts:354）、`this.close(sessionId)`（gateway.ts:423）。
- Produces: 构造器第 5 参从 `answerTimeoutMs?: number | ((presetId) => number | undefined)` 改为 `limits?: (presetId: string) => GatewayLimits`，`export type GatewayLimits = { readonly totalMs?: number; readonly stallMs?: number; readonly warnMs?: number; readonly graceMs?: number }`（undefined 字段落默认值；本任务只消费 graceMs，其余字段占位给 Task 4/5）
- Produces: 常量 `DEFAULT_GRACE_MS = 3_000`；中止路径：`request.signal` abort 时**立即**以 `{ kind: 'aborted', reason: 'stopped by user' }` 收场（resolve 现有 race），随后起宽限 `setTimeout(graceMs)`：到期时 `run` 未了结（`run.then` 置的 settled 标志仍 false）→ `this.close(sessionId)` + `this.report('acp gateway: session <id> did not settle within <grace>ms of stop — external conversation dropped')`；期间了结则只清计时器。graceMs=0 → 不等、立即杀。

- [ ] **Step 1: 写失败测试**

gateway.spec.ts（`vi.useFakeTimers()`；沿用文件里的 `fakeSession`/`recordingAppend` 工具，给 fakeSession 加 close 计数与「永不 settle 的 run」变体）：

```ts
it('停止信号立即以 aborted 收场；宽限后未了结则杀会话，下一请求重开', async () => {
  // request.signal abort → await answer 立即 resolve，finish chunk reason.kind === 'aborted'
  // advance 3000 → session.close 调用 1 次；再发一请求 → open 第 2 次（重开）
})
it('宽限期内 run 了结：不 close、会话复用', async () => {
  // run 在 1s 时 settle（fakeSession 定时 resolve）→ advance 3000 后 close 0 次；下一请求 open 仍 1 次
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-preset-dispatch/tests/gateway.spec.ts`
Expected: FAIL（abort 后 answer 悬挂不 resolve）

- [ ] **Step 3: 实现**

现有 race 结构保留；`done()` 里统一清全部计时器；abort 监听在现有 controller 转发旁边加；宽限计时器在收场后启动（done 之后），settle 即清。`run.catch(() => {})` 兜底已有，勿动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-preset-dispatch/tests/gateway.spec.ts tests/cancel.spec.ts`
Expected: PASS（cancel.spec 覆盖运行器侧，不应受影响）

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-preset-dispatch/src/gateway.ts packages/dsh-preset-dispatch/tests/gateway.spec.ts
git commit -m "acp 网关：停止立即收场 + 宽限后丢弃外部会话"
```

---

### Task 4: 静默超时、静默提示与诊断包

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/gateway.ts`
- Test: `packages/dsh-preset-dispatch/tests/gateway.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `entry.session.diagnostics()`；Task 3 的 `GatewayLimits` 与统一 race 结构。规格说的「`turn.write` 通道」在网关侧就是 `sessionAppend` 取到的 `append`（`turn.write` 的底层同一条），系统消息不经运行器投影、直接 append。
- Produces: 常量 `DEFAULT_STALL_MS = 120_000`、`DEFAULT_WARN_MS = 30_000`、错误码 `ACP_STALLED`。
- Produces: `answerOnce` 的监督循环——`run` 发出后记 `promptAt = Date.now()`，`setInterval(tick, POLL)`，`POLL = stallMs > 0 ? Math.min(1000, Math.max(200, stallMs / 4)) : 1000`；`silentFor = now - Math.max(diagnostics.lastFrameAt, promptAt)`（**stderr 不参与**）。tick 内两件事，`done()`/强停都清 interval：
  - 提示（一次即止，`warnMs > 0 && warnMs < stallMs` 才启用）：经 `append`（sessionAppend 取到的那个）写 `append('system/message', { message: { role: 'system', content: [{ type: 'text', text }] } }, { surfaceOp: 'append' })`，text = `等待外部 agent——已静默 ${Math.round(silentFor / 1000)}s；agent 最近输出：${tail}`，`tail` = stderrTail 末行截 160 字符或 `（无输出）`
  - 静默收场（`stallMs > 0 && silentFor >= stallMs`）：`done({ end: { kind: 'error', error: { code: 'ACP_STALLED', message } } })`，message = `外部 agent 静默 ${Math.round(silentFor / 1000)}s 无进展，已自动停止并重开新会话。进程处置：已终止；agent 输出尾部：\n${lines}`，`lines` = stderrTail 末 5 行各截 200 字符换行拼接（空则 `（无）`）；随后本任务先直接 `this.close(sessionId)`（Task 5 再统一条件）
- Produces（plugin.ts）: 构造 `GatewayConversations` 的第 5 参改为 `presetId => { const p = presets.presets[presetId]; return p === undefined ? {} : { totalMs: p.totalMs, stallMs: p.stallMs, warnMs: p.warnMs, graceMs: p.graceMs } }`

- [ ] **Step 1: 写失败测试**

```ts
it('帧静默达 stallMs：ACP_STALLED 收场，消息带尾部，会话被杀', async () => {
  // fakeSession.diagnostics 可注入：lastFrameAt 停在 promptAt，stderrTail 含 'tls handshake eof'
  // advance 120_000 → finish error ACP_STALLED；message 含 'tls handshake eof' 与 '已终止'；close 1 次
})
it('stderr 行不算进展：诊断时间戳前移，静默照常触发', async () => {
  // lastDiagnosticAt 持续前移、lastFrameAt 不动 → 仍在 stallMs 收场
})
it('帧到达重置静默', async () => {
  // 60s 时推进 lastFrameAt，再静默 → 收场时刻相应后移
})
it('静默 30s 写一次提示，且只写一次', async () => {
  // recordingAppend 捕获 system/message：text 含 '已静默' 与 stderrTail 末行；advance 到 90s 仍只有 1 条
})
it('warnMs ≥ stallMs 不写提示；stallMs=0 不做静默收场', async () => {
  // 两分支各一：前者 advance 过 stallMs 无 system/message；后者 advance 10min 无 ACP_STALLED
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-preset-dispatch/tests/gateway.spec.ts`
Expected: FAIL（无静默收场/提示）

- [ ] **Step 3: 实现**

按 Interfaces 的监督循环；提示写入包 try/catch（写失败不致命，与运行器 writeOpeningCard 同姿势）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run packages/dsh-preset-dispatch/tests/gateway.spec.ts tests/plugin.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-preset-dispatch/src/gateway.ts packages/dsh-preset-dispatch/src/plugin.ts packages/dsh-preset-dispatch/tests/
git commit -m "acp 网关：帧静默超时自动收场，静默提示与 stderr 诊断包"
```

---

### Task 5: 总上限迁移与统一丢弃

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/gateway.ts`
- Modify: `docs/install-plugins.zh.md`（preset 行字段文档）
- Test: `packages/dsh-preset-dispatch/tests/gateway.spec.ts`

**Interfaces:**
- Consumes: `GatewayLimits.totalMs`；现有 600s 总期限（gateway.ts:386-396、`DEFAULT_ANSWER_TIMEOUT_MS`）。
- Produces: `DEFAULT_TOTAL_MS = 1_800_000` 取代 `DEFAULT_ANSWER_TIMEOUT_MS = 600_000`；总上限到点 message = `外部 agent 回合超过总上限 ${totalMs}ms，已自动停止并重开新会话。静默 ${silentFor}s；进程处置：已终止；agent 输出尾部：\n${lines}`（诊断包同 Task 4 格式；silentFor 按同一算法）
- Produces: 统一丢弃——现有 `end.error.code === 'ACP_CONNECTION'` 才 close 的条件（gateway.ts:416-419）扩为 code ∈ {`ACP_CONNECTION`, `ACP_STALLED`, `ACP_TIMEOUT`}；Task 4 在 stall 分支先行的 `close` 移除，统一走这里（避免双关）；注释同步改写（保留 f60dcf2b 事故引注，补 2026-10-16 423817a9 复用卡死进程的引注）。停止宽限杀的丢弃仍在 Task 3 的宽限路径（不经此条件）。
- Produces: `docs/install-plugins.zh.md` 字段表加四个字段与默认值/0 语义，删 answerTimeoutMs。

- [ ] **Step 1: 写失败测试**

```ts
it('总上限到点：ACP_TIMEOUT 带诊断包并丢弃会话，下一请求重开', async () => {
  // 期间持续喂帧（不触发 stall）→ advance 1_800_000 → error ACP_TIMEOUT，message 含 '总上限'
  // close 1 次；下一请求 open 第 2 次
})
it('totalMs=0 不限：帧持续时 advance 3_600_000 仍挂起（不收场）', async () => { /* settle 悬挂断言用 race */ })
it('ACP_CONNECTION 仍丢弃（回归）', async () => { /* runner 返回 connection 错误 → close 1 次 */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/dsh-preset-dispatch/tests/gateway.spec.ts`
Expected: FAIL（总上限仍是 600s 且无诊断包 / 丢弃条件不含 ACP_TIMEOUT）

- [ ] **Step 3: 实现**

按 Interfaces；`limits()` 解析处一次算全四值并落默认（0 保留为 0）。

- [ ] **Step 4: 跑测试确认通过 + 全包回归**

Run: `npx vitest run packages/dsh-preset-dispatch/tests/` 然后 `npx vitest run packages/dsh-acp-agent/tests/`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-preset-dispatch/src/gateway.ts packages/dsh-preset-dispatch/tests/gateway.spec.ts docs/install-plugins.zh.md
git commit -m "acp 网关：总上限默认 30 分钟带诊断包；三类强制收场统一丢弃会话"
```

---

### Task 6: 真机活测「后端不可达」

**Files:**
- Modify: `packages/dsh-preset-dispatch/tests/gateway-live.spec.ts`
- Test: 同文件（`THREADHARBOR_LIVE_ACP=1` 门控，沿用现有跳过模式）

**Interfaces:**
- Consumes: 真实 codex 预设行 + `GatewayConversations`；`StdioAcpTransport` 继承父进程环境（transport.ts:81 的 env 未传时）。
- Produces: 新用例 `stalled backend ends with diagnostics`——测试内 `process.env.HTTPS_PROXY = process.env.HTTP_PROXY = 'http://127.0.0.1:9'`（构造前设置，finally 删除）；`limits: () => ({ stallMs: 8_000, warnMs: 2_000, totalMs: 60_000, graceMs: 1_000 })`；断言：finish 为 error、code ACP_STALLED、message 匹配 `/tls|proxy|handshake|connect|refused/i`，且会话日志收到一条含「已静默」的 system/message（若该活测挂了 sessionAppend 则断言 report 日志行）。

- [ ] **Step 1: 写失败测试（门控内默认跳过）**

- [ ] **Step 2: 门控下跑，确认现状 FAIL**

Run: `THREADHARBOR_LIVE_ACP=1 npx vitest run packages/dsh-preset-dispatch/tests/gateway-live.spec.ts`
Expected: FAIL（当前实现 600s 才收场，8s 断言超时失败）

- [ ] **Step 3: 无需实现（消费 Task 1–5）；若活测暴露接线问题，修接线不改语义**

- [ ] **Step 4: 门控下跑至 PASS + 构建**

Run: `THREADHARBOR_LIVE_ACP=1 npx vitest run packages/dsh-preset-dispatch/tests/gateway-live.spec.ts` 然后 `pnpm run build`
Expected: PASS；构建成功

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-preset-dispatch/tests/gateway-live.spec.ts
git commit -m "acp 活测：后端不可达场景钉住 ACP_STALLED 与诊断包"
```
