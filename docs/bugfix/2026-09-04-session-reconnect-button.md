# Bug Fix: 连接异常提示没有可操作的重连

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: `channelState: reconnecting` 的会话主区

会话 `df9883ee-2153-4f01-a2ea-d090e4260d4d` 显示「连接异常，正在重试 / 暂时无法读取远程状态」，没有按钮。host 当时是健康的，会话却一直停在 reconnecting。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `concludeTurn` / `handleFollow`
  - `packages/dsh-client/src/client/RemoteConversation.tsx` `ConversationActivity`
- 原因:
  1. 轮次失败会把 `channelState` 写成 `reconnecting`，文案说「正在重试」。
  2. 浏览器 WebSocket 和 hostd WebSocket 确实有退避重连；**会话通道**不会。`handleFollow` 在 `binding.state === active` 时跳过 `session.attach`。
  3. 该会话 binding 仍是 active、turnState 已是 failed，follow 循环也不会继续，于是提示一直挂着，输入框也因 `channelState !== 'open'` 被禁用。

## 修复方案
- 打开 reconnecting/lost 会话时重新 `session.attach`。
- 提示条增加「重新连接」，走 `store.reconnectSession` → `session.attach`。
- 浏览器实时通道断开仍由后台退避重连，不额外放按钮。

## 验证步骤
1. ✅ store `reconnectSession` 会调 `session.attach` 并 reload
2. ✅ conversation-model 重连文案提示可点重新连接
3. ⚠️ 刷新 3081 后打开该会话，应能点「重新连接」把通道拉回 open

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-client/tests/conversation-model.spec.ts`
