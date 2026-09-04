# Bug Fix: 新建会话会跳到项目会话列表最后面

## 问题描述
- 日期: 2026-09-04
- 严重程度: Medium
- 影响范围: DSH Web 侧栏「项目 → 会话」列表的展示顺序

在某个项目下点「新建会话」并发送第一条消息后，新会话出现在该项目的会话列表**最后面**，而不是最前面。每次新建都跳到尾巴，老会话被挤到上方；用户新建后还要往下翻才能看到刚创建的会话，体验割裂。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `state()` 投影（约 393 行）
  - `packages/dsh-gateway/src/index.ts` `startSessionAndWait` / `upsertNativeChild` 把 `sessionId` push 到 `state.sessionIds` 末尾（986、1560 行）
  - `packages/dsh-client/src/client/store.ts` `withSessionView`（约 286 行）和 `reload()` 的 `inFlight` 合并（1589 行）也都把新行追加到末尾
  - `packages/dsh-client/src/client/RemoteSidebar.tsx` `ProjectSection` / `applyLimitToSessions` 都不做排序，只按收到的顺序渲染
- 原因: 全链路——存储（`state.sessionIds` 是按插入顺序追加的 `z.array(sessionId)`）、客户端 upsert、reload 合并、UI 渲染——**没有任何一处按时间排序**。侧栏的「`applyLimitToSessions`」只是按收到顺序截前 N 行，不带 sort。所以新建会话必然落到末尾。
- 代码流程:
  1. 用户点「新建会话」→ `promptSessionDraft` → `session.start` 返回新 `session`。
  2. gateway 把新 id push 到 `state.sessionIds` 末尾；下一次 `state()` 也按这个顺序返回。
  3. 浏览器 `withSessionView` 把新行追加到 `state.sessions` 末尾，乐观显示。
  4. 紧接着的 `reload()` 把服务器排序好的 catalog 灌回本地，session 仍然在末尾（因为 gateway 也只追加不排序）。
  5. 侧栏按 `state.sessions` 原序渲染，结果新会话永远在尾巴。

## 修复方案
- 修改文件:
  - `packages/dsh-gateway/src/index.ts`
  - `packages/dsh-client/src/client/store.ts`
- 修改内容:
  - **Gateway `state()` 投影**：在过滤 + 注入 transcript 头之后，按 `updatedAt` 降序（缺失时回退 `createdAt` 降序）做稳定排序。排序用新增的辅助函数 `sortSessionsByRecencyDesc`。把 catalog 当作「单一权威」：所有浏览器都看到同一份顺序，不依赖各端重新排序。
  - **客户端 `withSessionView`**：新行从追加改为**前置**，与 gateway 的排序一致。这样 `session.view.changed` 或 `session.start` 返回后立刻能在侧栏看到新会话在最上方，不必等下一次 `reload()` 把 gateway 排序后的 catalog 拉回来——避免「先闪到尾巴再跳到顶」的视觉跳动。
  - **客户端 `reload()` inFlight 合并**：把 inFlight 行改为前置，而不是追加。罕见情况下（session.start 与 catalog reload 抢跑），这条路径保证乐观会话仍然在顶部。
  - **不动存储 schema**：`spec.ts` 里 `sessionIds: z.array(sessionId)` 仍是按插入顺序的 durable 数组；排序只在 projection 时发生，不影响存储语义，也不影响 audit/journal。
- 设计取舍:
  - 用 `updatedAt` 降序而不是 `createdAt` 降序：和已有的 `archiveSession` sibling-picker（store.ts:1279）保持一致——重命名或被使用过的会话也会随之浮上来，更贴近 ChatGPT/Claude.ai 这类应用的「最近活动优先」习惯。
  - 不在 `RemoteSidebar.tsx` 里排序：避免每个浏览器重复排序、当 server 与 client 排序不一致时出现短暂不一致。把排序交给 gateway 投影层是 single-source-of-truth 的做法。
  - 存储层不预排序：保持 `sessionIds` 的「durable ordering state」语义不变；只读侧排序是更小的改动。

## 验证步骤
1. ✅ `packages/dsh-gateway/tests/gateway.spec.ts` 新增 `returns newly created sessions at the top of the project list in state()`：连发 3 个 session.start，断言 `gateway.state().sessions` 按 `updatedAt` 降序排列，且**最新创建的 `third` 排在最前面**。
2. ✅ `packages/dsh-client/tests/store.client.spec.ts` 新增 `keeps newly created sessions at the top of the project list across drafts`：模拟 catalog 已有 2 条历史 session，再通过 `session.view.changed` 推一条新 session，断言本地 `state.sessions` 把新行放在最前。
3. ✅ 修正两条原有断言（`inserts a newly created session from session.view.changed without reloading`、`does not let a stale catalog reload drop the in-flight new session`）以反映新顺序：服务端响应仍是 `[s-old]`，inFlight 合并 + `withSessionView` 都改成前置 → 期望 `[s-new, s-old]`。
4. ✅ `npx vitest run packages/dsh-gateway/tests/ packages/dsh-client/tests/`：12 个测试文件、160 个用例全部通过。
5. ✅ `npx tsc --noEmit -p packages/dsh-gateway/tsconfig.json`：无错误。
6. ⚠️ Web 复现：在同一项目下连发 3 个新会话（间隔几秒），侧栏里应该看到「第三个创建的 → 第二个创建的 → 第一个创建的」自上而下排列；刷新页面后顺序保持。

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
  - 新增 `returns newly created sessions at the top of the project list in state()`
- `packages/dsh-client/tests/store.client.spec.ts`
  - 新增 `keeps newly created sessions at the top of the project list across drafts`
  - 更新 `inserts a newly created session from session.view.changed without reloading`
  - 更新 `does not let a stale catalog reload drop the in-flight new session`

## 设计建议
- 「按 `updatedAt` 降序」的隐含约定已经存在于 `archiveSession` sibling-picker（store.ts:1279）。这次修复把同一约定提升为整个 catalog 投影的排序契约，下游（侧栏、设置面板、auto-archive）都可以无成本地享受统一顺序。
- 如果后续要让侧栏支持「按 `createdAt` 升序」「按字母」之类的切换，应该在 catalog 投影层加 `?order=createdAt|updatedAt|title` 参数，而不是把排序散落到各个组件里。
- Gateway 写入侧的 `state.sessionIds.push(...)` 仍然按插入顺序：durable 日志保留「会话真实创建次序」，便于将来需要 audit 或回放时按时间重建。
