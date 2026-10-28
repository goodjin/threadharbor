# 2026-10-28 · 会话打不开：同一工具调用写了多条结果，整份日志拒绝加载

## 问题描述

用户反馈会话 `session-45e37357-118e-4ea8-b40a-2f93f18f2d40`
（`~/.dsh/sessions/--Users-good-qg-glasses-os--/`）**连历史都加载不出来**：

```
历史加载失败：stored session "session-45e37357-…" is corrupt:
SessionFormatError: tool/result
  call-ea7d1385-61d9-433a-abe7-e6bd6cd65534-2
  has no advertised tool lifecycle
```

不是某张卡片坏了，是整份日志被宿主判为不可读。本仓库此前也出过「工具调用与
结果不配对」的事故（`2026-10-20-tool-result-pairing-on-replay.md`），但那次是
发给模型的历史不合法、界面与会话本身还能打开；这次是日志的**生命周期表**在
校验阶段就失败，属于更底层的类别。

## 现场证据

- 解压后 7004 个事件（`session.v4.jsonl.zstd` 1.8 MB），日志尾部完整：
  `step/end`（seq 7002）、`turn/end`（seq 7003）都在，不是截断。
- `tool/result` 共 2558 条，按 `(turn, toolCallId)` 归组后是 1996 个调用：
  **269 个调用有多条结果**，多出来的结果共 562 条。
  - 其中一个调用 `call-ea7d1385-…-2` 有 9 条结果；
  - 最多的一个（`call-bbdfc7e1-…-24`）有 **102 条**。
- 用宿主的真实校验器（`@deepseek-ai/dsh-session-format-v3-to-v4` 的
  `restoreReleasedV4Artifact` + `dsh-session` 的已知事件类型表）复现，
  报错与界面完全一致。
- 解压本身有个坑：日志是**多帧 zstd**，Node 的 `zstdDecompressSync` 一次性
  调用只返回第一帧（208 字节 / 1 行），初看还会误判成「日志正常」。必须像
  宿主那样先按 `ZSTD_MAGIC` 扫帧边界、再逐帧解压。
- 这些重复结果**不是**老式的手写脏数据：日志后段有一段 301 个
  `compaction/prune` 的压缩记录，它们正是逐个「修剪」这些多余结果节点时留下
  的；每条 prune 都要求它命名的 `shadowedSeqs` 是**当前表面上的精确一段**。

## 根因分析

`f2d3329`（grok bash 卡片直接从 TerminalService 取实时输出 + 耗时）把
`handleTerminalOutput` 写成了「每来一块终端输出就追加一条 `tool/result`」，
终端退出时再追加一条收尾结果。这是对宿主会话日志模型的两处误解：

1. **一个被公告的工具调用，生命周期只允许一条结果。**
   宿主的校验器在第一条 `tool/result` 到达时就把这个调用从待结算表里删掉；
   第二条会命中 `tool/result <id> has no advertised tool lifecycle`，
   并且这个错误不是丢一条事件，而是让**整份文件**无法恢复。
2. **同一调用的内容更新只有一种合法写法：表面替换。**
   `surfaceOp: { op: 'replace', startSeq, endSeq }` 且
   `sourceEventSeqs: [startSeq]`，并且与它遮蔽的节点相比**只能改
   `message.content`**（宿主的 `surface.ts:assertToolResultRewrite`）。
   替换不消耗生命周期，所以多次更新可以链式表达。

所以这不是「上游又变了」的兼容性问题：上游的规则一直如此，是我们这条新写的
实时输出路径违反了它。之所以拖到会话打不开才暴露，是因为界面读的是投影后的
表面——多条结果在渲染上并不难看，只有重新加载、走校验器时才致命。

### 为什么保存时没有拦住

宿主的 `Session.append`（`packages/core/session/src/index.ts`）只校验两件事：
事件数据本身合法、以及表面操作合法（`surfaceManager.validateNext`）。
**跨事件的生命周期表不在保存路径上**——`tool/result` 是否有对应的
`tool/call`、这个调用是否已经结算过，只在打开日志时由
`session-format-v3-to-v4` 的 `relationships.ts` 检查。这是宿主的结构性缺口：
违规写入当场成功，错误延迟到下一次加载，且失败面是整份会话。

我们无法改宿主，但可以把这条规则放到**我们自己的唯一写入口**上：违规写入在
落盘前就被改写成合法形状或丢弃，而不是等下一次加载才炸。

## 修复方案

### 1. 写入层：把规则放到唯一入口（`content-writer.ts`）

`makeContentWriter` 现在为每个 `(turn, callId)` 记住「当前结果节点」：

- 第一条结果：照旧 `append`，`sourceEventSeqs` 指向 `tool/call` 的序号；
- 之后同一调用的结果：写成上一条结果的**内容替换**，payload 的非内容字段
  （`message.id`、`source`、`toolCallId`、`isError`、turn、step）原样保留，
  只换 `message.content`；
- 找不到调用公告的孤儿结果：**丢弃**并回调 `onOrphan` 报告。丢一次调用的输出
  是较小损失，写进去是整份会话再也打不开。

配对键刻意只用 `(turn, callId)`、不含 step：子代理的卡片在出生段打开、结果在
后续段落地（`runsteps.spec.ts` 的跨段用例守住了这一点）。

### 2. 运行层：流式输出与退出收尾（`runner.ts`）

- `LiveCards` 新增 `streamed` 集合，记录「已有结果、但终端还没退出」的调用；
- `writeTerminalResult` 统一走写入层，因此第一块输出落 append、后续全部落替换；
- 终端退出只做**最后一次内容刷新**，不再追加第二条结果；
- provider 迟到的 `tool_call_update`（completed）被视作同一次结果刷新，
  投影阶段按 `settled || streamed` 去重；
- 回合被中止时，流式卡片的结果内容保留已累计的输出，再追加中止说明，
  而不是把唯一的运行证据替换成一句「没有等到结果」。

### 3. 保存期校验与修正：`withLifecycleGuard`（`session-lifecycle.ts`）

新增一个包在 `append` 外层的守卫，按与宿主校验器相同的语义维护两张表：
「已公告、未结算」的调用（`started`）与每个调用当前结果节点的序号和身份
（`current`）。它的目标是**日志可加载**，不是让写入方失败——所以它修正或
丢弃，绝不抛异常（宿主自己抛的错仍照常冒泡）：

- 同一调用又来一条 `append` 结果的（原 bug 的形状）：自动改写成对“当前
  结果节点”的**内容替换**，内容的身份字段（`message.id`、`toolCallId`、
  `isError`、turn、step）原样取自被遮蔽节点，只换 `message.content`。
  用户看到的输出不丢，日志也合法；
- 没有 `message.toolCallId`、或背后没有已开始调用的结果：**丢弃**，并通过
  `onAdjust` 回调报告（丢弃一条输出，好过整份会话打不开）；
- 替换型结果：原样放行，同时把当前节点推进到它；
- 仍在进行中的调用又收到一条 `tool/call`：丢弃重复的那条（保留正在进行的
  那个生命周期，它的结果仍能正常结算）；
- 其余事件类型一律透传。

接入点是我们**自己拥有的所有会话写入口**：

- `makeContentWriter` 的每一次写入都经过守卫（消息、工具卡、未送达提示）；
- 子会话（`SubagentSessions.ensure`）的 `ChildSessionLike.append` 也被包住，
  每个子会话一张表；
- 子代理工具帧另加一张 `writtenResults`：同一 `callId` 的重复结果帧直接跳过，
  不再依赖下游写坏后再修；
- 子代理终态收尾前，给已落卡但始终没等到结果帧的调用补一条**空结果**：
  宿主校验要求 `step/end` 前每条 call 均已结算，缺这一条会让子会话日志整份
  拒绝加载。

这条守卫如果早一版存在，`f2d3329` 的实时输出不会安静地写坏 269 个调用：
第一块终端输出落 append，后续输出会被改写成替换链，回合照常跑完。

顺带修掉一个**同类的潜在致命 bug**：图片未送达提示（`undeliveredEvents`）
只写了 `tool/call` + `tool/result`，却没有先写带 `tool-call` 块的
`assistant/message` 公告。宿主会直接判 `tool/call … has no advertised
tool lifecycle`。已用真实校验器在合成日志上复现，并在写入层补上公告；
`image.spec.ts` 现在同时断言公告、调用与结果三者一致。

### 4. 旧日志恢复（`scripts/repair-session-log.mjs`）

已经写坏的日志不能靠删行修：每条事件都带稠密的 `seq`，删一行会让后面所有
引用失效。脚本做两件事：

1. 每个 `(turn, toolCallId)` 的第一条结果保持 `append`，其余依次改写成
   「替换上一条结果」的链（内容取各自原本的内容，身份字段取被遮蔽节点）；
2. 重新折叠表面，把因重复节点消失而失效的 `compaction/prune` /
   `compaction/summary` 区间重指到同一调用在当前表面上的存活节点。

默认只做 dry-run；`--write` 会先备份（`<file>.bak-<epoch ms>`）再写回，
输出为单帧、带校验和的 zstd（宿主自己也是这种编码，帧扫描器接受任意帧数）。
脚本拒绝处理它无法安全改写的形状（多节点 prune 区间、首条结果不是 append、
替换目标不在当前表面等），不会「猜着修」。

改写是幂等的：已经处于正确替换链上的结果原样保留，再次运行会报 `ok` 而不是
重复备份。这一点在真实数据上抓过一个假阳性——第一版只要看到「同一调用多条
结果」就计入改写，把 150 份**本来就没坏**的日志误报成待修；改完后真实结果
才是下面的统计。

### 加载前的体检与批量修复（scan 模式）

```sh
npm run sessions:check                       # = node scripts/repair-session-log.mjs --scan ~/.dsh/sessions ~/.dsh-web/sessions
node scripts/repair-session-log.mjs --scan <root>… --write   # 批量修复可修项
```

- 只扫宿主要加载的 **v4** 日志（`session.v4.jsonl(.zstd)`），v3 历史日志不归
  这套规则管；
- 每个文件一行：`ok` / `repairable` / `corrupt` / `unreadable`；
- 退出码：`0` 全部可加载、`1` 有可修项、`2` 有读不了或拒绝处理的文件；
- `--write` 只修 `repairable`，每个文件各自备份；`corrupt`/`unreadable`
  一个字节都不碰。先扫描、再决定是否批量修，是可审计的两步。

本机实测（2026-10-28）：两个 profile 共 872 份 v4 日志，**871 ok、1
repairable、0 corrupt**；可修的那份（21 个重复调用）在副本上修复后，经宿主
真实校验器验证 **VALID（4230 事件）**，原件未动。

需要说清的边界：这是「加载前**可以**做的校验」，不是自动拦截。会话插件在
会话打开**之后**才加载（`ctx` 里没有 pre-load 钩子），要把它接到加载路径上
只能 monkey-patch profile 级的 `sessionPersistence.open`——在加载路径上改写
数据、且把宿主的抽象接口当成内部实现来依赖，风险高于收益。真正的解仍应
由宿主在 `Session.append` 里补生命周期校验；在那之前，写入层守卫 + 这个
体检脚本是两侧的护栏。

本次真实会话的修复统计：

- 7004 个事件，269 个调用、562 条多余结果被改写成替换链；
- 63 个 prune 区间被重指；
- 拒绝 0、孤儿 0。

## 验证步骤

- `npm run typecheck` 通过；`npm run test`：**163 个文件、2075 个用例通过**
  （41 个跳过）。
- `content-writer.spec.ts` 新增/改写：
  - 重复结果 → 第一次 `append`、第二次
    `{op:'replace', startSeq:2, endSeq:2}` + `sourceEventSeqs:[2]`，
    `message.id` 保持第一条不变；
  - 连续多次更新链到最新节点；
  - 孤儿结果被丢弃并报告；跨 turn 的伪配对被丢弃。
- `session-lifecycle.spec.ts`（新增）：
  - 一次调用一次结果原样通过；
  - 第二次 append 结果**不抛错**，自动改写成对当前节点的内容替换（身份取自
    被遮蔽节点、内容取新事件），并回调 `refined`；
  - 连续追加依次链到最新结果节点；显式替换放行且推进当前节点；
  - 无调用的结果、无 `toolCallId` 的结果被**丢弃**并回调 `dropped`，不写日志；
  - 进行中的调用重复收到 `tool/call` 时丢弃重复项，原调用的结果仍能结算；
  - 宿主拒绝的 `tool/call` 不会被记成「已开始」，后续结果被丢弃（宿主错误
    本身照常冒泡，不吞）；
  - 同一 callId 结算后可再次使用。
- `image.spec.ts`：未送达提示现在按「公告 → call → result」写入，
  三者的 callId/name/arguments 一致，result 的 `sourceEventSeqs` 指向 call。
- `subagent-sessions.spec.ts`：同一 callId 的重复完成帧只落一张工具卡、
  一条结果；终态时未回结果的卡片会补一条空结果，排在收尾消息与 `step/end`
  之前。
- `terminal-streaming.spec.ts`：
  - 多块输出 + 退出后，`tool/result` 的 `append` **恰好一条**，其余全是替换，
    最新内容包含完整累计输出；
  - provider 迟到的 completed 帧不产生第二条 append。
- 已损坏的真实会话修复后，用宿主的真实校验器验证：**VALID（7004 事件）**；
  唯一一份本机待修日志的修复副本同样验证 **VALID（4230 事件）**。
- 用同一校验器复现未送达提示的旧写法：`INVALID … tool/call
  undelivered-test-1 has no advertised tool lifecycle`——证明这是会写坏
  日志的真 bug，不是收紧过度的自检。
- `sessions:check` 产物本身可自证：修复副本再扫一遍是 `ok`（幂等）。
- 修复前后逐调用比对：1996 个调用全部存在；每组**第一条结果逐字节不变**，
  **最后一条结果的内容逐字节不变**——即校验约束满足、用户看到的输出也没有丢。
- 表面最终状态：1996 个调用各恰好一个当前节点，0 个调用有多个节点。

## 相关文件

- `packages/dsh-preset-dispatch/src/content-writer.ts`（写入层的生命周期强制与
  未送达公告）
- `packages/dsh-preset-dispatch/src/session-lifecycle.ts`（保存期生命周期守卫）
- `packages/dsh-preset-dispatch/src/subagent-sessions.ts`（子会话守卫与结果去重）
- `packages/dsh-preset-dispatch/src/runner.ts`（流式结果 / 退出收尾 / 去重）
- `packages/dsh-preset-dispatch/tests/session-lifecycle.spec.ts`
- `packages/dsh-preset-dispatch/tests/content-writer.spec.ts`
- `packages/dsh-preset-dispatch/tests/terminal-streaming.spec.ts`
- `packages/dsh-preset-dispatch/tests/image.spec.ts`
- `packages/dsh-preset-dispatch/tests/subagent-sessions.spec.ts`
- `scripts/repair-session-log.mjs`（旧日志恢复 / 加载前体检与批量修复）
- `package.json`（`sessions:check`）
