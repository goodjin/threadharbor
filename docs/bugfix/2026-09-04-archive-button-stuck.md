# Bug Fix: 归档按钮一直显示「归档中…」不收敛

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 三条会话归档 UI 入口：
  1. 侧栏单会话菜单「归档」按钮 → `store.archiveSession()`，按钮文案永远停在「归档中…」（`RemoteSidebar.tsx` 旧实现 line 222-230）。
  2. 设置面板「立即清理过期会话」按钮 → `store.archiveStaleSessions()`，`sweepStatus.state` 永远停在 `'running'`（`RemoteConversation.tsx` 旧实现 line 1572-1586）。
  3. 设置面板「隐藏的会话」列表里「归档」按钮 → `act()` 包装的 `archiveSession()`，`pending` 状态无法退出（`RemoteConversation.tsx` 旧实现 line 1782）。

## 根因分析
- 问题位置:
  - `packages/dsh-client/src/client/store.ts` `archiveSession`（旧实现 line 1462）：归档当前会话且存在兄弟会话时 `await this.selectSession(next)`。
  - `packages/dsh-client/src/client/store.ts` `selectSession` → `catchupTranscript` → `applyCacheToSession` → `cache.getEntries` → `TranscriptCache.ensureIndex` → `dbPromise`（`transcript-cache.ts:217-220, 321-326, 337-356`）。
  - `packages/dsh-client/src/client/store.ts` `archiveStaleSessions`（旧实现 line 1518-1546）：串行 `for` 循环没有总预算保护，单会话最坏 ~90s × N。
  - `packages/dsh-client/src/client/RemoteSidebar.tsx` 单按钮：`setArchiving(false)` 写在 `store.archiveSession().finally()`，依赖 store 端 promise 收敛。
  - `packages/dsh-client/src/client/RemoteConversation.tsx` `runArchive`、`act()`：同样把收敛完全寄托在 store 返回的 promise。
- 原因:
  1. **store 端把归档的可见成功和 IndexedDB catchup 耦合**。`archiveSession` 在 `publish` 把当前 session 从 sidebar 摘掉后还 `await this.selectSession(next)`，而 `selectSession` 内部 `catchupTranscript` 会调 `applyCacheToSession`，最终走到 `TranscriptCache.ensureIndex` 里的 `dbPromise`。在私有模式、配额异常、其他标签阻塞 IndexedDB 等场景下，`dbPromise` 永不 settle，整条链路不返回；按钮的 `.finally` 永远不触发。
  2. **`archiveStaleSessions` 没有总预算**。当一批过期会话中若干个 RPC 慢或失败时，整次 sweep 的耗时是它们之和，settings panel 的 `sweepStatus` 永远停在 `'running'`。
  3. **UI 端没有兜底超时**。把按钮状态收敛完全委托给 store promise，等同于把 IndexedDB 的死活绑到用户脸上——一旦 store promise hang，所有按钮都卡死。
- 代码流程: 用户点击归档 → store 发起 `session.archive` RPC → 发布移除 row 的快照 → `await selectSession(next)` → `catchupTranscript` → IndexedDB hang → store promise 永不 settle → UI `.finally` 永不触发 → 按钮永远停在「归档中…」/「清理中…」。

## 修复方案
- 修改文件:
  - `packages/dsh-client/src/client/store.ts`:
    - 新增 `ARCHIVE_BUDGET_MS = 60_000` 常量（在 `CONTROL_REQUEST_TIMEOUT_MS` 附近）。
    - `archiveSession` 归档当前会话时把 `await this.selectSession(next)` 改成 `void this.selectSession(next).catch(() => undefined)`，并在 `publish` 时已经同步切换 `currentSessionId`。
    - `archiveStaleSessions` 进入循环前取 `startedAt = Date.now()`，每轮迭代前判断 `Date.now() - startedAt > ARCHIVE_BUDGET_MS`，超时就 `console.warn` 并 `break`，把剩余目标留到下次 sweep。
  - `packages/dsh-client/src/client/RemoteSidebar.tsx`:
    - 新增 `ARCHIVE_TIMEOUT_MS = 90_000`。
    - 单按钮 onClick 改成 `Promise.race([work, timeout])`，超时 reject 一个 `Error('归档请求超时')`；`.then` 关闭菜单，`.finally` 恢复 `archiving`。
  - `packages/dsh-client/src/client/RemoteConversation.tsx`:
    - 新增 `ARCHIVE_TIMEOUT_MS = 90_000`（放在 `SESSION_PREFERENCES_STORAGE_KEY` 附近）。
    - `runArchive` 用 `Promise.race` + 超时，resolve 用 `-1` 哨兵区分超时；超时时 `setSweepStatus({ state: 'error', message: '归档请求超时，未完成的会话会在下次自动清理时再试。' })`。
    - 隐藏会话的 `act()` helper 用 `Promise.race` + 超时，并通过 `settled` 标志避免超时后误触发 success。

- 修改内容（关键片段）:
  ```ts
  // store.ts: archiveSession —— fire-and-forget
  this.publish({
    ...withoutError(this.snapshot),
    state: { ...this.snapshot.state, sessions: remaining },
    currentSessionId: next,
  })
  void this.selectSession(next).catch(() => undefined)
  ```

  ```ts
  // store.ts: archiveStaleSessions —— 总预算
  const startedAt = Date.now()
  for (const session of targets) {
    if (Date.now() - startedAt > ARCHIVE_BUDGET_MS) {
      console.warn('threadharbor: auto-archive budget exceeded; deferring remaining sessions to the next sweep')
      break
    }
    try {
      await this.call('session.archive', { sessionId: session.sessionId })
      archived += 1
    } catch (error) {
      console.warn('threadharbor: auto-archive failed for session', session.sessionId, error)
    }
  }
  ```

- 设计取舍:
  - 把 `selectSession(next)` 改 fire-and-forget 而不是给整个归档加超时，是因为归档的可见成功（row 已移除 + 已切换 current）已经在 `publish` 那一步同步完成；`selectSession` 只是为 next 的 transcript 拉取留个窗口，让它走自己的 75s `call()` 超时即可，不应该绑架「归档按钮已恢复」。
  - 60s 的 sweep 预算与单次 `call()` 的 75s 超时有意重叠：单次 RPC 失败最多吃 75s，但 sweep 本身在 60s 时停止继续串行，避免把多个失败会话的 75s 叠加给用户。
  - UI 端 90s 超时是「内层 sweep 预算 + 余量」的兜底——就算内层出了 bug，外层也保证按钮能恢复。

## 验证步骤
1. ✅ `pnpm typecheck` 通过。
2. ✅ `pnpm test` 全量 302 测试通过；新加的两条覆盖：
   - `archiveSession on the current session does not wait for sibling catchup`：模拟兄弟会话的 `transcript.read` 永不 settle，断言 `archiveSession` 在 `publish` 移除 row 后立即 resolve（`packages/dsh-client/tests/store.client.spec.ts`）。
   - `archiveStaleSessions respects the wall-clock budget`：用 `vi.spyOn(Date, 'now')` 推进假时钟、每次 archive 增加 30s，断言 60s 总预算触发 `console.warn('auto-archive budget exceeded')`；mock state 在 archive 后把 row 标 `archivedAt` 以匹配真实 gateway 行为（避免 reload → archiveStaleSessions 循环）。
3. ✅ `pnpm build` 全包构建通过。
4. 真实环境（可选）：在 dev profile 启动 DSH，连接 hostd，触发归档：
   - 归档当前会话（应有兄弟）：按钮立即从「归档中…」恢复，sidebar 移除该 session，next session 切换。
   - 设置面板「立即清理过期会话」：状态收敛到「已归档 N 个过期会话」或「归档请求超时…」。

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`：
  - `archiveSession on the current session does not wait for sibling catchup`
  - `archiveStaleSessions respects the wall-clock budget`

## 设计建议
- IndexedDB hang 是浏览器侧的偶发环境问题，没办法靠 gateway/hostd 在协议层消解；任何走 cache 的客户端路径都应该把 cache 的生死和「用户已经看到的成功状态」解耦（这里就是把 `publish` 同步化、把后续 catchup 改成 fire-and-forget）。
- 「立即清理」类批量操作一定要有 wall-clock 总预算；单个 RPC 失败不能让整批 sweep 把按钮一直挂着。
- UI 层对任何长链路 store 操作都该有一个对用户可见的最长等待上限；store 端再稳定也不能让 IndexedDB 之类的浏览器环境问题直接外溢到 UI。
