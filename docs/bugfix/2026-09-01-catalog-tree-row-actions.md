# Bug Fix: 设置页平铺、侧栏设置/添加按钮消失、下拉竖排重叠

## 问题描述
- 日期: 2026-09-01
- 严重程度: Medium
- 影响范围: 设置目录、侧栏主机/项目/会话行操作

设置界面把主机、项目、会话分成三个平铺列表，取消隐藏会话后如果主机仍隐藏，侧栏依然看不到。主机和项目行上的设置、添加按钮被收进下拉；下拉文字被挤成竖排并重叠。会话行的下拉按钮看不见。

## 根因分析
- 问题位置:
  - `packages/dsh-client/src/client/RemoteConversation.tsx` CatalogPanel
  - `packages/dsh-client/src/client/RemoteSidebar.tsx`
  - `packages/dsh-client/src/client/RemoteSurface.module.css`
- 原因:
  - 设置页按类型平铺，没有 host → project → session 树，也无法在恢复会话时带上所属主机。
  - 主机设置和添加项目、项目新建会话被放进下拉，行上图标按钮没了。
  - `.treeRowActions button { width: 27px }` 命中下拉菜单项，中文被挤成竖排重叠。
  - 会话菜单按钮包在 `rowMenuAnchor` 里，绝对定位相对的是被 100% 宽会话行挤下去的锚点，而不是会话行本身。

## 修复方案
- 设置页改为主机 → 项目 → 会话树。取消隐藏会话/项目时先恢复所属主机（再恢复项目），保证侧栏能看到。
- 主机行恢复设置、添加项目图标；项目行恢复新建会话图标。下拉只留重命名和隐藏，菜单项单行不换行。
- 会话下拉按钮重新绝对定位到会话行右侧。

## 验证步骤
1. ✅ `npx tsc -b tsconfig.json`
2. ✅ `npx vitest run packages/dsh-client/tests packages/dsh-gateway/tests`
3. ⚠️ 3081 需重建 client 并硬刷新；未在浏览器里点击验证

## 相关测试
- `packages/dsh-client/tests/client-artifact.spec.ts`
