# Bug Fix: 发送后看不到用户消息，只剩工具调用

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 3080 长轮次会话（Claude 连续 Load skill / 工具调用）
- 会话: `e96828cb-8966-412a-9503-3b7176cfc695`
- 用户发送「构建打包重启一下」，界面上这句话消失，只剩 `load_skill` 一类工具记录。

## 现场证据
- catalog 里用户消息在：`seq=298`，`text=构建打包重启一下`，`nextTranscriptSeq` 当时约 395，条目 600+。
- 该条在按 seq 排序后的列表里距末尾约 129 条。
- `transcript.read` 默认页大小 100，尾页从 seq 324 开始，**不含** seq 298 的用户消息。
- 同一会话还有重复 seq（最多 31 条共用 seq 26）：`session.prompt` 写用户消息时没和 journal 投影串行。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `readTranscript`、`prompt`
  - `packages/dsh-client/src/client/store.ts` `start`
- 原因:
  1. 默认 `transcript.read` 取物理条目的最后 100 条。Claude 一轮会写出大量 tool-call / tool-result / reasoning，最新用户提示被挤出首页。
  2. `start()`（刷新、首次打开）只 catchup 这一页，不 backfill。用户看到的就是尾页里的工具记录。
  3. `prompt()` 写用户消息不走 `withSessionJournalApply`，和正在投影的 journal 抢 `nextTranscriptSeq`，用户消息和上一段 assistant 共用 seq 298。

## 修复方案
- 默认 `transcript.read` 从**最后一条用户消息**起取一页，而不是从末尾往回切。
- follow/hello 回放同样从最后一条用户消息开始。
- `session.prompt` 写入用户消息时与 journal 投影串行，保证 seq 唯一。
- 打开会话时 `start()` 在 catchup 后 backfill 更早的页。
- `lastTranscriptSeq` 改为取最大 seq，避免重复 seq 时取错游标。

## 验证步骤
1. ✅ gateway：默认页第一条是「构建打包重启一下」，即使后面有 12 次 Load skill
2. ✅ gateway：分页改为「当前轮次起点 + afterSeq 续页」
3. ✅ store 定向测试仍通过
4. ⚠️ 3080 需加载本次 gateway/client 后，打开该会话应能看到「构建打包重启一下」，不必只剩工具行

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
