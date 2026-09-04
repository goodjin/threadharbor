# Bug Fix: 会话卡住，刷新才看到模型回复

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 3081 正在运行的会话实时输出
- 会话: `a990f321-5d84-481f-b6dc-77296dd00b1e`（DSH / `dev合并一下到test，再合到master`）

发送后用户消息在，助手侧长时间没有新内容。刷新页面后，积压的回复一次性出现。

## 现场证据
- catalog：`channelState=open`、`turnState=running`、`binding.lastSeq=2599`、`nextTranscriptSeq=322`。hostd journal 和 gateway 投影都在往前走。
- 3081 `web.log` 整段都是：
  `transcript push dropped session=a990f321-… reason=no-follower sockets=0 liveFollowers=0 followedBrowsers=1`
- 同一进程里更早的会话 `8b73ba1c-…` 也是同样的 drop，说明当时 gateway 上根本没有浏览器 WebSocket。
- 刷新走 `transcript.read` 从 catalog 拉已投影的条目，所以「一刷新就有了」。

## 根因分析
- 问题位置:
  - `packages/dsh-gateway/src/ws-broadcaster.ts` `handleClientMessage`
  - `packages/dsh-gateway/src/index.ts` `handleFollow` / `handleHello`
  - `packages/dsh-client/src/client/store.ts` `setPhase`
- 原因:
  1. `session.follow` 排在全局 catalog 队列里。`session.prompt` 已经开始投影时，follow 还没把当前 socket 标成 follower，早期 token 全部 drop。
  2. follow handler 还会等 `attachSession` / in-flight start。等它广播 `session.followed` 时，socket 可能已经关掉。随后 `follow()` 把 session 写进 `followedByBrowser`，但 `subscribers` 是空的：`followedBrowsers=1 sockets=0`，之后每一帧都 drop。
  3. `browser.hello` 用 journal `lastSeq` 和客户端的 **transcript seq** 比较，漏记漏推；客户端重连后只 `setPhase('ready')`，不主动 `transcript.read`。漏掉的消息只能靠刷新。

## 修复方案
- WebSocket 收到 `session.follow` 时立刻把该 socket 标成 follower，不等 gateway handler。
- `session.follow` / `session.unfollow` / `browser.hello` 不再进全局队列。
- follow 立刻回放当前 transcript 尾页；hello 按 transcript seq 计算 missed，并把尾页推给该浏览器。
- attach / start 改到 follow 返回之后在后台做。
- 传输层从 reconnecting 回到 live 时，立刻 `catchupTranscript` 当前会话，并唤醒 live 同步循环。

## 验证步骤
1. ✅ `packages/dsh-gateway/tests/ws-broadcaster.spec.ts`：慢 follow handler 返回前，socket 已能收到 transcript
2. ✅ `packages/dsh-gateway/tests/gateway.spec.ts`：无 live socket 投影后再 follow，会回放 `hello` / 助手文本；hello 按 transcript seq 报告 missed 并推尾页
3. ✅ `packages/dsh-client/tests/store.client.spec.ts`：reconnecting → ready 会再发 `transcript.read`
4. ⚠️ 3081 需加载本次 gateway/client 后，打开 `a990f321-…` 或任意运行中会话，新输出应在当前页出现，不必刷新

## 相关测试
- `packages/dsh-gateway/tests/ws-broadcaster.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/tests/store.client.spec.ts`

## 设计建议
- 一条 WS 同时承担控制和推送。follower 集合必须跟活 socket 同步更新，不能只记 browserId。
- 漏推的补偿是 catalog 回放（follow/hello 推尾页 + 客户端 `transcript.read`），不要指望半开连接自己恢复。
