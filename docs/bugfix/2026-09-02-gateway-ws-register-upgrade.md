# Bug Fix: 3081 gateway WebSocket 未注册，prompt 卡住

## 问题描述
- 日期: 2026-09-02
- 严重程度: Critical
- 影响范围: 3081 test 通道会话发送。hostd `/v1/ws` 正常，浏览器连 `gateway /remote-agent/ws` 得到 Empty reply，界面 `turnState=running` 后永远等不到回复。

## 根因分析
- 问题位置: `packages/dsh-gateway/src/index.ts`（原 313-323 行）
- 原因: gateway 绕过 `@deepseek-ai/dsh-host-webserver` 的 `registerUpgrade`，去读私有 `webServer.server` 再 `server.on('upgrade')`。
- 代码流程:
  1. HTTP 控制面用 `webServer.register()`，所以 `/remote-agent/control` 正常。
  2. WS 没有写入 `upgrades` Map。webserver 自带的 upgrade 分发器对未注册路径 `socket.destroy()`，curl 表现为 Empty reply。
  3. cordis `effect` 只同步执行一次，不是响应式；`if (server === undefined) return` 无法在 listen 后再跑。
  4. 浏览器 WS 连不上 → `session.follow` 发不出去 → `runFollowedLoop` 不启动 → journal 不流入。
  5. 曾经用 HTTP 再实现一遍 follow + `events.read` 轮询，和 WS 控制面重复。现在 HTTP 只在断线时重建 `state` 快照，live RPC 等 WS 重连。

## 修复方案
- 修改文件:
  - `packages/dsh-gateway/src/ws-broadcaster.ts`：对外 `handleUpgrade`，不再自己 listen `server.on('upgrade')`
  - `packages/dsh-gateway/src/index.ts`：`webServer.registerUpgrade({ path: /remote-agent/ws })`；prompt / applyJournalPage / journal.gap 广播 `session.view.changed`
  - `packages/dsh-client/src/client/ws-transport.ts`：live RPC 只走 WS；HTTP 仅用于断线时重建 `state`；hello 带上 lastSeenSeqs
  - `packages/dsh-client/src/client/store.ts`：catalog reload 不得覆盖 reconnecting；不再用 HTTP 轮询 journal
- 修改内容: 与 HTTP `register()` 对称注册 WS；会话视图随 journal 推送；WS 断线只 HTTP 重建快照，不把控制面再实现一遍。

## 验证步骤
1. 运行 `npx vitest run packages/dsh-gateway/tests/ws-broadcaster.spec.ts packages/dsh-gateway/tests/gateway.spec.ts packages/dsh-client/tests/ws-transport.spec.ts packages/dsh-client/tests/store.client.spec.ts`
2. 重启 3081 后，`/remote-agent/ws` 应能完成 upgrade，不再 Empty reply
3. 发送 prompt 后应收到 journal 推送，running 随 `session.view.changed` 回到 idle

## 相关测试
- `packages/dsh-gateway/tests/ws-broadcaster.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/ws-transport.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`

## 设计建议
- 以后凡是挂在 dsh-host-webserver 上的 WS 路径，只走 `registerUpgrade`，不要碰私有 `server` 字段。
- 3080 stable 仍是无 WS 的包，不要把这次改动带到 stable 通道，除非一并发布新 client/gateway。
