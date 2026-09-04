# Bug Fix: 不同 Agent 结束信号不一致，会话卡在「等待响应中」

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: Codex / Grok / Claude / DSH 四种后端的会话结束判定；`session.turnState` 在 hold 没有发出原生 turn-end 通知时停留在 `running`，UI 卡在「等待 Agent 响应」/「等待响应超时」

## 根因分析
- 问题位置:
  - `packages/hostd/src/hold-worker.ts` `receiveText` (line 297-345)：只在 `backend === 'codex' || backend === 'claude'` 时，根据 `session/prompt` 的 JSON-RPC 响应合成 `_x.ai/session/prompt_complete`。
  - `packages/hostd/src/hold-worker.ts` `completesPrompt` (line 562-576)：grok 等原生 `_x.ai/session/prompt_complete`，DSH 等原生 `session.status=idle` / `session.event type=turn/end`。
  - `packages/dsh-gateway/src/projection.ts` `projectDsh` (line 120-163)：只识别 `session.status` 和 `session.event`，不识别 `_x.ai/session/prompt_complete`。
- 原因:
  1. 只有 Codex / Claude 利用「JSON-RPC 响应本身就是 turn 收束信号」这一点；Grok / DSH 依赖后端自己再发一条通知。
  2. DSH 后端（`packages/hostd/tests/fixtures/fake-dsh.mjs:24-32` 复现了真实行为）常常返回 JSON-RPC 响应后再发 `session.status=running`，永远不发 `idle`，导致：
     - `promptActive` 永远不清零，`drainPromptQueue` 短路（`hold-worker.ts:541`），下一条 prompt 永远不入队。
     - gateway 投影看不到 idle，`session.turnState` 停在 `running`。
     - UI 在 `conversation-model.ts:127-146` 渲染「等待 Agent 响应」/「等待响应超时」。
- 代码流程: 用户发送 → hold 写入 JSON-RPC 请求 → 后端返回 result → hold 因为不是 codex/claude 不合成完成帧 → 后端只发 `running` → `promptActive` 一直 true → UI 永远等。

## 修复方案
- 修改文件:
  - `packages/hostd/src/hold-worker.ts`：
    - `receiveText` 拆出 `isPromptResponse` 判断，统一从 `session/prompt` 的 JSON-RPC 响应合成完成帧（覆盖全部后端）。
    - 新增 `synthesizePromptCompletion` 私有方法：ACP 后端返回 `{ method: '_x.ai/session/prompt_complete', params: { stopReason } }`；DSH 返回 `{ method: 'session.event', params: { event: { type: 'turn/end', data: { reason: { kind: 'completed' | 'error' } } } } }`。
    - 错误响应不合成帧但清零 `promptActive`，让后续 `concludeTurn` / transport-closed 路径自然推进状态。
    - `completesPrompt` 原生通知识别保留作为「响应比通知晚到」场景的兜底（已幂等：`promptActive=false` 之后 `drainPromptQueue` 是空操作）。
  - `packages/dsh-gateway/src/projection.ts` `projectDsh`：
    - 在 `session.status` 之前补一段 `_x.ai/session/prompt_complete` 识别，复用现有 stopReason 失败判定。这是 defense-in-depth：万一 hold-worker 漏掉合成，gateway 投影也能从原生帧恢复。
- 修改内容: 任何后端的 `session/prompt` JSON-RPC 响应都会在 hold 里立刻产生一个 backend-appropriate 完成帧；gateway 投影总是能把它翻成 `turnState: idle`。

## 验证步骤
1. ✅ `packages/hostd/tests/hold-worker.spec.ts`：`synthesizes a turn-completion frame from the grok/dsh JSON-RPC response` 断言 JSON-RPC 响应后立即 admit 下一条 prompt，journal 中出现对应完成帧。
2. ✅ `packages/dsh-gateway/tests/projection.spec.ts`：DSH 投影把合成 `_x.ai/session/prompt_complete` 翻译成 `turnState: idle` / `failed`。
3. ✅ `packages/dsh-gateway/tests/gateway.spec.ts`：`flips a DSH turn to idle from the synthesized prompt_complete` 断言只有合成帧、没有原生 idle 通知的情况下 gateway 端到端 `turnState` 也是 `idle`。
4. ✅ 全量回归 237 测试通过。
5. ⚠️ 真实环境需要带上新版 hostd 才能验证；如果只更新 gateway 而没更新 hold，行为不变。

## 相关测试
- `packages/hostd/tests/hold-worker.spec.ts`
- `packages/dsh-gateway/tests/projection.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`

## 设计建议
- JSON-RPC 响应是「协议层」信号，比后端原生通知稳定；让 hold-worker 用它统一判定 turn 收束，可以消除每接一个后端都要适配一轮完成信号的脆弱路径。
- 完成帧格式按后端协议族生成（ACP 用 `_x.ai/session/prompt_complete`，DSH 用 `session.event turn/end`），保持下游投影对称。
- 原生通知识别保留作为兜底；当 hold 升级前/后过渡、或后端提前发通知时，仍能正确收束。
