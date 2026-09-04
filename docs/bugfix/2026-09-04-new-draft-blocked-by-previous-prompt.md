# Bug Fix: 新建会话占位被前一个未完成的创建阻塞

## 问题描述
- 日期: 2026-09-04
- 严重程度: Medium
- 影响范围: DSH Web 「新建会话」流程。当用户先点一次「新建会话」并发送第一条消息、Agent 尚未返回时，再去侧栏点别的项目的「新建会话」，新占位会出现但 UI 完全不可用——Agent 选择器、输入框、发送按钮全是 `disabled`，看上去像创建出来了，但实际什么也做不了。

## 根因分析
- 问题位置: `packages/dsh-client/src/client/RemoteConversation.tsx` 的 `DraftConversation` 组件。
- 原因: `DraftConversation` 一直用 `snapshot.pending`（来自 `RemoteAgentStore.run` 的全局计数器）来决定是否禁用 Agent picker / 输入框 / 发送按钮。`pending: true` 表示「任意一个会阻塞会话的 RPC 正在飞行」，并不是「本占位正在创建会话」。
- 代码流程:
  1. 用户在项目 A 的 `DraftConversation` 里点发送。
  2. `RemoteAgentStore.promptSessionDraft` 在 `await this.run(..., true)` 中调用 `session.start`。`run` 把 `pendingCount += 1` 并发布 `pending: true`。
  3. 进入 `awaitSessionOpen(session.sessionId)` 等待远端 hold 打开，最长 75 秒。期间 `pending: true` 一直保留。
  4. 用户此时在侧栏点击项目 B 的「新建会话」→ `store.startSessionDraft(projectB)` 触发。
  5. `startSessionDraft` 只清掉 `currentSessionId / panel / promptProgress`，**没有动 `pending`**。`draftSession` 被改成 B，新挂载出来的 `DraftConversation` 依然拿到 `pending={snapshot.pending} === true`。
  6. 整个新占位被锁死，用户看到的现象是「界面在，但选不了 Agent 也发不出去」。

## 修复方案
- 修改文件:
  - `packages/dsh-client/src/client/RemoteConversation.tsx`
- 修改内容:
  - `DraftConversation` 不再接收 `pending` 属性；改为在组件内根据 `promptProgress` 是否属于本占位来计算 `draftBusy`：
    ```ts
    const progress = promptProgress?.projectId === project.projectId && promptProgress.sessionId === undefined
      ? promptProgress
      : undefined
    const draftBusy = progress !== undefined && progress.phase !== 'failed'
    ```
  - 把所有 `disabled={pending}` 改成 `disabled={draftBusy}`（Agent picker、SessionControls、textarea、发送按钮）。
  - `send()` 守卫加上 `|| draftBusy`，防止对已经在飞行中的本占位重复触发。
  - `RemoteConversation` 渲染 `<DraftConversation>` 时不再传 `pending={snapshot.pending}`。
- 设计取舍: 全局 `pending` 在普通会话视图里仍然有意义（控制该会话的发送按钮、`actions.canSend` 等），所以保留 `RemoteAgentStore.run` 的 `pendingCount` 不动。只把「本占位自己的连接阶段」这个局部状态移回组件。

## 验证步骤
1. ✅ `npx vitest run packages/dsh-client/tests/store.client.spec.ts`：33 个原有测试全部通过，新增的回归测试通过。
2. ✅ 新增回归测试 `clears promptProgress when a different project starts a new draft mid-flight`：模拟前一个 `promptSessionDraft` 的 `session.start` 阻塞期间、用户切换到另一个项目的 `startSessionDraft`，断言 `promptProgress` 不再匹配新项目且 `pending` 仍为 `true`，即「全局 pending 不会污染新占位」。
3. ✅ `npx vitest run packages/dsh-client/tests/conversation-model.spec.ts`、`packages/dsh-client/tests/ws-transport.spec.ts`：64 个相关测试全部通过。
4. ✅ `npx tsc --noEmit -p packages/dsh-client/tsconfig.json`：类型检查无错误。

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`
  - 新增 `clears promptProgress when a different project starts a new draft mid-flight`

## 设计建议
- 「全局 pending」同时承担两个含义：「本视图是否有 RPC 在飞」和「应用是否正在执行阻塞操作」。当一个组件只关心前者时，硬塞后者会让组件被无关请求锁住。
- 后续如果还需要支持并行创建多个会话（例如允许在创建期间立刻点「新建会话」并发送），`promptSessionDraft` 还应当串行化或排队：当 `pendingCount > 0` 且 `pendingCount` 都属于 draft 操作时，新调用应该等待或入队，而不是和旧调用并发改 `currentSessionId`。当前修复已经保证 UI 可见且可交互；并发写入是更深一层的 race，这次不引入新行为。
