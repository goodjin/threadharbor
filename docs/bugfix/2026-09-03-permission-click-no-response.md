# Bug Fix: Claude 等待授权时点击选项没有反应

## 问题描述
- 日期: 2026-09-03
- 严重程度: High
- 影响范围: 会话权限卡（Claude 退出 plan mode 等 `session/request_permission`）

会话 `1132a345-123e-4df9-8855-68da21c52e66` 停在「等待授权」，点「Yes, and bypass permissions」等选项没有界面变化。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `permission` / `runFollowedLoop`
  - `packages/dsh-client/src/client/store.ts` `permission`
  - `packages/dsh-client/src/client/RemoteConversation.tsx` 权限按钮
- 原因:
  1. Claude ACP 第一条权限请求的 JSON-RPC `id` 是数字 `0`。按钮依赖 `entry.requestId`；漏掉时点击直接 return。
  2. 点选项后 `session.permission` 只把回复写给 hostd，没有立刻 `events.read`。follow 循环在 `waiting-permission` 下只等 WS push，push 没到时 catalog 的 `lastSeq` 停在权限帧（本例 88467），`turnState` 一直是 `waiting-permission`。
  3. 客户端 `mutate` 之后 `reload()` 用这份过期 catalog，权限卡还在，看起来像没点到。

## 修复方案
- 权限 id 从 `requestId` 或 `nativeFrame.id` 读取，包含数字 `0`。
- 提交权限后 gateway 立即 catchup journal，并在等待授权期间每轮 follow 补一次 `events.read`。
- 客户端提交后 reload 并 `catchupTranscript`，让 turnState 和后续消息能刷新。

## 验证步骤
1. ✅ `permissionRequestId` 对 `requestId: "0"` 和 `nativeFrame.id: 0` 返回 `"0"`
2. ✅ gateway 对 `requestId: "0"` 转发 `{ id: 0 }` 且会再调 `events.read`
3. ⚠️ 需重建并刷新 3081 后，在该会话再点权限选项确认卡片消失、会话继续

## 相关测试
- `packages/dsh-client/tests/conversation-model.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
