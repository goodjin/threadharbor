# Bug Fix: Agent 提问后被后台子 agent 输出淹没，会话看似"长时间无响应"

## 问题描述
- 日期: 2026-09-14
- 严重程度: High
- 影响范围: 所有会在一轮中启动后台子 agent 的 Claude 会话（Codex/其他 ACP 后端只要有"提问后仍有 session/update 帧"的情形同样受影响）。表现为会话停在 running 半小时以上无任何输出，最后被网关 45 分钟静默判定成"远程轮次长时间无响应，已结束本轮"。实例：会话 bb5772c2，05:52:47 Claude 通过 `elicitation/create`（AskUserQuestion）提问，随后后台子 agent 又输出 111 条工具记录，问题卡片被顶到上方且锁定，无人回答，Claude 一直阻塞。

## 根因分析
- 问题位置: `packages/dsh-gateway/src/index.ts` `projectJournalPage`；`packages/dsh-client/src/client/conversation-model.ts` `pendingPermissionEntry`；`RemoteConversation.tsx` `isPermissionAnswered`
- 原因: 网关把每帧投影出的 turnState 直接折叠进会话，"最后一帧说了算"。`elicitation/create` 置 waiting-permission，紧接着子 agent 的 `tool_call` 帧又置回 running。客户端只在 turnState 为 waiting-permission 时固定/启用卡片，并把"turnState 不是 waiting-permission"视为已回答，于是卡片既不固定也点不了。hostd 的 hold-worker 其实一直记着这个未答请求（`pendingBackendRequests`），但没有上报给网关。
- 代码流程: hold journal 帧 937 `elicitation/create id=1` → 网关投影为 permission 行 seq 766（turnState=waiting-permission）→ 帧 938…1050 全是子 agent tool_call/tool_call_update（turnState=running）→ 会话 running → 客户端不显示待答卡片 → 45 分钟后网关 concludeTurn failed。

## 修复方案
- `packages/protocol/src/index.ts`：`RemoteSessionView` 新增可选 `pendingRequestIds`。
- `packages/dsh-gateway/src/index.ts`：
  - `projectJournalPage` 维护未答请求集合：permission/elicitation 片段加入其 requestId；轮次终态片段（idle/failed）清空。折叠完成后只要集合非空且 turnState 为 running，就钉为 waiting-permission。集合持久化在会话行上，随 `session.view.changed` 推送。
  - 新增 `settleBackendRequest`：`session.permission` 把应答发给 hostd 后移除该 id；集合清空且仍为 waiting-permission 时立即回到 running。
  - `concludeTurn` 清空集合；attach 到新 hold generation 时丢弃旧集合（旧进程的请求已不存在），同 generation 重连保留。
- `packages/dsh-gateway/src/spec.ts`：schema 增加 `pendingRequestIds`。
- `packages/dsh-client/src/client/store.ts`：解析 `pendingRequestIds`。
- `conversation-model.ts`：`pendingPermissionEntry(entries, pendingRequestIds)` 有 id 时按 id 找卡片（找不到返回 undefined，让 autopilot 先追 transcript）；无 id 时保持"最后一条 permission 行"以兼容旧网关。`RemoteConversation` 与 `permission-autopilot` 均传入会话的 id 列表。

## 验证步骤
1. ✅ 新增网关测试：elicitation 后跟两条子 agent 帧 → 会话 waiting-permission 且 `pendingRequestIds=['1']`；`session.permission` 后 running 且集合清空；`prompt_complete` 后 idle。
2. ✅ 新增 conversation-model 测试：按 id 定位被后续行掩埋的卡片；id 无匹配返回 undefined；无 id 时保持旧行为。autopilot 测试：按网关给出的 id 应答而不是最后一条 permission 行。
3. ✅ `npm run typecheck` 通过；`npm test` 34 个文件 404 个用例全部通过。
4. ✅ 重新构建并重启 3081 测试 GUI。
5. ⚠️ 对已经卡住的会话 bb5772c2 不追溯：其 journal 已折叠过（binding.lastSeq 在 937 之后），网关重启后不会重新看到那帧，而且它已在 06:40 被判定 failed。该会话需要手动通过 `session.permission` 回答 requestId=1，或"在当前会话重开"（丢失模型上下文）。

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts` › `keeps a turn parked on an unanswered question while a background subagent keeps reporting`
- `packages/dsh-client/tests/conversation-model.spec.ts` › `finds the pending card by request id even when later rows buried it`
- `packages/dsh-client/tests/permission-autopilot.spec.ts` › `answers the request the gateway says is open, not the last permission row`

## 设计建议
- hostd 已经知道哪些请求未答（hold-worker `pendingBackendRequests`），但只用于暂停自己的空闲守卫。后续可把它随 `events.read` / `session.attach` 的响应一并返回，这样网关重启或 journal 被截断后也能恢复集合，而不依赖网关自己的折叠。
- 网关 45 分钟静默判定对 waiting-permission 豁免，这次修复让"Agent 在等用户"的会话正确落在豁免范围内，不再被误判为失败。
