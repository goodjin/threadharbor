# Bug Fix: 创建会话主区没响应，切走再点回来才有内容

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 新建会话主区
- 会话: `e6c8181d-ffd6-4cff-b899-cd5f029bfe17`

创建后主区一直没响应。点开别的会话再切回来，内容都在。Agent 当时已经在跑（hold journal 200+ 条）。

## 根因分析
- 问题位置: `packages/dsh-client/src/client/store.ts` `reload`；`RemoteConversation.tsx` 只要 `draftSession` 在就渲染占位页
- 原因:
  1. 创建过程中 WebSocket 不在（`sockets=0`），gateway 推送丢掉，但 HTTP `state` 刷新仍会把新会话写进侧栏。
  2. `reload()` 在 `draftSession` 存在时**强制不设置 `currentSessionId`**，并保留 draft。主区继续停在「新会话 / 正在连接 Agent」，不显示 transcript。
  3. 点侧栏里已经出现的那条会话（或先点别的再点回来）走 `selectSession`，会清 draft、拉 transcript，所以「又可以了」。
- 代码流程: 发送 → draft 占位 → 断线 HTTP 刷新目录 → 侧栏有会话、主区还是占位 → 用户点会话 → 才看到输出。

## 修复方案
- 创建进行中若目录里已经有这次新建的会话，`reload` / `session.view.changed` 立刻离开 draft 并选中它，同时补拉 transcript。
- 主区：只要 `currentSessionId` 有值，即使 draft 还在，也渲染会话而不是占位。
- `session.start` 返回后立刻把用户消息写进本地 transcript，不空等 catchup。

## 验证步骤
1. ✅ store：创建中目录刷新会选中新会话并拉到 assistant 消息
2. ⚠️ 3080 新建后主区应马上离开占位，不必先点别的会话

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`
