# Bug Fix: DSH 安装入口永远不可用

> 历史记录：本文描述的是已经废弃的 Agent 安装方案。当前架构不再提供 `agent.install` / `agent.install.plan`，也不随 ThreadHarbor 打包或安装 DSH runtime；远端管理员按官方方式安装 `dsh-jsonrpc-agent`，ThreadHarbor 只负责发现、凭据状态和会话管理。

## 问题描述

- 日期: 2026-08-29
- 严重程度: High
- 影响范围: 主机 Agent 管理中的 DeepSeek Harness 安装与会话能力

界面能打开“安装 dsh”，但安装计划固定显示 `managed by the DeepSeek Harness installation` 和 `Install or update DeepSeek Harness from its own distribution.`，没有任何可确认的安装步骤。

## 根因分析

- 问题位置: `packages/hostd/src/agent-manager.ts`
- 原因: `dsh` 分支被实现为永久 `unavailableReason` 占位；release agent bundle 也只准备 npm Agent，没有携带 hostd 实际需要的 `dsh-jsonrpc-agent`。
- 代码流程: 页面请求固定 backend 的计划，hostd 对 DSH 始终返回空 steps，因此确认安装必然被拒绝。

## 修复方案

- 固定官方预发布 `deepseek-harness-runtime-bin==0.1.1rc1` 及三个已发布平台 wheel 的 SHA256。
- bundle 构建阶段验证 wheel 后提取 runtime、ripgrep sidecar、macOS spawn helper、默认配置和许可证，并继续纳入 manifest 全文件哈希。
- hostd 在确认安装前校验完整 bundle，把运行时整目录暂存后切换到版本目录，设置 executable `0700`、配置与许可证 `0600`。
- 默认 command/config 跟随 `--install-prefix`；不支持的平台和 libc 返回明确不可用原因。
- 浏览器协议保持不变，只能提交 `backend: dsh` 与 `confirm: true`。

## 验证步骤

1. 针对性单元测试覆盖 DSH 计划、哈希校验、runtime/sidecar/config 安装和权限：通过。
2. 生成 `darwin-arm64` 真实 bundle；官方 wheel 固定 SHA256 校验通过，manifest 列出 552 个文件和 6 个 DSH 文件。
3. 通过 `127.0.0.1:3081` 的 Web 控制接口执行真实 `agent.install.plan`：返回 `deepseek-harness-runtime-bin==0.1.1rc1` 与非空步骤。
4. 通过同一接口执行 `agent.install`：返回 `alreadyInstalled: true`；inventory 随后返回 DSH `installed: true`。
5. 安装目录为 `~/.local/share/threadharbor/dsh/0.1.1rc1`；arm64 可执行文件权限为 `0700`，配置和许可证权限为 `0600`。
6. `npm run check` 通过：13 个测试文件、41 个测试、类型检查与构建全部通过。

当前验收环境没有 `DEEPSEEK_API_KEY`，因此 inventory 的 `authenticated` 保持 `false`；这是安装完成后的凭据配置状态，不是安装失败。

## 设计建议

DSH runtime 当前仍是官方预发布制品，升级时必须同时更新固定版本、三个 wheel SHA256、平台门禁和真实 JSON-RPC smoke，不能只替换版本字符串。
