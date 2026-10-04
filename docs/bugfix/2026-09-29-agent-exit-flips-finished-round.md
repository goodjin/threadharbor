# Bug Fix: Agent 进程退出把已经答完的轮次翻成「本轮执行失败」

## 问题描述
- 日期: 2026-09-29
- 严重程度: Medium（状态与提示失真，不影响已产出的回答）
- 影响范围: 所有后端的会话投影；常见于「本轮答完 → Agent 进程退出」以及重部署 SIGKILL 空闲 Agent
- 现象: 对话已经显示「远程轮次完成」，随后又出现「远程 Agent 已停止（code 0）」/
  「远程 Agent 已停止（signal SIGKILL）」，会话被标成失败，挂上「本轮执行失败 / 在当前会话重开」，
  通道状态也可能跟着变成 `lost`，界面出现「连接已丢失」。用户对已结束会话的期望是：
  状态到此为止，后面的信号不该再改它。

## 现场证据
- 网关 transcript（`~/.dsh-threadharbor-*/threadharbor/transcripts/*.jsonl`）里可直接看到成对记录，
  例如会话 `3a628ea4-3dac-453c-8316-3faf32859fd4`：
  - `12:42:52 远程轮次完成`（`turnState=idle`）
  - `12:43:05 / 12:43:07 远程 Agent 已停止（code 0）`（`turnState=failed`）
  - 之后 `13:09:40 远程 Agent 已停止（signal SIGKILL）`
- 全量统计：`远程 Agent 已停止（code 0）` 33 次、`（code 1006）` 4 次、`（signal SIGKILL）` 3 次，
  都落在各会话的轮次完成之后。
- 帧来源：`packages/hostd/src/agent-bridge.ts` 的 `child.on('exit')` / `recordTransportEnd`
  把 Agent 进程退出写成 `_dsh/transport_closed`（带 `code` / `signal`）落进 journal。

## 根因分析
- 问题位置: `packages/dsh-gateway/src/projection.ts` 的 `_dsh/transport_closed` 投影
  + `packages/dsh-gateway/src/index.ts` `projectJournalPage` 的折叠循环
- 原因:
  1. `transport_closed` 一律投影成 `role=system, kind=status, turnState='failed'`，与「模型把本轮答完」
     用的是同一个字段，投影层没有区分「轮次结束」和「进程结束」。
  2. 折叠循环无条件采信帧上的 `turnState`，于是这条迟到的退出帧把已经 `idle` 的会话改回 `failed`。
     轮次真正的完成帧（`prompt_complete`）早已发过，不会再有第二次把它翻回来。
  3. `isRoundTerminalFrame` 也把 `transport_closed/error` 当作轮次结束帧，导致本轮的用量统计
     被盖在退出状态行上（状态行可能根本不属于任何一轮）。
- 与 `2026-09-18-idle-reopened-by-late-subagent-frames` 同族：都是「轮次完成后的迟到帧改写轮次状态」，
  上次踩的是迟到子 agent 输出（`running`），这次踩的是进程退出（`failed`）。

## 修复方案
- `projection.ts` 新增 `isTransportClosureFrame()`：只回答「这帧说的是传输结束，不是轮次结束」。
- `index.ts` 折叠循环改走 `foldFragmentTurnState()`，两条迟到帧保护并列：
  - `running` 片段不能把已 `idle` 的会话翻回运行态（原 1b3f97c/575d2ed 的保护，原样保留）；
  - 传输结束帧不能把已 `idle` 的会话翻成 `failed`。轮次还在 `running` / `waiting-permission`
    时退出帧照旧判定为失败——本轮请求确实没做完。
- 退出状态行仍然照常写进 transcript（「远程 Agent 已停止（…）」是事实记录），只是不再改写会话状态。
- `isRoundTerminalFrame` 去掉 `transport_closed/transport_error`：用量与本轮结束标记回到真正的完成帧上。

## 验证步骤
1. ✅ gateway.spec：同页「轮次完成 + Agent exit」→ 会话保持 `idle`，退出状态行仍在 transcript 里
2. ✅ gateway.spec：已 `idle` 的会话随后收到退出帧（另一页）→ 仍 `idle`
3. ✅ gateway.spec：轮次进行中 Agent 被 SIGKILL → 仍然 `failed`，状态行照常出现
4. ✅ run-usage.spec：`transport_closed` 不再算轮次结束帧
5. ✅ 全量 `vitest run` 475 passed；`tsc -b` 无错误

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-gateway/tests/run-usage.spec.ts`
- `packages/dsh-gateway/tests/projection.spec.ts`
