# Bug Fix: 会话通道与本轮状态在 Web 上错位

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 会话头、活动横幅、侧栏徽章、输入框/发送/停止/重连闸门

通道异常会盖住本轮失败；本轮失败还会把通道改成 reconnecting；浏览器 WebSocket 重连在主区看不见；waiting-permission 不能停止。

## 根因分析
- `conversationStage` 先看 channel，reconnecting 时不显示 turn=failed。
- `concludeTurn(failed)` 在 hold 仍在时把 `channelState` 改成 reconnecting。
- `snapshot.phase` 从未画到会话区。
- 发送按钮不看 channel；停止按钮不看 waiting-permission。

## 修复方案
1. `conversationPresentation` 同时给出 channel 横幅和 turn 横幅，标题用 `通道 · 本轮`。
2. 本轮失败不再改 channel；只有 hold 不可达才标 reconnecting。
3. 浏览器 WebSocket 断开显示「实时通道断开，正在自动重连」，无按钮。
4. 输入/发送/停止/重连/重发/选项共用同一张闸门表；权限等待可停止本轮。

## 验证步骤
1. ✅ conversation-model：reconnecting+failed 两行都在；transport 无重连按钮；waiting-permission 可停
2. ⚠️ 刷新 3081 后打开失败且重连中的会话，应同时看到通道中断和本轮失败

## 相关测试
- `packages/dsh-client/tests/conversation-model.spec.ts`
