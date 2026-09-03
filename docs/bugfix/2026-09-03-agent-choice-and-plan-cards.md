# Bug Fix: Agent 提问和计划列表没有统一交互

## 问题描述
- 日期: 2026-09-03
- 严重程度: High
- 影响范围: Claude / Grok / Codex 会话中的 AskUserQuestion 与执行计划

Agent 发出 AskUserQuestion 时提示「在本会话不可用，请直接回复三种方案之一」；计划更新只显示「远程计划已更新」，无法点选。

## 根因分析
- 问题位置:
  - `packages/hostd/src/server.ts` ACP `initialize`
  - `packages/dsh-gateway/src/projection.ts`
  - `packages/dsh-client/src/client/RemoteConversation.tsx`
- 原因:
  1. hostd 初始化 ACP 时 `clientCapabilities` 为空。Claude ACP 因此关掉 AskUserQuestion，改成让用户打字回复。
  2. `elicitation/create` 没有投影成可回答的卡片。
  3. `sessionUpdate: plan` 被压成一句状态文本，nativeFrame 里的条目没有渲染。

## 修复方案
采用同一套选择卡片：
- ACP initialize 声明 `elicitation.form` 和 `plan`。
- `elicitation/create` 与 `session/request_permission` 都投影为 permission 行，UI 用同一套选项卡回答。
- 计划条目渲染为清单；连续计划更新只保留最新一份。
- 自动批准只作用于权限授予，不会替用户点选 AskUserQuestion。

## 验证步骤
1. ✅ projection / conversation-model / gateway elicitation 用例
2. ⚠️ 刷新 3081 后，让 Claude/Grok 提问或出计划，应出现可点选的卡片而不是让用户打字回复

## 相关测试
- `packages/dsh-gateway/tests/projection.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/conversation-model.spec.ts`
