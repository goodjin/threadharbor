# Bug Fix: 「在当前会话重开」总是丢掉 grok 上下文（session/load 成功却被当成失败）

## 问题描述
- 日期: 2026-09-12
- 严重程度: Medium
- 影响范围: 所有 ACP 后端（grok、codex）的会话重开/重启。用户反馈 a04bb345 "一直没有响应"：03:13 起三条 prompt 都只收到 `end_turn` 结果帧（outputTokens 300～860）而没有任何 `session/update` 内容帧，界面上看就是"没有回复"。对该会话做 `session.restart` 后通知恢复，但 nativeSessionId 从 `01a090a1…` 变成了 `01a093b4…`，模型上下文丢失。

## 根因分析
1. **上下文丢失**（`packages/hostd/src/server.ts` `nativeSessionRpc`）：重开走 `session/load`，ACP 规范里 load 的响应只有 modes/models，没有 `sessionId`；hostd 用 `stringField(result, 'sessionId')` 一律取值，取不到就抛错，`bindNativeSession` 的 catch 分支退回 `session/new` 并标记 reopened。也就是说 load 明明成功了，hostd 却当失败，每次重开都新建会话。测试没发现是因为 `fake-hold-worker.mjs` 对 session/load 也回了 sessionId。
2. **通知消失**（未修复，只定位到现象）：hold worker 到 `grok agent serve` 的 websocket 没有断过（无 transport_closed/error），请求-响应正常，但从某一刻起所有通知（包括 `_x.ai/queue/changed` 这类广播）都不再送到这条连接。时间上介于 01:37 与 03:13 之间，期间发生过：同一台 grok serve 上新建了第二个 hold（延迟复测用的临时会话，01:56）并被 SIGKILL（01:59）。怀疑 grok serve 只把通知发给最近一条客户端连接或在客户端异常断开时清空了订阅，但没有 grok serve 日志可证。

## 修复方案
- `nativeSessionRpc`：结果里有非空 `sessionId` 就用；没有且方法是 `session/load`，返回请求参数里的 `sessionId`；`result` 为 null 视为空对象。
- `tests/fixtures/fake-hold-worker.mjs`：session/load 改为像真实 agent 一样不回 sessionId，让 `revives …` 集成用例真正覆盖这条路径。

## 验证步骤
1. ✅ hostd-integration.spec.ts 含 revive 用例通过（修复前改了 fixture 会失败）；全量 vitest 通过。
2. ✅ build 后重启本地 dev hostd（不影响已 detach 的 hold worker）。
3. ⚠️ a04bb345 这次已经以新 native session 重开（修复前触发），上下文没能保住；之后的重开会走修复后的路径。

## 设计建议
- 给 hold worker 加一个"轮次结束但零内容帧"的告警（journal 里只有 end_turn 结果），网关据此在状态行提示"Agent 未返回任何内容，可尝试重开"，而不是静默显示"远程轮次完成"。
- 在同一台主机上开第二个 grok hold 后，观察第一个 hold 是否仍能收到通知；若能复现，需要给 grok serve 提 issue 或让每个 hold 独占一个 serve。
- 停掉 hold worker 时用 SIGTERM 让其正常关闭 websocket，避免异常断开。
