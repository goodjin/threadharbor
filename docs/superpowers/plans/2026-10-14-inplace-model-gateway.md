# 原地回答：外部 agent 作为模型网关 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已开始的会话里选了外部 agent 的模型后，回答原地流式出现在当前回合；不再分叉、不再要求用户换会话。

**Architecture:** 目录适配器的 `stream` 把外来对话回合交给"网关句柄"——每个 DSH 会话一个外部对话（复用回合运行器：打底、增量、投影、中止、权限桥全都现成），把运行器的流端口翻译成宿主 `StreamChunk`。分叉路径从外来分支退役。

**Tech Stack:** TypeScript、Vitest（hermetic 假 client）、ACP over stdio、cordis 插件、DSH 运行时（`reference/deepseek-harness` 只读参照）。

**Spec:** `docs/superpowers/specs/2026-10-14-inplace-model-gateway-design.md`

## Global Constraints

- 不改 DSH 运行时源码；一切差异经由适配器契约表达。
- 默认测试套件 hermetic；真机探针单独跑，不进默认套件。
- 既有分叉/切换链代码只从**外来分支**退役；驱动会话的自检与拒绝路径原样保留。
- 增量提取是纯函数；网关句柄可注入假 client 测试。
- 用户可见文案与现有风格一致（诊断英文、面向用户的话中文）。

## Review Focus

1. **第二问重复喂全量**——游标没推进时，外部 agent 会收到第一问的复本。归 Task 1。
2. **回答流与结束块的顺序**——finish 必须在最后一个 block-end 之后。归 Task 3。
3. **回合报错时的半截文字**——已流的文字保留，流以错误拒绝收尾，宿主按回合错误记账。归 Task 3。
4. **同一会话并发两个提示**——排队而非交错。归 Task 2。
5. **外来请求误入已驱动会话**——保留"接管没发生"诊断，不进网关。归 Task 4。

---

### Task 1: 增量提取（纯函数）

**Files:**
- Create: `packages/dsh-preset-dispatch/src/gateway-feed.ts`
- Test: `packages/dsh-preset-dispatch/tests/gateway-feed.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  type FeedPlan = { readonly kind: 'first'; readonly primer: string; readonly prompt: string }
               | { readonly kind: 'next'; readonly prompt: string }
               | { readonly kind: 'nothing' }
  function planFeed(messages: readonly unknown[], cursor: { fed: number } | undefined, options: { separator?: string }): FeedPlan
  ```
- 规则：首个请求 = 既有对话打底文本（system 角色跳过；assistant 是它自己的话，跳过；user 文本拼接）+ 本轮新问题；后续 = 仅新用户侧文本；无新文本 = `nothing`（拒绝，不能空提示）。

**Steps:**
- [ ] 红测试：首问（多轮历史 + 新问题）、二问只带增量、无新增拒绝、system/assistant 跳过、工具结果按用户侧文本收。
- [ ] 实现至绿。

### Task 2: 网关句柄（每 DSH 会话一个外部对话）

**Files:**
- Create: `packages/dsh-preset-dispatch/src/gateway.ts`
- Test: `packages/dsh-preset-dispatch/tests/gateway.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  type GatewayDeps = {
    openClient(presetId: string): { client: AcpClient; dialect: AcpDialect }   // 可注入假实现
    primerOf(sessionId: string): string | undefined                             // 打底文本来源
    report(message: string): void
  }
  class GatewayConversations {
    handle(sessionId: string, presetId: string): GatewayHandle
    close(sessionId: string): void
  }
  type GatewayHandle = { run(request: GatewayRequest): Promise<GatewayOutcome> }
  type GatewayRequest = { prompt: string; primer?: string; modelId?: string; signal?: AbortSignal; sink: GatewaySink }
  ```
- 行为：懒开外部对话；同会话提示串行（队列）；请求结束推进游标；`close` 关 transport。

**Steps:**
- [ ] 红测试：懒开且复用、串行排队、close 关闭、错误传播。
- [ ] 实现至绿（底层用 AcpTurnRunner 的打开/打底/提示机器，或直连 client——以能复用 replay/handover 打底为准）。

### Task 3: 投影（ACP 更新 → StreamChunk）

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/gateway.ts`
- Test: `packages/dsh-preset-dispatch/tests/gateway.spec.ts`（同文件加 describe）

**Interfaces:**
- `GatewaySink = { chunk(c: StreamChunkLike): void }`；run 期间运行器的流端口（textDelta/reasoningDelta）翻译为 block 生命周期块，回合结果映射 finish；错误→拒绝整个异步迭代。

**Steps:**
- [ ] 红测试：文字块开/流/合序、推理块、回合完成→end_turn finish、错误→拒绝、工具卡照写（produce 走句柄内部的 write/produce 端口）。
- [ ] 实现至绿。

### Task 4: 目录适配器接线 + 守卫

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/catalog.ts`
- Test: `packages/dsh-preset-dispatch/tests/catalog.spec.ts`

**Steps:**
- [ ] 红测试：外来对话回合（无 purpose、有 sessionId）产出块流（假网关）；purpose 拒绝保留；无 sessionId 拒绝保留；模型名带 reasoningEffort 时拼回后缀。
- [ ] 实现：`stream` 的外来分支改为 `deps.gateway` 驱动；移除外来路径对 onForeignModelRequest 的调用（其类型与装配同步收敛）。

### Task 5: 插件装配 + 会话收尾

**Files:**
- Modify: `packages/dsh-preset-dispatch/src/plugin.ts`、`src/entry.ts`、`src/switch-mount.ts`（退役外来分叉分支）
- Test: `packages/dsh-preset-dispatch/tests/plugin.spec.ts`、`tests/switch-mount.spec.ts`

**Steps:**
- [ ] 红测试：装配提供 gatewayOf；外来分叉测试改为期待网关；switch-mount 中外来分叉相关用例改写或删除（保留服务校验/已驱动自检）。
- [ ] 实现至绿；尽力在会话结束事件上 close 句柄。

### Task 6: 全量验证 + 真机探针 + 文档

**Steps:**
- [ ] `pnpm typecheck && pnpm test && pnpm run build`。
- [ ] 真机探针：codex 基础名一问 + 追问（验证增量与续话）；3081 重启后手动回归一次"原会话选 codex 提问，回答原地出现"。
- [ ] 按仓库惯例补 feature/bugfix 文档并提交。
