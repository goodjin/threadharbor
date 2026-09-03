# Bug Fix: 会话输出大量重复内容（journal seq / 分页重放）

## 问题描述
- 日期: 2026-09-03
- 严重程度: High
- 影响范围: 正在运行的会话 transcript（Claude ACP `session/update` 流式输出尤其明显）

会话 `df9883ee-2153-4f01-a2ea-d090e4260d4d` 把同一段回复、同一条工具结果重复投影了很多次。UI 再把相邻 assistant 片段拼起来，看起来像整段答案循环。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `runFollowedLoop` / `applyJournalPage`
  - `packages/hostd/src/hold-worker.ts` `page()`
- 原因:
  1. follow 循环在已经订阅 `journal.page` 的同时，每个 poll 还对 **running** 轮次调用 `events.read` catchup。push 与 catchup 会拿到同一批 `seq`。
  2. `applyJournalPage` 不丢弃 `seq <= binding.lastSeq` 的事件。同一页会被投影两次；第一次可能把 45–50 合并进 `native:...:45:0`，第二次再为 46、47… 各写一条，客户端 `mergeTranscriptEntries` 把「已合并全文 + 各分片」再拼一次。
  3. hold-worker 在 `afterSeq > latestSeq` 时把 afterSeq 重置为 0，等于从头重放整本 journal。
- 代码流程: session.prompt → follow 订阅 push → 每秒 catchup `events.read` → 与 push 重叠 → 重复 transcriptId/相邻 assistant 拼接。

## 修复方案
- `applyJournalPage` 按 session 串行，并忽略 `seq <= lastSeq`。
- `appendTranscriptBatch` 跳过已存在的 `transcriptId`。
- follow 循环只在 `waiting-permission` 时 catchup（ACP 权限 RPC 返回前 wait-page 可能卡住），running 只走 live push。
- hold-worker：`afterSeq` 超前时返回空页，不 rewind。

## 验证步骤
1. ✅ `packages/dsh-gateway/tests/gateway.spec.ts`：同一 journal 页应用两次，assistant 文本仍是 `hello world`
2. ✅ `packages/hostd/tests/hold-worker.spec.ts`：afterSeq 超前返回空 events
3. ✅ 3081 / hostd 已用新 bundle 重启。已写入 catalog 的旧重复内容不会自动收缩；该会话再发新消息不应继续循环。

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/hostd/tests/hold-worker.spec.ts`

## 设计建议
- journal seq 和 transcript seq 是两套编号。catchup 只能用 binding.lastSeq（journal），不能用 latestTranscriptSeq。
- 幂等投影是权限 catchup 和 live push 共存的前提。
