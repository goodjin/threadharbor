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
- 浏览器没有挂上 gateway WebSocket，推送全部丢掉。
- `applyJournalPage` 在 `prompt_complete` 把轮次写成 idle 之后，拒绝后续 `waiting-permission`，所以即使用户后来补到日志，AskUserQuestion 也不再是待确认状态。

## 根因分析
- 问题位置:
  - gateway `WsBroadcaster` 当时 `sockets=0`（这条实时连接不在）
  - `packages/dsh-gateway/src/index.ts` `applyJournalPage`
- 原因:
  1. 整轮大约两分钟，投影该会话的 gateway 上没有浏览器 WebSocket。推送只发给活 socket，从 seq 0 全部 drop。
  2. 没 live 时不发 `transcript.read` 是合理的：通道不通，应等同一条 WS 连上后再 follow + 按 seq 补拉。HTTP 补拉和 WS 拉取是同一条控制指令，没有额外语义，不作为退路。
  3. Claude 会先发 `_x.ai/session/prompt_complete`，再发 `elicitation/create`。空闲锁把后到的询问打回 idle。

## 修复方案
- 去掉「没 live 也用 HTTP 拉 transcript / prompt / follow」。断线只保留 HTTP 重建 `state` 目录快照。
- live RPC 仍等 WS；连上后 hello + follow + `transcript.read`。
- idle 不再锁死后续 `running` / `waiting-permission`；`failed` 和用户 `stopped` 仍是终态。

## 验证步骤
1. ✅ `packages/dsh-client/tests/ws-transport.spec.ts`：断线时只有 `state` 走 HTTP，prompt / follow 不走 HTTP
2. ✅ `packages/dsh-gateway/tests/gateway.spec.ts`：`prompt_complete` 之后的 elicitation 保持 `waiting-permission`
3. ⚠️ 根因仍是当时 WS 为什么不是 live，需要浏览器侧通道日志才能钉死

## 相关测试
- `packages/dsh-client/tests/ws-transport.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`

## 设计建议
- 一条 WS 复用控制与推送。没 live 就等，不要平行开 HTTP 拉同一份数据。
- 不要把 Claude 的 `prompt_complete` 当成「不会再有询问」。
- 该会话里的 AskUserQuestion 仍卡在 hold 上。
