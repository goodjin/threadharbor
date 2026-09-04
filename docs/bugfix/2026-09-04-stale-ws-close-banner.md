# Bug Fix: 仍有输出时页面提示通道断开，刷新才恢复

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 浏览器到 gateway 的单条 WebSocket

会话看起来正常，过一会儿提示通道断开，后台可能仍在出字。刷新后展示恢复。

## 根因分析
- `close` 监听器不区分当前 socket 和上一根已替换的 socket。
- 重连时 `scheduleReconnect` 只把 `this.socket` 置空，不忽略旧连接的延迟 `close`。
- 新连接已经 `live` 并继续收 push 之后，旧 socket 的 `close` 再次进入 `scheduleReconnect`：相位被打回 `reconnecting`，横幅显示断开，旧/新连接的 message 回调仍可能在推 transcript。
- 刷新会丢掉整棵监听器，所以看起来“刷新才好”。

## 修复方案
- `open` / `message` / `close` / 心跳只作用于当前 `this.socket`。
- 当前 socket 上只要还有帧，相位拉回 `live`。

## 验证步骤
1. ✅ 新连接 live 之后，旧 socket 再 close，相位保持 live
2. ✅ 当前 socket 收到 push 时，即便相位是 reconnecting 也回到 live
