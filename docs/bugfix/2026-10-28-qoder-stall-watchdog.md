# 2026-10-28 · Qoder 会话被静默看门狗按 120s 杀掉：两个 120 秒定时器的赛跑，它输在 5 毫秒

> 勘误（同日）：本文初版把静默成因写成「工具结果落地后等模型回答、模型请求要思考
> 两分钟」，并把 stderr 里的 `-32601` 当成了死因。逐块核对 qoder 段日志与 DSH 会话
> 日志的时间戳后修正：那两分钟是**工具在跑**（模型请求期间思考帧照常流）；`-32601`
> 是启动期的无害警告，之后 agent 照常跑了 13 轮。下文已是修正后的版本。

## 问题描述

用户反馈：桌面版 `local-ai` 工作区的会话（`session-a655a45d-1060-4055-bef5-9768a1d203e9`）
又发生了 ACP 超时，问为什么不是 5 分钟超时，以及这种场景有没有像 Codex 那样查底层
agent 日志、判断是否真超时的方案。

## 现场证据

- 该会话的模型请求实际走 `acp:acp-qoder`（Qoder CLI 外部 agent，临时目录
  `qoder-cli-cn-501/...`），不是 Codex。会话日志 `request/header` 写的是
  `{"provider":"acp:acp-qoder","model":"dfmodel"}`。
- `turn/end` 报 `ACP_STALLED`，文案「外部 agent 静默 120s 无进展……进程处置：已终止」。
  stderr 尾部：`"Method not found": initialized`（`code: -32601`）。
- `cordis.patch.yml` 里只有 `acp-codex` 那条 binding 写了 `stallMs: 300000`（5 分钟），
  `acp-qoder` 没写——于是 Qoder 回落到网关默认 `DEFAULT_STALL_MS = 120_000`（2 分钟）。
- 这一轮从开始到被杀总共约 324 秒（5.4 分钟）：前约 200 秒在干活（装 ollama、拉模型、
  测速，13 轮「模型请求 → 工具调用」），最后两分钟静默被收。

## 关键发现：静默的是工具，不是思考；杀它的是两个同时到期的 120 秒定时器

把 Qoder 自己的会话段日志与 DSH 会话日志逐块对齐：

- **模型请求期间思考帧照常流**：DSH 会话日志里 10 个 reasoning 块的开始时刻，全部
  落在段日志的 13 个 `model.request.started → model.response.completed` 窗口内，
  无一例外。思考不是风险窗口。
- **那两分钟静默是工具在跑**：18:33:12.252 `tool.shell.started`（一个 python 并发
  下载测速，总带宽 ~1.5MB/s），qoder 执行工具期间不发任何 ACP 帧。
- **收场时刻的精确顺序**：
  - `18:35:12.956` `tool.shell.finished`（`signal: 15`）——qoder 自己的 Bash 工具
    约 120 秒超时，先把 python 进程终止了；
  - `18:35:12.958` `loop.iteration.finished`（第 13 轮收尾）；
  - `18:35:12.961` 我们的看门狗开火（也是从 18:33:12 起算的 120 秒）——**晚了 5 毫秒**；
  - `18:35:13.271` `loop.iteration.started`（第 14 轮开始）——在看门狗杀掉回合
    **之后** 300 毫秒。

也就是说：这是 qoder 自己的工具超时与我们的静默看门狗**两个 120 秒定时器的赛跑**，
回合本来马上要继续。`-32601 "Method not found": initialized` 是启动期的无害警告
（我方按 ACP 协议发 `initialized` 通知，qoder 不认，记一条日志），它之后照常跑了
13 轮——不是死因，但会一直留在 stderr 尾部（保留 20 行、qoder 平时 stderr 安静）。

## 根因分析

- **为什么不是 5 分钟**：`stallMs` 是按 preset 逐条配的。`acp-codex` 配了 300000，
  `acp-qoder` 没配，回落到默认 120000。Codex 的放宽对 Qoder 完全不生效。
- **为什么会被静默杀掉**：qoder 执行长工具期间不发 ACP 帧，长工具（下载/构建/测试）
  跑过 120 秒就会撞上看门狗——本例里与 qoder 自己的工具超时只差 5 毫秒。看门狗只看
  帧，分不清「工具在跑」和「进程死了」。
- **为什么没有 Codex 那套日志判断**：`agent-progress.ts` 的 `codexProgressProbe` 只读
  `~/.codex/logs_2.sqlite`，且 `factory.ts` 把它硬绑到 `preset.agent === 'codex'`。
  Qoder 走 `else undefined`，这层信号完全缺席。

## 修复方案

1. **立即止血**：给 `acp-qoder` 也配 `stallMs: 300000`——长工具执行不发帧的静默
   常超过 2 分钟；放宽后 qoder 自己的工具超时先解决战斗，回合不死。
2. **治本：把日志探针从「只认 Codex」改成按 agent 分派**。
   - `agent-progress.ts` 新增 `qoderProgressProbe` / `classifyQoderRow`：读
     `<config>/logs/sessions/<project>/<sessionId>/segments/*.jsonl`（按 mtime 取最新
     一段），认 `turn.started` / `loop.iteration.*` / `model.request.started` /
     `model.response.completed` / `tool.*` 这几类为进展，`attachment.*` / `hook.*` /
     `session.phase.*` 这类每轮刷上百行的当噪音。
   - 复用 `createProgressProbe` 的游标与增量读取逻辑（给 `createProgressProbe` 加了
     一个可选的分类器参数，默认仍是 codex 的，向后兼容）。qoder 段日志首次接入时
     游标停在文件末尾，历史行不当作当下进展——与 codex 同一个坑。
   - `factory.ts` 的探针构造从 `preset.agent === 'codex' ? ... : undefined` 改成
     codex / qoder 各自分派。
3. **增强死因可读性，且收紧到不误报**：`fireStall` 的文案新增 `crashNote()`——但只在
   **整轮没有任何 agent 输出**时，且 stderr 含 `-32xxx` / 「method not found」时，
   才点明「疑似进程在启动阶段已崩溃」。理由：JSON-RPC 错误一旦进过 stderr 就一直留在
   尾部（20 行、不清空），qoder 的启动期 `-32601` 警告因此常驻——没有这道门槛，
   几乎每次 qoder 静默都会被误标「崩溃」。实现上把网关的「挂期限」拆成 `rearm()`
   （交付时也调用，不算活动）与 `noteActivity()`（agent 的帧/文字/工具写/日志进展，
   锁存 `sawActivity`），交付时的初始挂钟不再算作 agent 活动。

## 验证

- `npm run typecheck`：通过。
- `npx vitest run packages/dsh-preset-dispatch`：全部通过。
- 新增测试：`agent-progress.spec.ts` 钉住 qoder 类型分类、噪音边界、分类器契约、
  注入源行为，以及**真走文件系统**的临时 `QODERCN_CONFIG_DIR` 端到端（找会话目录、
  取最新一段、按字节游标增量读、历史行不当进展）；`gateway.spec.ts` 两条：整轮零输出
  且 stderr 有 `-32601` 时点明「疑似启动即崩」；**出过帧之后的静默不断言崩溃**
  （尾部证据照列，但不误标死因）。

## 顺带记录

### Qoder 的日志在哪

- 配置/数据目录：`QODERCN_CONFIG_DIR`（官方无头认证用），本机默认 `~/.qoder-cn`。
- 会话段日志：`<home>/logs/sessions/<project>/<sessionId>/segments/<ts>.jsonl`，
  `<sessionId>` 就是 DSH 会话 id；一段一个文件，按 mtime 取最新那段。行是 JSON，
  带 `ts`（ISO）与 `type`。项目持久化文件 `<home>/projects/<project>/<sessionId>.jsonl`
  记完整消息体（含 thinking 块），但按 `model.response.completed` 整批落盘，比实时帧晚。
- 运行级日志 `<home>/logs/runs/<run>/qodercli.log` 是 CLI 自己的文本日志，不含
  ACP 帧，不适合当进度信号。

### 思考过程的显示（2026-10-28 查证）

qoder 的 ACP 在模型请求期间**流式发思考帧**（`agent_thought_chunk`），runner
（`runner.ts` 的 `pushToStream`）转成 reasoning 块，DSH 已实时显示、会话日志也完整
保留——「从日志提取思考补显」没有增量：思考窗口已显示，工具窗口没有思考可提取
（模型没在生成）。
