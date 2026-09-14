# Bug Fix: hostd 丢失会话记录后，会话永远无法"在当前会话重开"

## 问题描述
- 日期: 2026-09-11
- 严重程度: High
- 影响范围: 所有绑定到某台 hostd 的会话。hostd 数据目录被清空或更换后（本例是本地 dev hostd 的 `--data-dir` 放在 `/tmp`，机器重启后被清空），Web 侧对这些会话的任何操作都持续报 `Error: unknown hostd session <id>`，"在当前会话重开"和"结束进程并重开"都无法恢复。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `attachSession` / `restartSession`：只会调用 hostd 的 `session.attach` / `session.restart`，两者在 hostd 侧都依赖 `sessions.json` 中已有记录（`packages/hostd/src/server.ts` `requireSession`）。
  - 记录不存在时 hostd 抛 `unknown hostd session`，网关把会话标为 `lost` 并把原始错误原样抛给浏览器；浏览器的"重开"按钮又走 `session.attach`，形成死循环。
- 原因: 网关只有"重新附着已有 hold"的路径，没有"hostd 记录丢失时用同一 sessionId 重建 hold"的路径。hostd 的 `session.start` 本身接受网关指定的 `sessionId`，且对已存在记录幂等，可直接复用。
- 代码流程: 浏览器 `session.attach` → 网关 `attachSession` → hostd `attachSession` → `sessions.get(id)` 为空 → 抛错 → 网关标 lost → UI 展示原始错误。

## 修复方案
- 修改文件: `packages/dsh-gateway/src/index.ts`
  - 新增 `isMissingHostdSession` 判定与 `attachOrRecreateHold` 辅助：显式重开（`session.attach` RPC）、强制重启（`session.restart`）以及发消息时的自动复活路径，若 hostd 回复 `unknown hostd session`，改用 `session.start`（同一 `sessionId`、原 `backend`、项目 `cwd`）重建 hold，跳过 generation 比对，按 `reopened` 处理并写入状态记录"远程主机上已没有该会话的记录，已在当前会话上重新创建 Agent 进程…"。
  - 后台 follow 触发的 `ensureFollowedBinding` 不重建（避免用户未操作时批量拉起 Agent 进程），只把错误改写为可操作提示"远程主机上已没有该会话的记录…可以点「在当前会话重开」…"。
  - `markPromptUndelivered` 把该错误视为 hold 已死，会话标 lost 并给出重开提示。
- 测试: `packages/dsh-gateway/tests/gateway.spec.ts` 新增 3 个用例（重开重建、发消息重建并投递、重建失败时的提示文案）。

## 验证步骤
1. ✅ 复现：hostd 日志中 `session.attach ... error=unknown hostd session a04bb345-…` 持续出现。
2. ✅ 应用修复，`npm run typecheck`、`npm test`（31 文件 / 382 用例）全部通过。
3. ✅ 真实请求：`npm run build` 后重启 3081 web，向 `/remote-agent/control` 发 `session.attach`，网关日志出现 `hostd has no record of session=…; recreating hold`，hostd 执行 `session.start` 成功，会话回到 `channelState=open / turnState=idle`，对话记录追加了重建提示。

## 相关测试
- gateway.spec.ts: recreates the hold under the same session id when hostd no longer knows it and the browser reopens
- gateway.spec.ts: recreates a hold hostd forgot and still delivers the prompt in place
- gateway.spec.ts: explains a missing hostd record with a reopen hint when recreation itself fails

## 设计建议
- 本地 dev hostd 的 `--data-dir` 不应放在 `/tmp`（macOS 重启即清空）；建议默认改到 `~/.local/share/threadharbor-dev` 之类的持久目录。
- hostd 的 `inventory` 已返回 `hostId`（来自 data-dir 下的 `host-id`），网关可在 hostId 变化时一次性把该主机所有会话标为 lost 并提示，而不是等每个会话被点开时才发现。
