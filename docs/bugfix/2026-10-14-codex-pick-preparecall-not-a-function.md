# Bug Fix: 选 Codex 后本轮运行失败 `registration.adapter.prepareCall is not a function`

## 问题描述
- 日期: 2026-10-14
- 严重程度: High
- 影响范围: 所有「中途挑外部 agent 模型」的路径——已开始的会话里选 Codex（或 Grok/Claude/Cursor/zcode
  任一家的模型）后发问，本轮直接失败；切换链（judge → plan → hand over → apply）完全没有机会运行。
- 报错原文：`本轮运行失败 registration.adapter.prepareCall is not a function`。

## 现场证据
- 报错文本与运行时 `LlmRuntime.prepareCall` 里的表达式逐字一致：
  `registration.adapter.prepareCall(config.provider, config.model, signal)`
  （`reference/deepseek-harness` `packages/llm/llm/src/index.ts:931`）。
- 回放路径：已开始的会话挑了 `acp:acp-codex` 路由的模型 → 下一轮走原生 step →
  agent-loop 的 `prepareRequest` 先调 `ctx.llm.prepareCall(...)`
  （`packages/core/agent-loop/src/agent.ts:587`）→ 转到我们注册的目录适配器 → 方法不存在，TypeError。
- 该 catch 只容忍 `LlmError NO_ADAPTER`，TypeError 直接炸掉整轮——即「本轮运行失败」。

## 根因分析
- 问题位置: `packages/dsh-preset-dispatch/src/catalog.ts`（`catalogAdapter`）
- 原因:
  1. 运行时的适配器基类自带默认 `prepareCall`（组合 `resolveModel` + `stream`），
     类式适配器白得这份默认；但运行时包不可 import（见 `dispatch.ts` 顶注），我们的目录适配器是裸对象字面量，
     什么都不继承。
  2. 裸对象上实现了 `providerInfo` / `listModels` / `resolveModel` / `providerRetryPolicy` / `stream`，
     独缺 `prepareCall`——写码时对齐的运行时还没有把逐 step 准备挪到适配器上。
  3. 切换链的入口在 `stream`（`onForeignModelRequest`），而新运行时在 `stream` 之前先走 `prepareCall`，
     于是「选模型切 agent」整条链被一个 TypeError 拦在门外。
- 新会话直接建在 agent preset 上不受影响（step 被替换，从不发模型请求），所以此 bug 只咬中途切换。

## 修复方案
- `catalogAdapter` 补上 `prepareCall`，按基类默认的同一组合实现：
  `{ model: await resolveModel(...), stream: options => stream(options) }`。
- `CatalogAdapterLike` 类型同步声明该方法，明确「逐 step 准备入口」是适配器面的一部分。

## 验证步骤
1. ✅ catalog.spec：`prepareCall` 存在，model 与 `resolveModel` 同源，stream 是函数（修复前 TypeError）。
2. ✅ catalog.spec：带 sessionId 的 prepared dispatch 进入 switch hook（选 Codex 切会话的路径）。
3. ✅ catalog.spec：无 session 可切时 prepared stream 仍大声拒绝（takeover 诊断不丢）。
4. ✅ 全仓 `pnpm typecheck` + `pnpm test`（800 通过）。

## 相关测试
- `packages/dsh-preset-dispatch/tests/catalog.spec.ts`
