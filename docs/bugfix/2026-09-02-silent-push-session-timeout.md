# Bug Fix: hostd 推送静默后会话一直运行

## 问题描述
- 日期: 2026-09-02
- 严重程度: High
- 影响范围: Web 远程会话状态与输出同步

`Mac-good / jianmo` 的 Claude 会话 `1132a345-123e-4df9-8855-68da21c52e66` 长时间显示运行中，没有继续展示输出，停止操作也无法让页面状态恢复。

## 现场证据
- 用户提示在 2026-09-02 11:13:56 UTC 进入 gateway。
- Claude 在 11:16:19 UTC 已写入 `prompt_complete`，实际执行约 2 分 23 秒。
- hold journal 已到 `seq=80271`，gateway 游标仍停在 `seq=78234`，积压 2037 条原生事件。
- 重启前手工执行一次 `events.read` 会继续推进游标，证明 Agent 和 hold-worker 都没有卡死。

## 根因分析
gateway 首次追平 journal 后订阅 hostd WebSocket。若这条推送连接保持表面存活但不再送达事件，内部等待循环会一直等待队列数据，无法返回外层再次执行 `events.read` 补拉。结果是 Agent 已完成、journal 也完整，但浏览器持续显示运行中。

此前同步任务还依赖浏览器 follower；服务重启时也不会主动恢复持久化的运行中会话，进一步放大了这个问题。

## 修复方案
- 运行中或等待授权的会话即使没有浏览器 follower，也持续同步。
- hostd 推送静默时，每个轮询周期重新执行 journal 补拉，避免永久困在 WebSocket 等待中。
- `session.prompt` 成功进入运行态后立即确保后台同步任务存在。
- gateway 启动时主动恢复持久化的 `running` / `waiting-permission` 会话。
- 会话顶部展示完整 session ID，并提供复制按钮，便于现场排查。

## 验证结果
1. ✅ 新增“hostd 推送静默但 journal 后续有结果”的回归测试。
2. ✅ gateway / WebSocket 定向测试 20/20。
3. ✅ client 定向测试 35/35。
4. ✅ `pnpm exec tsc -b --pretty false`。
5. ✅ `pnpm run build`。
6. ✅ 3081 重启后自动将目标会话追到 `lastSeq=80271`，状态恢复为 `idle`。
7. ✅ 3081 提供的 client.js 与本地构建产物 SHA-256 一致，并包含“会话 ID”界面。

## 相关代码与测试
- `packages/dsh-gateway/src/index.ts`
- `packages/dsh-gateway/tests/gateway.spec.ts`
- `packages/dsh-client/src/client/RemoteConversation.tsx`
- `packages/dsh-client/src/client/RemoteSurface.module.css`
