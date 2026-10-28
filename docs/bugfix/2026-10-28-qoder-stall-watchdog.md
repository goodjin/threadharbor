# 2026-10-28 · Qoder 会话被静默看门狗按 120s 杀掉，而它其实刚发出新的模型请求

## 问题描述

用户反馈：桌面版 `local-ai` 工作区的会话（`session-a655a45d-1060-4055-bef5-9768a1d203e9`）
又发生了 ACP 超时，问为什么不是 5 分钟超时，以及这种场景有没有像 Codex 那样查底层
agent 日志、判断是否真超时的方案。

## 现场证据

- 该会话的模型请求实际走 `acp:acp-qoder`（Qoder CLI 外部 agent，临时目录
  `qoder-cli-cn-501/...`），不是 Codex。会话日志 `request/header` 写的是
  `{"provider":"acp:acp-qoder","model":"dfmodel"}`。
- `turn/end` 报 `ACP_STALLED`，文案「外部 agent 静默 120s 无进展……进程处置：已终止」。
  stderr 尾部：`"Method not found": initialized`（`code: -32601`，JSON-RPC 握手上
  抛错）。
- `cordis.patch.yml` 里只有 `acp-codex` 那条 binding 写了 `stallMs: 300000`（5 分钟），
  `acp-qoder` 没写——于是 Qoder 回落到网关默认 `DEFAULT_STALL_MS = 120_000`（2 分钟）。
- 这一轮从开始到被杀总共约 324 秒（5.4 分钟），但看门狗算的是「连续静默」：agent 在前
  约 200 秒一直在干活（装 ollama、拉模型、测速），最后一次工具调用后它在等模型回答，
  静默累计满 120 秒被收。

## 关键发现：进程其实没死，是被误杀的活回合

把 Qoder 自己的会话段日志（`~/.qoder-cn/logs/sessions/<project>/<sessionId>/segments/*.jsonl`）
拉出来对照时间戳，看门狗收场的那一刻（unix 1793183712961 = `2026-10-28T18:35:12.961+08:00`）
Qoder 的日志显示：

- `18:35:12.958` `loop.iteration.finished`（第 13 轮收尾）
- `18:35:13.271` `loop.iteration.started`（第 14 轮开始）
- `18:35:13.272` `model.request.started`（发起第 14 轮模型请求）

也就是说：**看门狗杀掉这个回合时，Qoder 刚刚结束一轮、刚刚发起下一轮模型请求**——
它一直在推进，只是这一轮模型请求本身要思考两分钟，期间不吐任何 ACP 帧。这与 Codex
压缩上下文时「零帧但日志还在跳」是同一类失败，只是 Qoder 从没接过这层日志信号。

## 根因分析

- **为什么不是 5 分钟**：`stallMs` 是按 preset 逐条配的。`acp-codex` 配了 300000，
  `acp-qoder` 没配，回落到默认 120000。Codex 的放宽对 Qoder 完全不生效。
- **为什么会超时**：网关的静默看门狗只看 ACP 帧。Qoder 在大仓里等工具结果落地后等
  模型回答、或压缩上下文时，长时间不吐帧——在外面看与「卡死」一模一样。看门狗本意
  就是兜这种「进程活着但不出帧」，所以它没误判「卡死」，是真卡死了；只是它杀的时候
  只说「静默 120s」，没把「进程已经崩了 / 其实还在等模型」说清楚。
- **为什么没有 Codex 那套日志判断**：`agent-progress.ts` 的 `codexProgressProbe` 只读
  `~/.codex/logs_2.sqlite`，且 `factory.ts` 把它硬绑到 `preset.agent === 'codex'`。
  Qoder 走 `else undefined`，这层信号完全缺席。

## 修复方案

1. **立即止血**：给 `acp-qoder` 也配 `stallMs: 300000`，理由与 Codex 同款——大仓里
   「工具结果落地后等模型回答」的静默经常超过 2 分钟。
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
3. **增强死因可读性**：`fireStall` 的文案新增 `crashNote()`——stderr 尾部含
   `-32xxx` JSON-RPC 错误码或「method not found」字样时，点明「进程疑似已崩溃」，
   而不是只说「静默 Ns」。下次你就能一眼看出是真崩了还是默默等模型。

## 验证

- `npm run typecheck`：通过。
- `npx vitest run packages/dsh-preset-dispatch`：581 passed / 10 skipped。
- 新增测试：`agent-progress.spec.ts` 钉住 qoder 类型分类、噪音边界、分类器契约、
  注入源行为，以及**真走文件系统**的临时 `QODERCN_CONFIG_DIR` 端到端（找会话目录、
  取最新一段、按字节游标增量读、历史行不当进展）；`gateway.spec.ts` 钉住静默收场带
  死因（stderr 含 `-32601` 时文案点明「进程疑似已崩溃」）。

## 顺带记录：Qoder 的日志在哪

- 配置/数据目录：`QODERCN_CONFIG_DIR`（官方无头认证用），本机默认 `~/.qoder-cn`。
- 会话段日志：`<home>/logs/sessions/<project>/<sessionId>/segments/<ts>.jsonl`，
  `<sessionId>` 就是 DSH 会话 id；一段一个文件，按 mtime 取最新那段。行是 JSON，
  带 `ts`（ISO）与 `type`。
- 运行级日志 `<home>/logs/runs/<run>/qodercli.log` 是带 `[stderr]`/`[stdout]` 前缀
  的原始进程输出，不是结构化 JSONL，不适合当进度信号。
