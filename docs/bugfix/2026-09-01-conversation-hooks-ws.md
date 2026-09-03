# Bug Fix: 点开会话触发 React #310，WebSocket 连不上

## 问题描述
- 日期: 2026-09-01
- 严重程度: Critical
- 影响范围: 3080/3081 会话主区

控制台：

```text
Error: Minified React error #310  (Rendered more hooks than during the previous render)
slot entry crashed in 'conversation'
WebSocket connection to 'ws://127.0.0.1:3080/remote-agent/ws' failed
```

会话点开后主区崩溃。

## 根因分析
- `RemoteConversation` 把自动批准的 `useEffect` 放在 `if (snapshot.panel)` / draft / 空会话 的提前 return 之后。
- 从欢迎页或草稿切到已有会话时，本次渲染多调了一个 hook，React 抛 #310，conversation slot 卸掉。
- `ws://127.0.0.1:3080/remote-agent/ws` 失败是因为 3080 进程仍是改造前的 gateway，没有 upgrade 处理。浏览器会回退 HTTP；真正让会话打不开的是 React 崩溃。

## 修复方案
- 把自动批准 `useEffect` 挪到所有提前 return 之前，空会话路径直接 return。
- WebSocket upgrade 按 path 匹配，忽略 query。
- 增加源码测试：`RemoteConversation` 在 `snapshot.panel` 提前 return 之后不得再调用 hook。

## 验证步骤
1. ✅ 源码测试：hook 必须在提前 return 之前
2. ✅ `npx vitest run packages/dsh-client packages/dsh-gateway/tests/ws-broadcaster.spec.ts`
3. ✅ `npm run build`
4. ⚠️ 刷新即可吃到 React 修复。WebSocket 仍需重启 3080/3081 的 gateway 进程

## 相关测试
- `packages/dsh-client/tests/conversation-model.spec.ts`
