# Bug Fix: SSH 部署后所有 Agent 离线安装不可用

> 历史记录：本文保留当时离线 bundle 方案的事故复盘。当前架构已移除 Agent 离线安装和 `agent-bundle` 部署路径；SSH 部署只上传 ThreadHarbor 自己的 hostd/hold-worker，Agent 由远端管理员安装到通用 `PATH`。

## 问题描述

- 日期: 2026-08-31
- 严重程度: High
- 影响范围: 通过“主机设置 → SSH 自动部署”安装的远端 `threadharbor-hostd`
- 现象: Codex、Grok、Claude Code 和 DSH 的安装计划均不可用；例如 Grok 显示 `offline agent bundle is missing; run the release bundle step and deploy @xai-official/grok@1.0.5 with hostd`。

## 根因分析

- 问题位置: `packages/dsh-gateway/src/ssh-manager.ts`
- release bundle 按平台存放在 `agent-bundle/<os>-<arch>/manifest.json`。
- SSH 部署虽然完整上传了 `agent-bundle/`，却用 `--agent-bundle-dir $release/agent-bundle` 覆盖了 hostd 的默认目录。
- Agent manager 因而在父目录直接查找 `manifest.json`，没有进入远端运行平台子目录，导致每个 Agent 都被判定为缺少离线 bundle。
- `packages/hostd/src/bin.ts` 的默认值已经根据远端 `process.platform` 和 `process.arch` 正确选择平台子目录，因此部署层不应覆盖它。

## 修复方案

- SSH 的 systemd user service 和 detached fallback 均不再传入错误的 `--agent-bundle-dir`。
- hostd 使用自身默认路径，从部署目录选择 `agent-bundle/<remote-os>-<remote-arch>/`。
- 增加 SSH 部署命令回归断言，防止再次把 bundle 父目录传给 hostd。

## 验证步骤

1. ✅ Gateway SSH manager 定向测试 4/4 通过。
2. ✅ TypeScript project references 类型检查通过。
3. ✅ 重新构建制品，hostd 自包含产物与 agent bundle 校验通过。
4. ✅ 启动构建后的真实 hostd 并请求 Grok 安装计划，返回固定版本和 `agent-bundle/darwin-arm64/npm-cache` 离线安装步骤。
5. ✅ 完整测试套件 14 个文件、69 个用例全部通过。
6. 部署时需在主机设置中重新执行 SSH 部署，使远端 service 配置和 hostd 进程使用新参数；刷新 inventory 后安装计划应恢复。

## 相关测试

- `packages/dsh-gateway/tests/ssh-manager.spec.ts`

## 设计建议

- 平台目录解析只保留在 hostd 启动入口，Gateway 只负责原样上传 bundle 根目录，避免本地平台与远端平台产生耦合。
