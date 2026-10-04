# Bug Fix: 新建会话第一句话报「could not reopen session … session is already active」，且失败后永久停在「正在生成回复」

## 问题描述
- 日期: 2026-09-29
- 严重程度: High（新建会话首条消息即提交失败；失败后界面永久卡在「正在生成回复 / Agent 已开始返回内容」）
- 影响范围: 先换模型（`session/set_model` 等带 `sessionId` 的外发帧）再发第一句话的会话；报错文案
  「agent dsh could not reopen session …；它的历史可能已经不在了，请新建会话」出现在消息下方。
- 现象: 新建会话 → 切换模型 → 发第一条消息 → 「消息提交失败：agent dsh could not reopen session
  b5545b23…: … session is already active: b5545b23…；它的历史可能已经不在了，请新建会话」，
  之后会话一直显示「正在生成回复 / Agent 已开始返回内容」，再发消息也不恢复。

## 现场证据
- 测试通道 hostd hold journal（`~/.local/state/threadharbor/test/hostd/holds/c584d1dc-…/journal.jsonl`）：
  1. `session/new` 成功返回 `b5545b23-…`（02:36:28）；
  2. `gateway-rpc-65ac8600` 模型切换成功（mimo → GLM-5.3，02:36:52）；
  3. 34 秒后 `session/resume` 被同一个 Agent 拒绝：`Invalid params: session is already active: b5545b23-…`
     （02:37:26）——同一个 dsh ACP 进程（`backendPid: 50159`）58 秒前刚建好这个会话。
- 同一时刻 `~/.dsh-threadharbor-test/threadharbor-runtime/web.log` 是完整三连：
  `session.start` ok → `session.configure` ok → `session.prompt` 失败并带同样的报错；
  02:56 的第二个新会话（`9a29dc8a-…`）逐毫秒复刻了同一序列。
- 失败后 hostd `sessions.json` 里该会话的 `nativeSessionId` 已被失败分支抹掉；
  网关 `remote_agent.json` 里两行却都停在 `turnState: "running"`（updatedAt 还在随轮询前进），
  而 transcript 里躺着「消息提交失败：…」状态行——状态与事实互相矛盾，就是卡死的横幅。
- dsh 侧会话文件（`~/.dsh/sessions/…/b5545b23-…/session.v3.jsonl.zstd`）只有初始化记录，
  说明会话一直活着、只是从未收到那条消息，「历史可能已经不在了」是误判。

## 根因分析
- 问题位置: `packages/hostd/src/agent-bridge.ts` `rememberNativeSession` + `packages/hostd/src/agent-session.ts`
  `setNativeSessionId`；`packages/hostd/src/server.ts` `bindNativeSession` 的失败分支；
  `packages/dsh-gateway/src/index.ts` `markPromptUndelivered`。
- 原因（三层叠加）:
  1. **误判没绑定（触发条件）**: 每个写出的请求帧只要带 `params.sessionId`，`writeFrame` 就调
     `rememberNativeSession` → `setNativeSessionId`，后者无条件把 `nativeBound` 重置为 false——
     即使 id 完全没变。于是换模型这类帧之后，槽位看起来像「没绑定」，其实 Agent 一直持有该会话。
  2. **把「already active」当死讯（严重性）**: 下一条 prompt 的 `ensureBound` 于是去 `session/resume`，
     dsh-acp 对「Agent 已经持有该会话」的回答是 `session is already active`；
     hostd 却把它当「会话丢了」：抹掉 `nativeSessionId`、扔出「它的历史可能已经不在了，请新建会话」。
     重开失败=会话还活着，恰恰是绑定成功的证据。
  3. **失败标记被投影盖掉（卡死横幅）**: 提交失败的 `turnState: 'failed'` 写在 journal 投影门
     （`withSessionJournalApply`）之外，而 `deliverPrompt` 自己刚启动的跟随后台循环正在同一口气里
     投影 journal。存储域的写入是排队提交的，排队中的写还没落、`get` 读到的还是旧的 `running`，
     投影随即将 `running` 写回并排在失败标记之后提交——失败标记被埋，之后每次轮询又照抄 `running`，
     「正在生成回复」永远不消失。`concludeTurn` 早就走门内写，唯独失败标记漏在门外。
- 与 `2026-09-04-prompt-fail-reopen`、`2026-09-12-grok-reopen-drops-context` 同族：都是「重开语义被误判」，
  这次新增的是「Agent 明明持有会话却被当成丢失」以及失败标记与投影的写入竞争。

## 修复方案
- `rememberNativeSession`：id 没变就不再动 `nativeBound`——只有真正完成一次会话 RPC 才改绑定状态，
  重记同一个 id 不算解绑。换模型等带 `sessionId` 的帧从此不会引发多余的重开。
- `bindNativeSession` 失败分支：先识别 `session is already active: <本会话 id>`，命中即视为重开成功
  （`contextSource = 'resumed'`，保留 `nativeSessionId`，`markBound`），不再抹 id、不重建上下文、不报错。
  「unknown session」等真正的丢失仍走原路：有上下文种子就重建，没有就如实报错。
- `markPromptUndelivered` 的读-改-写整体挪进 `withSessionJournalApply`（与 `concludeTurn` 同一把门内锁）：
  失败标记要么先于投影提交、要么在投影读到之后再提交，两种顺序下投影的保护分支都保留 `failed`，
  不再被排队中的旧值覆盖。

## 验证步骤
1. ✅ hostd 集成：换模型帧之后发消息 → 不出现任何 `session/resume`，消息正常完成
2. ✅ hostd 集成：Agent 回答「session is already active」→ 消息照常完成，`nativeSessionId` 保留，不重建上下文
   （修复前该用例逐字抛出用户报错原文）
3. ✅ gateway：提交失败与并发 journal 投影竞争（注入写延迟还原真实窗口）→ 会话保持 `failed`，
   「消息提交失败」状态行保留（修复前该用例稳定复现卡死的 `running`）
4. ✅ 全量 `vitest run` 485 passed；`tsc -b` 无错误；`npm run build` 通过

## 相关测试
- `packages/hostd/tests/hostd-integration.spec.ts`（两条新用例）
- `packages/hostd/tests/fixtures/fake-acp-agent.mjs`（新增 `already-active` 拒绝模式）
- `packages/dsh-gateway/tests/gateway.spec.ts`（一条新用例）
- `packages/dsh-gateway/tests/helpers/memory-backend.ts`（新增写延迟开关 `writeDelayMs`，用于打开写入竞争窗口）
