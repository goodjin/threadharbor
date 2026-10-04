# 会话状态盘点后的处置：迟到报告不改写已结束轮次、失败标记修复后清掉并留提示

## 问题描述

状态机盘点（`docs/session-states.zh.md`）定下语义后落地的两组改动：

1. **定调一：迟到的「本轮失败」不能把已结束的轮次改成失败。** 已收拢（已回答完、或用户
   主动停止）的轮次，不该被后来才到的失败报告改写结局。
2. **定调二：失败标记是「待修信号」，重连修好后清掉，但要留一行提示**，让人看得出是
   哪个动作把失败清掉的（打开会话触发的自动重连、显式的「结束进程并在当前会话重开」）。
   而「用户主动停止」是结局本身，重连不改写它。

随同修掉盘点里的三条事实性不一致：

3. 通道死亡时「等待你的确认」不判失败，会话停在可点的确认卡片上，点下去抛内部错误。
4. 父会话有「已收拢不复开」保护（09-18），子会话没有：迟到的子任务输出会把已收拢的
   子会话永久翻回「进行中」。
5. 「本轮执行失败」横幅借用全局连接错误当失败原因，显示成与本会话无关的理由。

## 现场证据

- 用户录屏会话（transcripts 3a628ea4…）：`12:42:52 远程轮次完成` 之后又出现
  `12:43:05 远程 Agent 已停止（code 0）`、`13:09:40 远程 Agent 已停止（signal SIGKILL）`，
  状态被改成失败/丢失，横幅显示「本轮执行失败 / 在当前会话重开」「连接已丢失」。
- 盘点时逐条核对源码发现：A 类三处两套处置互相打架（详见盘点文档）。

## 根因分析

- 折叠规则只挡了「迟到的进行中」和「迟到的进程退出帧」两类；迟到的**轮次失败完成帧**
  （prompt_complete(error) 一族）仍会把已收拢的 idle 轮次翻成 failed。
  （附带更正盘点里的一处判断：stopped 期间迟到帧整段被抑制，本来就翻不动，粘滞规则里
  留的口子够不着；真正够得着的是 idle。）
- 失败标记的清除发生在自动重连（打开会话就触发）里，且不留痕迹，用户看不出请求死过、
  也看不出是谁清的。
- 「通道死亡怎么判」散落在 8 个写点，其中 5 处只认 running；子会话收拢只护住父行。

## 修复方案

- 折叠规则统一为一条：**已收拢（idle / stopped）的轮次不被迟到的失败报告改写**，事实
  照记进转录；**在途（running / 等待确认）** 的轮次被失败报告判失败——那是它真实的结局。
  「进行中不许被迟到帧翻回」维持不变。粘滞规则同步收紧：stopped 不再对失败让步。
- 修复动作清失败标记时，在记录里留一行写明动作本身：
  `重新连接会话，上一轮的失败标记已清除。` / `重新打开远程 Agent，…` /
  `结束进程并在当前会话重开，…`。重连不再改写「用户主动停止」。
- 通道死亡统一「在途即判失败」（running 与等待确认同待遇），并撤掉无法再被应答的卡片。
- 子会话与父会话同一条规则：迟到的子任务输出不把已收拢的子会话翻回进行中（只在父轮次
  在途时重开）；父轮次结束（含用户停止、看门狗收轮）照收拢还在跑的虚拟子会话。
- 失败横幅与发送失败提示不再借用全局连接错误，改为「原因见上方记录」——真实原因就在
  转录的状态行里。

## 验证步骤

1. `npx vitest run`：482 条全绿（37 个文件）。
2. `npx tsc -b tsconfig.json`：退出码 0。
3. `npm run build`：构建与产物校验通过。

## 相关测试

- `packages/dsh-gateway/tests/gateway.spec.ts`
  - does not let a late round failure rewrite a settled round（定调一）
  - clears the failed mark on reconnect with a visible notice（定调二：自动重连与显式重开
    两种动作的提示行）
  - a reconnect does not rewrite a user-stopped round（定调二：stopped 不被重连改写）
  - fails a parked turn whose channel died, instead of leaving it waiting for an answer（3）
  - does not let late subagent frames reopen a settled child session（4）
- `packages/dsh-client/tests/conversation-model.spec.ts`
  - does not borrow an unrelated connection error as the failed turn reason（5）
