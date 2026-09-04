# Bug Fix: 服务重启时主动关闭 WebSocket，并收紧心跳

## 问题描述
- 日期: 2026-09-04
- 严重程度: Medium
- 影响范围: 浏览器到 gateway 的控制 WebSocket

创建会话时 gateway 上 `sockets=0`。用户期望心跳能很快发现断开并重连；重启服务时应先通知浏览器，而不是等 TCP/`close` 或 90 秒心跳。

## 根因分析
- 心跳是空闲 30 秒才 ping，再等 60 秒无消息才主动断开，半开连接最坏 90 秒。
- 进程重启通常会立刻 `close`，不靠心跳。问题是重连后可能长时间没有新 socket 注册，控制请求若走 HTTP，hold 能建好，推送没人收。
- 重启时没有应用层「我要退出」帧，浏览器只能被动等 `close`。

## 修复方案
- 心跳改为空闲 10 秒 ping，再 10 秒无下行则断开。
- 重连退避改为 200ms 起。
- 等 WS live 的窗口改为 15 秒，重启过程中的控制请求仍走 WS，不回退 HTTP。
- gateway 插件卸载时先发 `{ direction: "closing", reason: "shutdown" }` 再关掉 socket。浏览器收到后把退避清零，马上重连。

## 验证步骤
1. ✅ broadcaster shutdown 给每个 socket 发 closing
2. ✅ 客户端收到 closing 后 200ms 内打开新 socket
3. ⚠️ 3080 发版重启时，已打开的页面应自己重连，不必刷新

## 相关测试
- `packages/dsh-gateway/tests/ws-broadcaster.spec.ts`
- `packages/dsh-client/tests/ws-transport.spec.ts`
