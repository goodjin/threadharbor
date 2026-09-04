# Bug Fix: DSH 会话点停止停不了

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 3080 上 DSH 会话的「停止」按钮；会话 `f3312d2f-71d0-4bc1-9b3d-3de6b7adce68`

点了几次停止，会话头仍显示运行中，Agent 继续出工具调用和回复。该会话 native journal 最终以 `turn/end reason=completed` 和 `session.status idle` 收束，不是 cancelled。

## 根因分析
- 问题位置:
  - `packages/hostd/src/hold-worker.ts` `send-frame` / `session/cancel`
  - `packages/dsh-gateway/src/index.ts` `cancel` / `projectJournalPage`
  - DeepSeek Harness SDK JSON-RPC：`dsh-jsonrpc-agent` / `@deepseek-ai/dsh-sdk-jsonrpc-server`
- 原因:
  1. Gateway 把 ACP 通知 `session/cancel`（无 `id`）转给 hold-worker，再写入 DSH stdin。
  2. DSH SDK 协议只有 `initialize` / `session/prompt` / `shutdown`。`session/cancel` 是通知，而 SDK transport **没有安装 notificationHandler**，通知被丢弃。官方说明：放弃一轮等于关掉 runtime 进程。
  3. Gateway 虽会先把 `turnState` 写成 `stopped`，但 journal 投影和 `concludeTurn` 不在同一把锁上。后续 `assistant/chunk` / `session.status=running` 会把状态写回 `running`，界面上停止一闪而过。
- 代码流程: 停止 → `concludeTurn(stopped)` → `session/cancel` 被 DSH 丢掉 → 事件继续投影为 running → 用户再点停止仍无效。

## 修复方案
- 修改文件:
  - `packages/dsh-gateway/src/index.ts`：`concludeTurn` 与 journal 投影共用 per-session 锁；已 `stopped` 时只推进 `lastSeq`，不再把后续 native 片段写入 transcript，也不把状态改回 running/idle。
  - `packages/hostd/src/hold-worker.ts`：DSH 收到 `session/cancel` 时 SIGTERM 当前 stdio 子进程并拉起新进程，重放 `initialize`。ACP backend 仍只转发 `session/cancel`。
- 修改内容: 停止对 UI 立即且可保持；DSH 当前轮次随进程退出而中断，下一轮 prompt 打到新进程（同 `sessionId`，JSONL persistence 可续上历史）。

## 验证步骤
1. ✅ gateway：DSH 停止后迟到的 chunk / `session.status=running` 不能改回 running，transcript 不含后续 chunk
2. ✅ hold-worker：DSH `session/cancel` 后 backend pid 更换，新 prompt 打到新进程
3. ✅ 既有 ACP cancel 队列测试保持
4. ⚠️ 3080 需发含 gateway + hostd 的版本；已有 DSH hold 要升级 hostd 后才会在停止时重启子进程

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts` `keeps a DSH user-stop and drops later native chunks from the dying turn`
- `packages/hostd/tests/hold-worker.spec.ts` `restarts a DSH stdio backend on session/cancel because the SDK wire has no cancel`

## 设计建议
- DSH SDK 没有 per-session cancel。ThreadHarbor 用进程重启补这个缺口；ACP 的 `dsh --profile acp` 才有真正的 `session/cancel`。长期可评估 DSH backend 改走 ACP。
- 现有会话 `f3312d2f-…` 已自行 `completed`，无需再对它发停止。
