# Bug Fix: 新开会话 Agent 已回复但界面一直没响应

## 问题描述
- 日期: 2026-09-04
- 严重程度: Critical
- 影响范围: 3081 新开会话、实时通道断开期间的 prompt / 追日志
- 会话: `8b73ba1c-be4b-419e-8ff0-5e4b80d35957`（Claude / nexa-service）

开启会话后用户消息能出去，界面一直没有助手输出。同一类问题反复出现。

## 现场证据
- 会话 09:23 创建，09:32 发出第一轮 prompt。
- hold 活着（pid 87299），journal `latestSeq=552`，gateway `binding.lastSeq=552`、`latestTranscriptSeq=533`、`channelState=open`。
- Claude 已写出完整回复，并在 09:34 发出 `elicitation/create`（AskUserQuestion）。
- gateway 日志整段都是：
  `transcript push dropped reason=no-follower sockets=0 liveFollowers=0 followedBrowsers=1`
- 浏览器没有挂上 gateway WebSocket，推送全部丢掉。
- 客户端 live RPC 只走 WebSocket：`transcript.read` / `session.prompt` 在断线时干等，不会用 HTTP 把已投影的 transcript 拉回来。
- `applyJournalPage` 在 `prompt_complete` 把轮次写成 idle 之后，拒绝后续 `waiting-permission`，所以即使用户后来补到日志，AskUserQuestion 也不再是待确认状态。

## 根因分析
- 问题位置:
  - `packages/dsh-client/src/client/ws-transport.ts` `call` / `follow`
  - `packages/dsh-client/src/client/store.ts` `reload`
  - `packages/dsh-gateway/src/index.ts` `applyJournalPage`
- 原因:
  1. 2026-09-02 之后控制面变成「live 只走 WS，HTTP 只重建 `state`」。WS 没挂上 follower 时，gateway 仍在投影 journal，浏览器却既收不到 push，也不能 `transcript.read`。
  2. `followedBrowsers=1` 来自 HTTP `session.follow`，`sockets=0` 表示这条 TCP 升级连接不在同一份 `WsBroadcaster` 上。推送按 socket 过滤，于是从 seq 0 开始全部 drop。
  3. Claude 会先发 `_x.ai/session/prompt_complete`，再发 `elicitation/create`。空闲锁把后到的询问打回 idle，界面看起来像「本轮已经结束、没有下文」。

开启会话不稳定，是因为新会话的第一轮最依赖「WS 已 live + follow 已绑到该 socket」。任何一边没就绪，Agent 都在跑，页面都是空白。

## 修复方案
- WS 未 live 或 socket 中途断开时，控制 RPC（含 `session.prompt` / `session.follow` / `transcript.read`）立刻走 HTTP，不再干等 5 秒。
- 断线期间 `follow` 也走 HTTP，gateway 继续投影；重连后仍由 WS 再 follow 一次。
- catalog `reload` 后对当前会话补拉 transcript，避免只拿到空目录。
- idle 不再锁死后续 `running` / `waiting-permission`；`failed` 和用户 `stopped` 仍是终态。

## 验证步骤
1. ✅ `packages/dsh-client/tests/ws-transport.spec.ts`：断线时 prompt / follow / transcript.read 走 HTTP
2. ✅ `packages/dsh-client/tests/store.client.spec.ts`：reconnecting 时能把已有 transcript 拉进快照
3. ✅ `packages/dsh-gateway/tests/gateway.spec.ts`：`prompt_complete` 之后的 elicitation 保持 `waiting-permission`
4. ⚠️ 重启 3081 后硬刷新，打开该会话应能看到已生成的回复和询问卡片；新开会话在 WS 抖动时不应再空白

## 相关测试
- `packages/dsh-client/tests/ws-transport.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`

## 设计建议
- WS 是快路径，不是唯一控制面。Agent 产出必须能通过 `transcript.read` 补齐。
- 不要把 Claude 的 `prompt_complete` 当成「不会再有询问」。
- 该会话里的 AskUserQuestion 仍卡在 hold 上；补到 UI 后需要用户作答，或点停止后再开一轮。
