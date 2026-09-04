# Bug Fix: 已连接待升级但没有升级按钮

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 主机设置里 `hostd 状态` 卡片、本机 loopback 主机（Mac-good）

状态文案已经是「已连接，待升级」，卡片里没有「升级 hostd」按钮。

## 根因分析
- 问题位置: `packages/dsh-client/src/client/RemoteConversation.tsx` `HostPanel`
- 原因: 「升级 hostd」只画在 SSH 自动部署分支。`Mac-good` 是 `http://127.0.0.1:62846` 的已有地址，没有 SSH，走 endpoint 分支，只显示状态和离线时的「连接」。

## 修复方案
- endpoint 和 SSH 两种连接方式在 outdated 时都显示「升级 hostd」。
- SSH 主机继续走自动部署；本机 loopback 主机用当前制品重启正在监听的 `threadharbor-hostd` 进程（核对 cmdline，避免误杀 SSH 隧道）。
- 待升级时默认展开连接区；侧栏「升级」徽章点进去打开主机设置。

## 验证步骤
1. ✅ `canUpgradeHostd` 对本机 outdated 为 true
2. ✅ 无监听端口时 `host.upgrade` 明确报找不到进程
3. ✅ 产物包含「升级会用当前制品重启本机进程」
4. ⚠️ 刷新 3080，打开 Mac-good 主机设置，应能看到并点「升级 hostd」

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-gateway/tests/local-hostd.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/client-artifact.spec.ts`
