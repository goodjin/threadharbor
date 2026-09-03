# Bug Fix: WebSocket 改造把多轮 UI 优化从源码里冲掉了

## 问题描述
- 日期: 2026-09-01
- 严重程度: High
- 影响范围: DSH Web 3080/3081 的侧栏、会话主区、主机设置和后台操作

插件加载修复后页面能打开，但界面回到了早期拥挤 sidebar 形态。后续几轮已经落地的优化全部不见了：主区操作面板、会话重命名 Modal、工具调用折叠、后台操作托盘、hostd 升级/重部署等。

## 根因分析
- 这些 UI 优化从未提交，只存在于工作区和 8 月 31 日的本地 release。
- 9 月 1 日的 WebSocket 协议改造重写了 `RemoteSidebar.tsx`、`RemoteConversation.tsx`、`RemoteSurface.module.css`、`store.ts` 和 gateway，把未提交的优化覆盖成了早期实现。
- 随后为修复 `@threadharbor/protocol` 外部化而重新打包，3080/3081 开始提供这份回退过的 `client.js`。
- 最后一份完整优化源码仍可从 Claude 会话 `5a3d2ece` 开始时的 Read 快照，以及 `~/.local/share/threadharbor/releases/0.1.0-local.20260831.1` 的 browser artifact 核对。

## 修复方案
- 从 WebSocket 改造前的源码快照恢复：
  - `RemoteSidebar.tsx`、`RemoteConversation.tsx`、`RemoteSurface.module.css`、`store.ts`
  - protocol 中的 operation / host.update / session.rename|archive / credential 词汇
  - gateway 的对应控制方法和 SSH 部署进度
- 保留 WebSocket 改造：`WsTransport`、gateway `WsBroadcaster`、`session.follow` / `browser.hello`，以及 protocol 内联进 browser bundle。
- 恢复 store/artifact 测试对面板、重命名和操作托盘的断言。

## 验证步骤
1. ✅ `npx tsc -b tsconfig.json`
2. ✅ `npx vitest run packages/dsh-client packages/dsh-gateway/tests packages/protocol`
3. ✅ `npm run build`，`client.js` 约 109kB，不含 `@threadharbor/protocol`
4. ✅ 产物包含：`设置`、`添加项目`、`关闭重命名会话`、`重新部署 hostd`、`后台操作`、`点安装、登录或配置`、`/remote-agent/ws`
5. ✅ 3080/3081 正在服务的 `/plugins/@threadharbor/dsh-client/client.js` 与本地产物 SHA256 一致
6. ⚠️ 浏览器需强制刷新。gateway 进程仍是旧内存镜像时，需要重启 3080/3081 才能让 `operation.start` / `host.update` 等主区操作生效

## 相关测试
- `packages/dsh-client/tests/client-artifact.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`

## 设计建议
- 未提交的 UI 优化会被后续大改覆盖。面板架构和 protocol 词汇应进版本库，不能只留在本地 release。
