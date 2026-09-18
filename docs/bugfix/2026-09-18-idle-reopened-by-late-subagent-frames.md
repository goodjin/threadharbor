# Bug Fix: 轮次完成后的迟到子 agent 输出把会话永久卡在「进行中」

## 问题描述
- 日期: 2026-09-18
- 严重程度: High
- 影响范围: 3081 Claude 会话 `94db0c6d-1073-47c7-9a83-05d06bf2c5b4`（同类风险覆盖所有 ACP 后端）
- 用户 09:27 发问，agent 09:32 已把回答完整送达（分两段，第二段是后台子调查的收尾），
  但会话从 09:32:57 起永远显示「进行中」，侧栏转圈不停，超时后还挂「Agent 长时间没有响应」横幅，
  直到 45 分钟看门狗才误判为失败。

## 现场证据
- journal：`_x.ai/session/prompt_complete` 于 09:32:29（seq 644）到达，网关正确记下「远程轮次完成」、
  `turnState=idle`；随后 09:32:45–09:32:57 又流出 12 条 `agent_message_chunk`/`usage_update`
  （seq 645–658），之后 journal 彻底安静，再无第二个完成帧。
- 会话记录在 09:32:57 后 `turnState=running` 永不回落；`updatedAt` 只被同步循环刷新。
- transcript 文件内容完整——回答没丢，纯状态机问题。

## 根因分析
- 问题位置: `packages/dsh-gateway/src/index.ts` `projectJournalPage`
- 原因:
  1. `agent_message_chunk`/`tool_call` 等所有 `session/update` 帧一律投影 `turnState: 'running'`（projection.ts）。
  2. 折叠循环无条件采信帧上的状态：`if (fragment.turnState !== undefined) turnState = fragment.turnState`。
     完成（idle）之后的迟到帧把会话翻回 running。
  3. 该轮的 prompt_complete 已经发过，adapter 不会再发第二次，没有任何机制再把它翻回 idle。
     `stopped`/`failed` 有终态保护（1b3f97c 只修了 waiting-permission 变体），`idle` 无保护。
- 与 1b3f97c 同族：都是"后台子 agent 的迟到帧覆盖轮次状态"，只是这次踩的是 idle。

## 修复方案
- 折叠循环中 `running` 片段不允许把 `idle` 翻回运行态（用折叠过程的实时 turnState 判断，
  同时覆盖"跨多次折叠"与"同一页内先完成后迟到"两种形态）。内容照常落盘。
- 真正的下一轮只能经 prompt 准入开启——`session.prompt` 在发送前就置 running，先于任何 journal 帧。

## 验证步骤
1. ✅ gateway.spec：轮次完成后迟到的 agent_message_chunk/tool_call_update 不再把会话翻回 running，
   且迟到内容仍写入 transcript
2. ✅ gateway.spec：prompt_complete 与迟到帧在同一页一次 catchup 时同样保持 idle
3. ✅ 现场会话：watchdog 于 10:23 兜底转 failed 后用户重发，新轮次正常完成并回落 idle

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
