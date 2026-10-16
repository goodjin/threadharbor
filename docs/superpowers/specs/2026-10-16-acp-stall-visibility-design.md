# 外部 agent 卡死的三件事：立停、静默超时、运行可见性（设计）

- 日期：2026-10-16
- 状态：已定方向（四个决策均已用户拍板，见「决策」）
- 前置：`docs/superpowers/specs/2026-10-14-inplace-model-gateway-design.md`（网关的由来）；
  `docs/agent-acp/README.md`（帧表与投影规则）

## 事故（为什么现在做）

2026-10-16 晚间的真机事故，链路完整、证据在案：

- **网络**：本机经代理（127.0.0.1:7897）与直连到 `chatgpt.com` / `api.openai.com`
  的 TLS 握手全部中断；同一代理访问 baidu（200）、`api.anthropic.com`（403，握手成功），
  即代理与基础网络正常，是到 OpenAI 一组目的地的路径被掐。
- **session-423817a9（codex / gpt-6-astra）**：21:07:31 发出提问后 codex 在后端重试，
  底层进程零网络连接、无视 `session/cancel`，回合挂满 600 秒由网关期限收场
  （ACP_TIMEOUT）。用户按停止，界面上无任何可见效果。
- 实例重启后 21:21:27 的「继续」回合**复现**：又是整 600 秒（seq 98–101）。
- **超时后死循环**：网关只对 ACP_CONNECTION 丢弃缓存会话，ACP_TIMEOUT 保留——
  下一回合复用卡死进程，再挂 600 秒一轮，用户只能反复重启实例
  （实例日志一夜五次启动，含一次端口占用）。
- **信息丢失**：codex 的重试警告（`tls handshake eof` 等）一直在 stderr 流，但只进
  实例终端日志；transport 层虽留有 20 行尾巴，却只在进程死亡时当「遗言」拼进消息，
  超时与停止路径都不带它，更不进会话。

## 决策（已拍板）

1. **停止语义**：本地立即收场；通知对方取消后 3 秒宽限，未消停即杀进程；
   下一回合自动重开新外部会话（历史重放机制已有）。
2. **超时**：静默超时（默认 120 秒）+ 总上限（默认 30 分钟）双层。
3. **展示**：静默 30 秒写一条系统提示（一次即止）；三种强制收场的错误消息统一带
   诊断包。自动刷新的状态行 / 实时日志面板为二期（需动 web 前端）。
4. **范围**：四家 ACP agent（grok / claude / codex / cursor）通用；zcode 不走 ACP，不涉及。

## 机制

### 1. 活动信标（dsh-acp-agent 传输层，四家通用）

- 传输层记录 `lastActivityAt`：stdout 每到一帧、stderr 每出一行，都算一次打点。
- stderr 环形缓冲（现有 20 行）从「遗言专用」升级为随时可读。
- 对外新增：`lastActivityAt()` 与 `stderrTail()`；`onDeath` 语义不变。
- Stdio 与 WebSocket（含 GrokServe）两类传输都实现同一信标接口；
  帧到达即打点，stderr 按各自诊断管道取行。

### 2. 网关统一收场（gateway.ts）

三条路径同一机制——**立刻 resolve 应答承诺，再善后**：

| 触发 | 行为 |
|---|---|
| 用户停止 | `end=aborted` 立即收场；`session/cancel` 照发（运行器现有 watchStop 不变）；起宽限计时（默认 3 秒），`run()` 未了结即 `close()` 杀进程 + 丢弃条目 |
| 静默超时 | 打点重置计时；静默 ≥ stallMs（默认 120 秒）→ `end=error` `ACP_STALLED` 带诊断包 → 杀进程 + 丢弃条目 |
| 总上限 | 现有 600 秒默认迁移为可配 totalMs（默认 30 分钟；0=不限）→ `end=error` `ACP_TIMEOUT` 带诊断包 → 杀进程 + 丢弃条目 |

- **丢弃条件修正**：从「仅 ACP_CONNECTION」扩为四种强制收场统一
  「丢弃条目 + 杀进程 + 下一请求重开（primer 重放）」。静默到这份上的进程不值得保留。
- 强制收场后 `run()` 仍在后台漂浮：现有 `run.catch(() => {})` 兜底；
  杀进程触发 transport 死亡令其自然 reject；旧运行器中止后的帧丢弃逻辑防晚到帧。

### 3. 状态提示与诊断包

- **提示**：静默 ≥ warnMs（默认 30 秒）时经回合中途写入通道（`turn.write`，
  同工具卡片路径）写一条系统事件，**一次即止**。文本含静默秒数与 stderr 最后一行
  （截断）。界面零改动：系统事件走现有投影。
- **诊断包**：三种强制收场的 `error.message` 统一格式——静默时长、最后活动距今、
  stderr 尾巴（≤5 行）、进程处置结果（自行退出 / 已杀 / 宽限内了结）。
  「为什么停」在会话记录里自解释，不再依赖实例终端日志。

### 4. 配置

- preset 行可逐项覆盖：`stallMs` / `totalMs` / `warnMs` / `graceMs`；
  `0` 表示关闭对应行为（`totalMs` 0 = 不限，沿用现有语义）。
- 现有 `answerTimeoutMs` 概念迁移为 `totalMs`，不留双轨。
- 默认值：stall 120 000、total 1 800 000、warn 30 000、grace 3 000。
- 约束：`warnMs` ≥ `stallMs` 时提示不再单独计时（静默路径先触发，提示随之作废），
  不报错、不截断配置。

### 5. 善后与并发

- 丢弃条目 = `entries.delete` + `session.close()`（杀子进程，复用现有 close）；
  下一请求走 `factory.open` 重开并重放历史，均已有机制，不新增语义。
- 同会话「至多一个进行中提示」的现有并发约束不变。

## 测试

- **单测**（假传输层驱动）：帧与 stderr 行各自重置静默计时；三种收场的行为与错误码；
  宽限杀计时与条目丢弃；诊断包字段齐全；提示一次即止；`totalMs=0` 不限；
  preset 行覆盖生效。
- **活测**（`THREADHARBOR_LIVE_ACP`）：新增「后端不可达」用例——代理指向死端口
  制造握手失败，断言 ACP_STALLED 收场、诊断包含 `tls` 字样。
- **回归**：现有 gateway / runner / transport 测试全绿。

## 不做（本轮非目标）

- 自动刷新状态行、实时 agent 日志面板（二期，需 web 前端改动）。
- 修改 DSH 宿主本身。
- zcode 路径。
- 干预 agent 自身的重试策略（codex 何时放弃重试是它自己的事）。

## 证据索引

- 会话转录：`~/.dsh-threadharbor-test/sessions/--Users-good-qg-nexa-service--/session-423817a9-cdf8-41d8-94fe-3c51517d2998/session.v4.jsonl.zstd`
  （seq 89–91：600.0 秒后 aborted/user；seq 98–101：600.05 秒后 ACP_TIMEOUT）
- 实例日志：`/private/tmp/dsh-3081.log`（`answer timed out after 600000ms` ×2；
  一夜五次启动、一次 EADDRINUSE）
- 代码（2026-10-16 checkout）：`packages/dsh-preset-dispatch/src/gateway.ts:349-419`
  （中止转发、期限、丢弃条件）、`runner.ts:645-665`（watchStop）、
  `packages/dsh-acp-agent/src/transport.ts:63-111`（stderrTail）、
  `factory.ts:94-119`（死亡扇出）、`registry.ts:198-236`（能力表与 onDead 丢弃）
- 诊断案卷：`~/.superpowers/diagnosing-superpowers/session-423817a9-cdf8-41d8-94fe-3c51517d2998/case.md`
