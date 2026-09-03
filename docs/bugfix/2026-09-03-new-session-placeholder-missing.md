# Bug Fix: 新建会话没有占位，跳到空态，列表延迟出现

## 问题描述
- 日期: 2026-09-03
- 严重程度: High
- 影响范围: 点击新建会话并发送第一条消息后的侧栏占位、主区会话视图、catalog 同步

创建新会话后主区跳到「从项目新建 Agent 会话」，侧栏没有刚创建的会话；等一段时间再刷新页面，会话才出现。

## 根因分析
- 问题位置:
  - `packages/dsh-client/src/client/store.ts` `promptSessionDraft` / `consume(session.view.changed)` / `awaitSessionOpen` / `reload`
  - `packages/dsh-client/src/client/RemoteConversation.tsx` 空态分支
- 原因:
  1. `session.start` 现在立刻返回 connecting 行。客户端清掉 browser-local 草稿、写下 `currentSessionId`，但没有把返回的 session 插入 `state.sessions`。
  2. 主区用 `currentSessionId` 在 catalog 里找会话。找不到且草稿已清空时，就落到「从项目新建 Agent 会话」。
  3. `session.view.changed` 遇到未知 session 只 `reload()`，不 upsert。reload 完成前列表是空的；过期的 `state` 响应还会把刚插入的行盖掉，并把 `currentSessionId` 拨回旧会话。
  4. `awaitSessionOpen` 把 `session === undefined` 当成建立失败。任何夹在中间的 snapshot 更新都会把首次发送打成错误。

## 修复方案
- `session.start` 的返回值和 `session.view.changed` 都立即 upsert 到本地 catalog，再清草稿。
- 未知 session 的 view 推送不再为了补目录而全量 reload。
- `reload` 丢弃过期响应，并保留当前正在打开、catalog 里还没有的会话行。
- `awaitSessionOpen` 只在 lost/failed 时失败，缺行时继续等绑定。
- 主区在已有 `currentSessionId` 但 catalog 尚未跟上时显示「正在打开会话」，不再跳回新建空态。

## 验证步骤
1. ✅ `packages/dsh-client/tests/store.client.spec.ts` 29 个用例通过
2. ⚠️ 需刷新 3081 后：点新建会话应立刻出现「新会话 / 待选择」；发第一条消息后侧栏应立刻出现该会话，主区不应跳到「从项目新建 Agent 会话」

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`

## 设计建议
- 乐观创建的会话必须在同一帧进入本地 catalog。草稿可以立刻移除，但不能出现「既没有草稿也没有会话行」的窗口。
- catalog reload 是异步快照，不能当作 session 创建的唯一可见性来源。
