# Bug Fix: 打开主机设置弹出 Codex「来自互联网」确认框且显示未登录

## 问题描述
- 日期: 2026-09-03
- 严重程度: Medium
- 影响范围: 主机设置的 Agent 库存（尤其是本机 Homebrew Cask 安装的 Codex）

每次打开主机设置都会弹出 macOS「是否打开 Codex / 来自互联网」确认框。界面上 Codex 显示未登录，但本机 `codex login status` 和 `~/.codex/auth.json` 都表明已经用 ChatGPT 登录。

## 根因分析
- 问题位置: `packages/hostd/src/agent-manager.ts` `inventory()`
- 原因: 打开主机设置会调用 `refreshInventory`，hostd 对已安装的 Codex 执行 `codex login status`。本机 PATH 上的 `/opt/homebrew/bin/codex` 是 Homebrew Cask 的 Mach-O，带 `com.apple.quarantine`。spawn 这个二进制会触发 Gatekeeper。用户取消、对话框阻塞或超时后，`check()` 返回 false，于是 `authenticated` 为 false。
- 代码流程: AgentSetupPanel / 主机设置 → gateway `inventory` → hostd `codex login status` → Gatekeeper → 忽略已有的 `~/.codex/auth.json`。
- 本机 Codex 登录实际写在 `${CODEX_HOME:-~/.codex}/auth.json`（`auth_mode: chatgpt` + `tokens`），npm 版 `~/.local/bin/codex login status` 也能正确报告已登录。

## 修复方案
- 库存不再启动 Codex / Grok CLI。
- Codex 已登录：`CODEX_API_KEY` / `OPENAI_API_KEY`，或 `auth.json` 中的 API key / access_token / refresh_token。
- Grok 已登录：`${GROK_HOME:-~/.grok}/auth.json` 中存在 `refresh_token` 或 `key`。
- 交互式「登录」按钮仍会启动 `codex login --device-auth`，不受影响。

## 验证步骤
1. ✅ `packages/hostd/tests/agent-manager.spec.ts`：有 auth.json / `CODEX_API_KEY` 时 `authenticated: true`，且不会 spawn CLI
2. ✅ `packages/hostd/tests/hostd.spec.ts`：inventory RPC 同样不启动 CLI
3. ✅ 重启本机 hostd（`127.0.0.1:62846`）后 `inventory` 返回 Codex `installed: true, authenticated: true`，且不再执行 `codex login status`

## 相关测试
- `packages/hostd/tests/agent-manager.spec.ts`
- `packages/hostd/tests/hostd.spec.ts`

## 设计建议
- 库存探测必须是无 GUI、无网络副作用的。Gatekeeper / keychain prompt 不能出现在「打开设置」路径上。
- 本机若同时有 Homebrew Cask 与 npm 的 `codex`，PATH 上的 Cask 二进制仍可能在真正启动会话时弹窗；那是会话启动问题，不是库存问题。需要时可对 Cask 二进制执行 `xattr -d com.apple.quarantine`。
