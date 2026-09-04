# Bug Fix: 创建会话很慢最后超时，刷新却是好的

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 3080 新建会话
- 会话: `0f4c0128-75bc-4994-88e9-40f908a55af0`（Claude）

创建会话很慢，最后超时。刷新后会话已经在，而且能用。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `startSession`
  - `packages/dsh-client/src/client/store.ts` `awaitSessionOpen`
- 原因:
  1. `session.start` 立刻返回 `connecting`，hold 在后台 `completeStart`。客户端再等 WebSocket `session.view.changed` 把通道打成 `open`，最多 75 秒。
  2. 该会话 hostd 在 438ms 内就绑好了 hold。日志是 `transcript push dropped … sockets=0`：当时 gateway 上没有浏览器 WebSocket，推送全部丢掉。
  3. 客户端一直等推送，75 秒后报「远程会话建立超时」。会话其实早就 open。刷新走 HTTP `state`，看到已绑定的行，所以「又好了」。
- 代码流程: 点发送 → start 返回 connecting → 等 WS → 没有 socket → 超时。hold 早已就绪。

## 修复方案
- `session.start` 仍立刻广播 connecting 行，但 RPC **在 catalog 锁外等待 hold 完成**，成功则返回已 open 的视图，失败则抛错。其它会话的 RPC 不会被 spawn 堵住。
- 客户端拿到 open 后 `awaitSessionOpen` 立即返回，马上 `session.prompt`。创建耗时等于真实 hold 启动（这次 Claude 不到半秒），不再空等 75 秒。
- 传输层：phase 为 live 但 socket 已清空时，不再 `socket?.send` 空等请求超时。

## 验证步骤
1. ✅ gateway：`session.start` 返回 `open`，首条用户消息仍在
2. ✅ ws-transport：live 但无 socket 时 5 秒内失败，不挂 75 秒
3. ⚠️ 3080 新建会话应在 hold 起来后马上进入对话，不应再卡到超时

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/ws-transport.spec.ts`

## 设计建议
- connecting 广播给其它标签页看进度；创建这条 RPC 必须带回终态，不能把「hold 好了没有」交给可能不在的 WebSocket。
