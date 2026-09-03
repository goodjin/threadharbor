# Bug Fix: 部署 DSH 报 hostd does not implement method agent.install.plan

## 问题描述
- 日期: 2026-09-03
- 严重程度: High
- 影响范围: 主机设置里对未安装 Agent 点「部署」

3081 新 UI 点部署 DSH 后报 `Error: hostd does not implement method agent.install.plan`。

## 根因分析
- 问题位置: 本机 `threadharbor-hostd` 进程（`127.0.0.1:62846`，PID 66301）
- 原因: Web gateway/client 已包含 `agent.install.plan`，但本机 hostd 是当天下午 2:26 用旧 `bin.js` 拉起的，方法表里没有 Agent 部署 RPC。hostdVersion 固定为 `0.1.0`，和 gateway 制品版本相同，UI 不会提示升级 hostd。

## 修复方案
- 用当前 `packages/hostd/lib/bin.js` 重启同一 data-dir/port 的 hostd，让方法表带上 `agent.install.plan` / `agent.install`。
- 客户端把该错误翻译成：先升级 hostd 再部署 Agent。

## 验证步骤
1. ✅ 定向测试 `describeAgentInstallFailure`
2. ⚠️ 重启本机 hostd 后，在 3081 再点 DSH 部署，应返回安装计划而不是 unknown method

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`
