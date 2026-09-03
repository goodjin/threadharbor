# Bug Fix: 主机离线时底部直接显示 fetch failed

## 问题描述
- 日期: 2026-09-01
- 严重程度: Medium
- 影响范围: 侧栏主机离线状态、主机设置

hostd 不可达时，侧栏主机块底部直接打出 `fetch failed`。没有连接入口；失败原因也不该在未尝试前就当错误条展示。主机与主机之间也需要更明显的间隔。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts` `refreshHostInventory`
  - `packages/dsh-client/src/client/RemoteSidebar.tsx`
- 原因: `callHostd` 对死掉的 hostd 会得到 Node/undici 的 `fetch failed`，被原样写入 `inventoryError` 并渲染在主机块底部。离线没有「先连接、失败再说明原因」的交互。

## 修复方案
- 离线只显示「连接」按钮，不再默认渲染原始错误。
- 点击后 `reconnectHost` 再探测；仍失败才展示可读原因（`fetch failed` 翻译成无法连接 hostd）。
- 主机设置同样提供连接按钮。
- 相邻主机增加间距和分隔线。

## 验证步骤
1. ✅ `npx tsc -b tsconfig.json`
2. ✅ `npx vitest run packages/dsh-client/tests packages/dsh-gateway/tests`
3. ⚠️ 需硬刷新 3081；未在浏览器点击验证

## 相关测试
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-client/tests/client-artifact.spec.ts`
