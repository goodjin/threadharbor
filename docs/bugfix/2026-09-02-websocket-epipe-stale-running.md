# Bug Fix: 3081 会话残留运行中且停止无响应

## 问题描述

- 日期: 2026-09-02
- 严重程度: High
- 影响范围: test 通道 3081、浏览器 WebSocket 推送、会话停止操作

部分会话长期显示“运行中”，没有新的 Agent 输出；点击“停止”也没有响应。

## 根因分析

- `~/.dsh-threadharbor-test/threadharbor-runtime/web.log` 记录了未处理的 `write EPIPE`。浏览器 WebSocket 在状态检查与实际写入之间断开时，`WsBroadcaster` 没有监听 socket 的 `error` 事件，Node.js 因未处理的 EventEmitter error 终止整个 Web 进程。
- Web 进程退出后，catalog 保留最后一次持久化的 `turnState: running`；旧浏览器页面也保留该状态，但停止请求已经没有服务端接收。
- `session.cancel` 原先只向 hostd 转发原生取消帧。即使 hostd 接受取消，如果 Agent 没有再发完成事件，Gateway 仍会永久保留 `running`。
- 上一次 3081 由手工 launchd 命令启动，未设置 test 通道的隔离 `DSH_HOME`，导致 3081 加载了默认 `~/.dsh` catalog，而不是 `~/.dsh-threadharbor-test`。

## 修复方案

- `packages/dsh-gateway/src/ws-broadcaster.ts`
  - 监听浏览器 WebSocket 的 `error`，将异常限制在单个连接内。
  - 所有发送统一走安全发送函数；同步抛错或异步发送回调报错时清理坏连接。
  - 连接关闭或报错后清理订阅，避免已经离线的浏览器继续维持 journal follow loop。
- `packages/dsh-gateway/src/index.ts`
  - hostd 接受 `session.cancel` 后立即把仍为 `running` / `waiting-permission` 的会话持久化为 `idle` 并推送视图更新。
  - 停止请求失败时把未知结果收敛为 `failed`，并把打开的通道标记为 `reconnecting`，不再永久展示为确定的“运行中”。
- 使用 `scripts/release-channel.mjs start --channel test` 重启 3081，恢复 test 通道独立数据目录和 PID 管理。

## 验证步骤

1. ✅ `pnpm exec tsc -b --pretty false`
2. ✅ Gateway / WebSocket 定向回归测试 19/19
3. ✅ `pnpm run build`，构建和制品校验通过
4. ✅ 真实连接 3081 WebSocket 后强制 `terminate()`；服务 PID 2708 保持不变，无新增 EPIPE
5. ✅ `GET http://127.0.0.1:3081/` 返回 HTTP 200
6. ✅ 3081 `state` 返回零条 `turnState: running` 会话
7. ✅ 3081 提供的 `client.js` 与本地构建 SHA-256 一致：`b42ed4400d4cf523cab0233854a117cee91ee38a0f7f92d945811ffc2222de4a`

完整测试套件为 111/116 通过；5 个既有失败分别属于 dirty-worktree 发版测试（3）、登录 worker 异步时序（1）和过长 Unix socket 测试路径（1），不经过本次修改的代码路径。

## 相关测试

- `packages/dsh-gateway/tests/ws-broadcaster.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
