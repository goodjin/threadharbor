# Bug Fix: Web 输出明显慢于 Agent

## 问题描述
- 日期: 2026-09-01
- 严重程度: High
- 影响范围: 会话流式输出

Web 有响应，但字是一块一块、晚一两分钟才出来。

## 根因分析
Journal 里 1 秒 20–44 条，绝大多数是 1–6 字的 `agent_message_chunk` / `agent_thought_chunk`（「虚」「惊」「一场」），不是完整语义块。工具调用、计划、turn 结束才是完整事件，很少。

网关每 1 秒最多读 64 条，追不上 30–40 条/秒的生成，积压到 100 秒以上。

## 修复方案
- hold 合并连续同类型 token chunk（同 messageId / 思考块），满 240 字或 40ms 或遇到工具调用再写入 journal。
- 网关每批 100 条；还有未读事件就立刻拉下一批，不等 1 秒。
- hold 新增 `wait-seq`：有新 journal 立刻唤醒网关（旧 hold 不支持时退回普通 read）。

## 验证步骤
1. ✅ 抽样 journal：243 条 message chunk，中位长度 4
2. ✅ chunk-coalescer / hold-worker / gateway 测试 20/20
3. ✅ `npx tsc -b tsconfig.json`
4. ✅ 3081 已重启加载新网关；已有 hold 立刻享受 100 条/批连续拉取。token 合并和 wait-seq 需新 hold-worker（新会话或重启 hold）

## 相关测试
- `packages/hostd/tests/chunk-coalescer.spec.ts`
- `packages/hostd/tests/hold-worker.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
