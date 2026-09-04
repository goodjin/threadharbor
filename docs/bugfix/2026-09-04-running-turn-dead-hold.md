# Bug Fix: 会话等了上千秒仍无响应（hold 已死）

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 3081 DSH 会话 `a990f321-5d84-481f-b6dc-77296dd00b1e`
- 用户在上一轮结束后发送「方向 A」，界面一直「等待 Agent 响应」，等到 1000+ 秒。

## 现场证据
- catalog：`turnState=running`，`binding.lastSeq=10708`，最后一条 transcript 是 06:48:10 的用户消息「方向 A」。
- hold journal 最后一条同样是 06:48:10 的 `agent/inbox/spliced`（「方向 A」进了 inbox），之后没有任何 `turn/start` / assistant 事件。
- `state.json` 记录 hold pid 12935、DSH pid 12936；这两个进程都不在。控制 socket `/tmp/th-501/h-a9bc64ef-….sock` 是 stale 文件，无人监听。
- hostd 进程本身还活着（`127.0.0.1:62846`）。

## 根因分析
- 问题位置:
  - `packages/hostd/src/ws-hub.ts` `runWaiter`
  - `packages/dsh-gateway/src/index.ts` `runFollowedLoop`
- 原因:
  1. DSH/hold worker 在 ingest 用户消息后退出。prompt 已被 journal 记下，但模型从未开始这一轮。
  2. hostd 的 `wait-page` 碰到 ECONNREFUSED 后**默默停掉 waiter**，不发 `journal.gap`。
  3. gateway 对 `running` 只等 live push，不再 `events.read`。hold 死了也没有推送，会话永远停在 running。
  4. 界面 30 秒后只显示「等待响应超时…已等待 N 秒」，通道仍是 open，没有「重新连接」。

## 修复方案
- hostd waiter 在 hold socket 死亡时向订阅者推 `journal.gap`。
- gateway 对 `running` 和 `waiting-permission` 一样，在 poll tick 上 catchup；`applyJournalPage` 会丢掉 `seq <= lastSeq`，不会重放。hold 不可达则 `concludeTurn(failed, reconnecting)`。

## 验证步骤
1. ✅ hostd-ws：dead hold 的 subscribe 会收到 `journal.gap`
2. ✅ gateway：hold 不可达时 running 变为 failed，并写入「已停止」状态记录
3. ⚠️ 3081 加载本次 gateway/hostd 后，死 hold 的 running 会话应在数秒内变成可重连，而不是空等 1000 秒
4. 该会话「方向 A」没有被模型执行，重开后需要再发一次

## 相关测试
- `packages/hostd/tests/hostd-ws.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
