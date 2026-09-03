# Bug Fix: 3080 部署 Agent 报 operation.start，侧栏隐藏/设置回退，hostd 状态按钮错误

> 历史记录：本文中的“部署 Agent”对应旧的 Agent 安装操作。当前 `operation.start` 只用于 hostd SSH 部署；Agent 安装/升级已经不属于 ThreadHarbor 职责。

## 问题描述
- 日期: 2026-09-01
- 严重程度: High
- 影响范围: 当时的 DSH Web Agent 安装操作、左侧栏主机/项目/会话操作、主机设置中的 hostd 部署按钮

当时安装 Agent 时报 `Web gateway does not implement method operation.start`。侧栏顶部「新建会话」又出现；主机和项目的重命名/隐藏下拉消失；底部设置入口不见；会话下拉点开后无法通过点击空白处收起。主机行和主机设置无法根据 hostd 是否存活、版本是否一致决定显示「部署」还是「升级」，活着且版本一致时仍会露出重新部署按钮。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/index.ts`（进程内方法表）
  - `packages/dsh-client/src/client/RemoteSidebar.tsx`
  - `packages/dsh-client/src/client/RemoteConversation.tsx`
  - `packages/dsh-client/src/client/store.ts`
- 原因:
  - 当时的 Agent 安装走 `operation.start`，但正在服务的 gateway 进程是旧内存镜像，方法表里没有该方法。3080 冻结版 `0.1.0-local.20260831.1` 的 client/gateway 都不含 `operation.start`；3081 工作区 client 已调用该方法，但 3081 进程从周日下午起未重启。
  - 主机/项目隐藏、底部设置目录、点击外部收起菜单从未提交，WebSocket 改造后又被覆盖。`state()` 不过滤 `hiddenAt`，也没有 `hidden.list` / `host.hide` 等方法。
  - `hostDeployment()` 只要拿到 inventory 且版本字符串相同就当作已部署，不看 `healthy`；主机设置在 SSH 连接匹配时无条件渲染「重新部署 hostd」。

## 修复方案
- 恢复隐藏架构：`hiddenAt`、`host/project.hide|unhide|delete`、`project.rename`、`session.unarchive|delete`、`hidden.list`。
- `state()` 省略隐藏主机/项目和归档会话；设置面板合并可见项与 `hidden.list`，支持取消隐藏和删除。
- 侧栏去掉顶部新建会话按钮；主机/项目/会话使用带 `useDismissOnOutsidePointer` 的下拉；底部保留添加主机 + 设置。
- `hostDeployment` 以 `healthy` 判断存活，版本不一致为 outdated。主机行显示状态徽章；主机设置在存活且版本一致时不显示部署按钮，离线显示「部署 hostd」，落后显示「升级 hostd」。

## 验证步骤
1. ✅ `npx tsc -b tsconfig.json`
2. ✅ `npx vitest run packages/dsh-client/tests packages/dsh-gateway/tests`（52 passed）
3. ✅ 重建 `packages/dsh-client/lib/client.js`，产物含 `取消隐藏`、`升级 hostd`、`部署 hostd`，不含 `重新部署 hostd`
4. ⚠️ 3081 需要重启才能让新的 gateway 方法表生效；3080 仍钉在冻结 release，需新 candidate + promote 才会带上这些改动

## 相关测试
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-client/tests/client-artifact.spec.ts`

## 设计建议
- 浏览器 client 与 in-process gateway 必须一起重启；只热更 client.js 会把新方法打到旧 gateway 上。
- 3080/3081 隔离后，未发版的 UI 优化只存在于 3081。产品面要回到 3080 必须走发版脚本。
