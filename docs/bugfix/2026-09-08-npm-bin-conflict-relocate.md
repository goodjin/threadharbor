# Bug Fix: 点部署自动挪开被占用的 npm 全局命令名并完整安装成功

## 问题描述
- 日期: 2026-09-08
- 严重程度: High
- 影响范围: 主机设置里对 codex / claude / grok 点「部署」（SSH 自动部署的远端主机，如 jin@100.96.156.60 的 Mac-mini）

主机上已经装过别的工具占用了 npm 全局 bin 的命令名时，点部署必失败：
- `~/.local/bin/codex` 被无关旧包 `codex-cli`（v0.1.3，“The CLI for codex.js”）占用；
- `~/.local/bin/claude` 被 Claude Code 独立安装版（`~/.local/share/claude/versions/2.1.50`）的链接占用。

`npm install -g @openai/codex@… @agentclientprotocol/codex-acp@…`（以及 claude 对应命令）要往同名路径写自己的 shim，npm 以 EEXIST 中止，codex/claude 连同各自的 ACP 适配器都装不上。库存于是持续显示未安装 /「Claude Code is installed but claude-agent-acp is missing」，用户需要自己 SSH 上去 `mv` 旧文件才能部署。

## 根因分析
- 问题位置: `packages/hostd/src/agent-manager.ts` `install()` / `npmInstallBlocker()`
- 原因: 官方安装命令固定把 `codex`、`claude` 等命令链接进 npm 全局 bin（此主机为 `~/.local/bin`）。之前实现的 EEXIST 预检只做到「给出可操作的报错并拒绝执行」，不会替用户把冲突文件挪开，所以点部署无法一次成功。

## 修复方案
- `installPlan` 变为异步：安装前扫描 npm 全局 bin（`npm prefix -g`/bin）里本次要链接的命令名（`codex`/`codex-acp`、`claude`/`claude-agent-acp`、`grok`），发现被其它包/安装器占用时，在计划里先展示一条 `mv '<原路径>' '<原路径>.threadharbor-backup'` 步骤，再执行官方 npm 命令——确认页明示了会挪走哪个旧文件。
- 已经指向本次要安装的同一 npm 包的链接（此前 hostd 装过的）不算冲突，不会被挪。
- `install()` 执行时对冲突逐个 `renameSync` 让位（可逆、不删除任何文件）；npm 本身失败时把所有挪走的文件放回原位，再抛出真实的 EEXIST/安装错误，不会把主机留在“挪了一半”的状态。
- 安装成功后才刷新 inventory；随后 `codex`/`claude` 与 `codex-acp`/`claude-agent-acp` 都能被探测到，界面不再报缺组件。
- 残余 EEXIST（计划与执行之间冲突才出现）仍翻译成带 `mv '<path>' '<path>.threadharbor-backup'` 提示的错误。

## 验证步骤
1. ✅ `npx vitest run packages/hostd/tests/agent-manager.spec.ts packages/hostd/tests/hostd.spec.ts`
2. ✅ 新增用例：外部包占用 `bin/codex` → 计划先展示 mv 步骤；一次 install 后 npm 运行、`codex` 安装成功、旧文件保留在 `codex.threadharbor-backup`
3. ✅ 新增用例：挪开后 npm 仍失败 → 旧文件放回原位，报错真实
4. ⚠️ 对 Mac-mini（100.96.156.60）在主机设置里重新点 codex / claude 的「部署」→ 计划应含 mv 步骤 → 确认后应完整安装成功，库存变已安装

## 相关测试
- `packages/hostd/tests/agent-manager.spec.ts`
- `packages/hostd/tests/hostd.spec.ts`
