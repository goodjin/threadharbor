# Bug Fix: 旧会话和新会话都没有 Agent 回复

## 问题描述
- 日期: 2026-09-01
- 严重程度: Critical
- 影响范围: 3081 上 Claude / Codex / Grok / DSH 的会话回复

点发送后用户消息能出去，助手侧没有后续输出。旧会话和新会话都一样。

## 根因分析
- hostd 和 hold 是活的。直接打 `session.prompt` 会立刻写入 journal。
- 浏览器改走 WebSocket 之后，`session.follow` 只从 WS 发出，但网关 `WsBroadcaster` 从不读 client 消息，follow 到不了 `ensureFollowedSync`。
- 同时客户端在 `phase === 'ready'` 时只 `reload()` 目录，不再 `events.read`。网关存储里的 transcript 不更新，界面就像没响应。
- 心跳 ping 也没有 pong，90 秒还会把 WS 掐掉。

## 修复方案
- WS 处理 `request` / `ping`，把 follow 交给 gateway dispatch。
- HTTP fallback 也会发 `session.follow`。
- 有当前会话时始终 `events.read`，不依赖 WS 推送。
- 收到任意 WS 消息就重置心跳。

## 验证步骤
1. ✅ 本机 hostd `session.prompt` 对 Claude hold 写入新 journal
2. ✅ `npx tsc -b tsconfig.json`
3. ✅ ws-broadcaster / ws-transport / store 测试 30/30
4. ✅ 3081 `events.read` 把 Claude 会话 lastSeq 从 47441 追到 48520，turnState 回到 idle

## 相关测试
- `packages/dsh-gateway/tests/ws-broadcaster.spec.ts`
- `packages/dsh-client/tests/ws-transport.spec.ts`
