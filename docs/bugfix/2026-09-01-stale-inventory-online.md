# Bug Fix: 侧栏离线但主机设置显示已连接

## 问题描述
- 日期: 2026-09-01
- 严重程度: High
- 影响范围: 主机侧栏状态、主机设置 hostd 状态、「连接」按钮

「jin 的 Mac mini」侧栏显示离线、连接失败，打开设置却是「hostd 状态：已连接 / 正在运行（0.1.0），与当前版本一致」。

## 根因分析
- 问题位置: `packages/dsh-gateway/src/index.ts` `refreshHostInventory`
- 原因: 探测失败时只写入 `inventoryError`，**保留上一次成功的 inventory**（healthy、版本 0.1.0）。侧栏用 `inventoryError` 显示离线；设置页的「正在运行、版本一致」读的是这份过期 inventory。SSH 隧道进程还活着但已经不转发时，会反复复用这条死隧道，连接一直失败。

## 修复方案
- 探测失败则清掉 inventory，只保留 `inventoryError`。
- SSH 主机失败时先拆掉旧隧道再探一次。
- 设置页只有 `inventoryError` 为空且状态为 deployed 才显示「已连接 / 正在运行」。

## 验证步骤
1. ✅ `npx tsc -b tsconfig.json`
2. ✅ `npx vitest run packages/dsh-client/tests packages/dsh-gateway/tests`
3. ⚠️ 3081 需重启 gateway；请硬刷新后看该主机

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
