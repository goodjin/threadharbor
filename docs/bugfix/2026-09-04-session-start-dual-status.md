# Bug Fix: 新会话同时显示两条状态而且很慢

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 3080 新建会话主区

创建会话后同时出现「正在接入实时通道」和「正在发送消息」，接入过程偏慢。

## 根因分析
- 问题位置:
  - `packages/dsh-client/src/client/conversation-model.ts`
  - `packages/dsh-client/src/client/store.ts` `promptSessionDraft` / `awaitSessionOpen`
  - `packages/dsh-gateway/src/index.ts` `startSession` / `handleFollow`
- 原因:
  1. `session.start` 立刻返回 `connecting`，客户端却把 progress 写成 `sending`。通道条和回合条独立渲染，所以两条一起出现，而 prompt 其实还没发出。
  2. 打开会话时 `session.follow` 会对还没建好的 hold 调 `session.attach`，可能把会话标 lost，再和 `completeStart` 抢写。
  3. `awaitSessionOpen` 只应等 `session.view.changed` 推送，不应再定时 HTTP 拉状态。
  4. 每次 `session.start` 都 `inventory`，会串行 ping 全部 hold。
  5. 用户消息原先要等 hold 打开后的 `session.prompt` 才写入 transcript，刷新或切走会丢。

## 修复方案
- 等 hold 打开之前 progress 保持 `connecting`；连接中隐藏 sending/waiting 回合条，只留一条「正在连接 Agent」。
- follow 先等 `completeStart`，connecting 时不 attach。
- `awaitSessionOpen` 只订阅 snapshot，由 WebSocket `session.view.changed` 推进。
- 已有健康 inventory 时不再刷新。
- `session.start` 立刻把首条用户消息写入 transcript；`session.prompt` 用同一 requestId 去重。

## 验证步骤
1. ✅ connecting + sending 只显示一条连接条
2. ✅ 等待 binding 期间 promptProgress 为 connecting
3. ✅ session.start 带 text 时，hold 未绑上也能读到用户消息
4. ⚠️ 3080 新建会话应只看到「正在连接 Agent」，刷新后用户消息仍在

## 相关测试
- `packages/dsh-client/tests/conversation-model.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
