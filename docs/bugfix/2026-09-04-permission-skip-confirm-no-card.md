# Bug Fix: 已选跳过确认仍停在「等待你的确认」，且没有可点的权限卡

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: Claude 会话权限确认（退出 plan mode 的 `session/request_permission`）
- 会话: `e6c8181d-ffd6-4cff-b899-cd5f029bfe17`（3080 / claude）

横幅显示「等待你的确认 / 远程 Agent 需要权限后才能继续。点选项或停止本轮。」，但主区底部没有权限确认框。会话里已经把权限选成「跳过确认」。

## 根因分析
- 问题位置:
  - `packages/dsh-client/src/client/conversation-model.ts` `shouldAutoApprovePermissions`
  - `packages/dsh-client/src/client/RemoteConversation.tsx` 自动批准 effect、transcript 渲染
- 原因:
  1. Claude 的「跳过确认」是 `permissionMode=bypass`，不是「批准」下拉的 `approvalChoice=auto`。自动批准只认后者，改权限模式不会替用户点选项。
  2. 该会话的权限帧在 transcript seq 371（退出 plan：`bypassPermissions` / `auto` / `acceptEdits` / `default` / `plan`）。后面还有大量 tool/reasoning 行。`waiting-permission` 横幅画在最底部，卡片留在几百条消息之上，跟底时看不见。
  3. 自动批准会遍历全部历史 permission 行，失败后仍写入 `answeredPermissionsRef`，同一请求不会重试。
- 代码流程: 用户选「跳过确认」→ 只写 localStorage → Claude 仍发出 `session/request_permission` → 横幅说点选项 → 卡片不在可视区 → 自动批准不触发。

## 修复方案
- `permissionMode=bypass`（以及 Codex `full-access`）与 `approvalChoice=auto` 一样自动批准权限授予，不代替 AskUserQuestion。
- 跳过确认时优先选 `bypassPermissions`。
- 只处理当前 `waiting-permission` 的最后一条权限；提交失败则允许重试。
- `waiting-permission` 且权限卡不是最后一条时，在 transcript 尾部再钉一张可点的卡片。

## 验证步骤
1. ✅ `conversation-model`：bypass 会自动批准并选 `bypassPermissions`；权限卡被后续 tool 行顶走时仍判定需要钉住
2. ⚠️ 3081 需加载本工作区后，Claude 在 plan 里选「跳过确认」应自动点「Yes, and bypass permissions」；若自动批准未生效，底部应能看到选项卡

## 相关测试
- `packages/dsh-client/tests/conversation-model.spec.ts`

## 设计建议
- 会话选项目前只存在浏览器 localStorage，没有下发 `session/set_mode`。跳过确认要真正让 Claude 不再提问，需要后续把模式写进 ACP。当前修复先保证 UI 能点、能自动点。
