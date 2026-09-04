# Bug Fix: e96828cb 构建打包重启做到一半无响应

## 问题描述
- 日期: 2026-09-04
- 严重程度: High
- 影响范围: 3080 Claude 会话 `e96828cb-8966-412a-9503-3b7176cfc695`
- 用户发送「构建打包重启一下」，执行到一半界面不再更新。

## 现场证据
- catalog：`turnState=running`，`lastSeq=1024`，最后一条用户消息 seq 298「构建打包重启一下」（06:31:26）。
- 最后投影 06:38:10–12：assistant 说新 hostd 还没接管 detached hold-worker，随后一次 Terminal `grep revive|recoverHold|...`，tool-result 已写回。
- hold `9b0565b3-0d6c-43eb-a2a8-ead1b5f8f424`：`state.json` pid 10882、Claude pid 10906，**两个进程都不在**。socket `/tmp/th-501/h-9b0565b3-….sock` 是 stale 文件。
- journal 停在 seq 1024（06:38:02）`tool_call_update`，之后没有 `prompt_complete`。
- 到 07:19 UTC 已空等约 41 分钟。3080 日志最后的 push drop 停在 fromSeq=687，之后没有新投影。

## 根因分析
与 `a990f321` / `docs/bugfix/2026-09-04-running-turn-dead-hold.md` 同一条路径：

1. 本轮做到一半时 hold worker 和 Claude ACP 退出（时间点紧挨本机 hostd 重启；任务本身就是「打包构建重启」）。
2. hostd 还在（`127.0.0.1:62846`），但 `wait-page` 对死 socket 默默停 waiter，不发 `journal.gap`。
3. 旧 gateway 对 `running` 只等 live push，不再探测 hold。会话永远 running。

「构建打包重启」在会话里重启 hostd，会让当前 hold 变成孤儿或直接被杀掉，把这个问题放大了。

## 修复方案
沿用 `2026-09-04-running-turn-dead-hold.md`：

- hostd waiter 在 hold socket 死亡时推 `journal.gap`
- gateway 对 running 轮次在 poll tick 上 catchup；hold 不可达则 `concludeTurn(failed, reconnecting)`

本会话中未完成的「构建打包重启」没有被模型做完。重开后需要再发一次。

## 验证步骤
1. ✅ 现场：pid 10882/10906 不存在，journal 停在 tool_call_update
2. ✅ 覆盖测试见 `running-turn-dead-hold` 文档
3. ⚠️ 3080 加载该 gateway/hostd 后，该会话应在数秒内变成可重连，而不是继续显示运行中

## 相关测试
- `packages/hostd/tests/hostd-ws.spec.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
