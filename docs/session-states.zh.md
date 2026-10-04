# 会话状态机盘点

核对时间：2026-09-29（依据当日工作区源码逐点核对，非凭印象）

## 0. 速览

一个会话在浏览器里看到的「状态」实际由**三张独立状态表 + 两层派生态**叠加而成：

| 名称 | 取值 | 谁是权威 | 回答的问题 |
|---|---|---|---|
| 通道状态 channelState | connecting / open / reconnecting / lost | 网关 | 「现在能不能和这个会话通信」 |
| 本轮状态 turnState | idle / running / waiting-permission / stopped / failed | 网关 | 「刚才那轮请求的结局 / 现在这轮到哪了」 |
| 绑定状态 binding.state | active / superseded / lost | 网关 | 「浏览器会话还挂没挂在那个远端会话实例上」 |
| 发送进度 promptProgress | connecting / sending / waiting / reconnecting / failed | 浏览器本地 | 「我刚发的那条消息送到没有」 |
| 实时通道 phase | loading / ready / reconnecting / error | 浏览器本地 | 「浏览器到网关的推送还活着没有」 |

hostd 侧还有一个更底层的本轮标记（promptActive：这条 prompt 有没有在飞）与会话实例身份（generation），
它们是网关状态的**证据来源**，不直接展示。

## 1. 状态定义位置

- 协议定义：`packages/protocol/src/index.ts`（RemoteChannelState / RemoteTurnState / RemoteBindingState）
- 网关持久化与转移：`packages/dsh-gateway/src/index.ts`（会话目录 + 转移逻辑全在这里）
- 浏览器推导展示：`packages/dsh-client/src/client/conversation-model.ts`（横幅/按钮）、`RemoteSidebar.tsx`（列表角标）
- 远端进程侧：`packages/hostd/src/agent-session.ts`（journal、promptActive、generation）、`agent-bridge.ts`（进程死活）

## 2. channelState 转移表

| 变到 | 触发条件 | 发生处 |
|---|---|---|
| connecting | 建会话落库（占位） | session.start 建行 |
| open | 绑定/重连成功（attach、restart、子会话收编、prompt 投递） | withAttachment / deliverPrompt / upsertNativeChild |
| open | connecting 的会话完成首次日志同步（见下方自愈规则；红黄一律不因投影改变） | projectJournalPage 折叠收尾 |
| reconnecting | hostd 打不通/超时/网络类失败（同步失败、cancel 失败、跟进循环补拉失败、消息没送达） | syncEvents / cancel / runFollowedLoop / markPromptUndelivered |
| reconnecting | attach/restart 失败且 hostd 根本没应答（网络类，含纯连接拒绝） | markChannelBroken |
| lost | attach/restart 失败且 hostd 应答了坏消息（没有这个会话 / hold 进程的套接字没了 / 有冲突要处理） | markSessionLost |
| lost | 消息没送达且主机回话说记录没了或进程没了 | markPromptUndelivered |
| lost | 绑定代际（generation）对不上：attach/restart 返回、日志页返回（binding 同时记 superseded） | attachSession / restartSession / projectJournalPage |
| lost | 日志出现缺口（journal.gap） | 跟进订阅回调 |
| lost | 父会话被重开，子会话连坐 | markChildrenLost |
| lost | 网关自己重启，把所有 open/lost 降级（远端会话要重新认领） | demotePersistedChannels |

自愈规则（2026-09-29 定）：**红（lost）黄（reconnecting）只被「真正碰到通道的调用」清掉**
（重连 / 重开 / 发消息成功），日志投影一律不清——日志是 hostd 盘上的记录，Agent 通道死了照样
读得到内容，内容到达不能证明通道活了。`closed` 状态已删除（死状态，生产代码从未赋值）。

## 3. turnState 转移表

| 变到 | 触发条件 | 发生处 |
|---|---|---|
| running | 用户发消息（准入先置 running，先于任何日志帧） | deliverPrompt |
| running | 子会话有新活动（父日志里的子任务输出） | flushChildTranscripts / upsertNativeChild |
| running | 卡片全部应答完，从 waiting-permission 复位 | settleBackendRequest |
| waiting-permission | 折叠日志时发现挂着未答的权限/提问卡 | projectJournalPage 折叠收尾 |
| idle / failed | 折叠到轮次结束帧（prompt_complete / turn/end / session.status=idle） | projectJournalPage |
| stopped | 用户点停止 | concludeTurn |
| failed | 本轮在途时 hold 打不通 / 静默超时（45 分钟看门狗） | concludeTurn（跟进循环、同步） |
| failed | 通道死亡时本轮还在途（部分路径） | markSessionLost 等 |
| failed | 建会话自动带首条消息失败 / 消息投递失败 | markPromptUndelivered |
| failed | 重开打断在途轮次（上下文被换掉） | attachSession 的 interrupted |
| idle | attach 成功时把 failed/stopped 当「过期故障标记」清掉 | attachSession 的 staleTerminal |
| idle | 显式「结束进程并重开」 | restartSession |
| idle | 父轮次结束时把还 running 的子会话收拢 | flushChildTranscripts |

粘滞规则（折叠收尾）：stopped 不被后来的帧改回 idle/running；failed 不被 running/waiting-permission 覆盖。
另外，处于 stopped 的会话**根本不投影迟到帧**（suppress 规则），所以停止后的任何信号都进不来。

## 4. binding.state 转移表

| 变到 | 触发条件 |
|---|---|
| active | 绑定/重连/重开成功（withAttachment、子会话收编） |
| lost | 通道被判定要修复的那批事件（hostd 报无此会话、hold 进程没了、日志缺口、父会话连坐） |
| superseded | 代际被新实例取代：attach/restart 返回的 generation 对不上、日志页的 generation 对不上 |

## 5. 派生态

- 浏览器侧「本轮失败/发送失败/等待中」横幅由 turnState + promptProgress + 最后一条转录行共同推导
  （conversation-model 的 turnStage / channelStage / sessionActionGates）。
- 按钮开关：发送要求通道 open；「在当前会话重开」在 reconnecting / lost / 本轮 failed / 发送失败时出现。
- hostd 侧 promptActive：投递置位，轮次应答/超时/进程死亡清零；进程死亡写入一帧
  `_dsh/transport_closed`（带 code/signal）进日志，就是那句「远程 Agent 已停止（…）」的来源。

## 6. 不合理之处（按性质分组）

### A. 事实性不一致（同一情况两套处理，建议统一）

1. **通道死亡时 waiting-permission 的处置两边打架。** 3 处把「等待你的确认」视作在途、判失败
   （concludeTurn 一族、markChildrenLost、attachSession 的 interrupted），5 处只认 running、
   保留 waiting-permission（markSessionLost、attach/restart 代际不符、日志缺口、投影代际不符）。
   后者的效果：Agent 进程已死的会话停在「等待你的确认」，卡片还能点，点下去才抛内部错误
   （"no active remote binding"），而且没有自动恢复路径在跑（跟进循环会因绑定失效直接退出）。

2. **子会话没有「已收拢不复开」保护。** 父会话的迟到帧保护（09-18 修的 running 不许翻回）
   只护住了父行；flushChildTranscripts / upsertNativeChild 收到迟到的子任务输出，会把已 idle 的
   子会话翻回 running，而收拢动作只发生在「本轮结束帧所在的那一页」。父轮次早已结束时（正是
   09-18 那个场景）子会话会挂「进行中」直到父会话下一轮结束。同病根的漏网。

3. **本轮失败的理由串台。** 浏览器把 promptProgress 判失败时，文案取自全局连接错误
   （store 的 reconcilePromptProgress 用 snapshot.error 兜底），可能显示成与本会话无关的原因。

**（已修，2026-09-29）** 三条都已统一：通道死亡一律「在途即判失败」（running 与
waiting-permission 同等待遇，顺带撤掉无法再被应答的卡片）；子会话与父会话同一条规则
（迟到输出不把已收拢的子会话翻回进行中，父轮次结束也照收拢）；失败理由不再借用全局连接
错误，横幅改为「原因见上方记录」，真实原因就在转录的状态行里。回归测试见
gateway.spec（fails a parked turn… / does not let late subagent frames…）与
conversation-model.spec（does not borrow an unrelated connection error…）。

### B. 语义张力（两处注释互相矛盾，需要拍板）

4. **failed / stopped 既是「上一轮的结局」又是「要修的信号」。** 一处规则说「终态标记直到下次
   prompt」（投影折叠的粘滞规则），另一处说「它是过期故障标记，重连修好就清」（attachSession 的
   staleTerminal）。实际语义变成「直到下一次自动重连或发问」。后果：一轮真失败的红条，会在用户
   打开会话（触发 follow→attach 自动重连）时无故消失，用户可能根本不知道自己的请求死了
   （转录里有「远程 Agent 已停止」记录，但横幅没了）。
   建议方向：把「上一轮结局」和「待修复」拆成两个字段，结局只被下一轮改写。

**（已定，2026-09-29）** 不拆字段，语义定为两种角色：failed 是「上一轮结局 + 待修信号」，
重连/重开修好后清掉，但清的动作必须在记录里留一行（"重新连接会话，上一轮的失败标记已
清除。"），看得出是哪个动作清的；stopped 不是待修信号而是结局本身，重连不改写它（下一次
发消息才进入下一轮）。拆成两个字段的方案不再需要。

5. **一张 channelState 描述四条链路。** 浏览器↔网关（phase）、网关↔hostd（reconnecting/lost）、
   hostd↔会话记录（lost）、hostd↔Agent 进程（只体现为转录行 + 本轮 failed）。同一个字段混着
   三种连接的健康度，跳变就显得随机。且自愈规则语义倒挂：lost 的会话只要投影成功一次就翻回 open，
   而 reconnecting 反而不会因投影到达而恢复。

**（已定并已修，2026-09-29）** 不拆字段，收紧语义。动手前逐点核对源码，修正了盘点里的两处说法：
「lost 投影即消」其实**够不着**——每个写 lost 的地方都同时作废绑定，而读取和推送两条内容路径都
拒绝失效绑定，那条自愈规则是遗留的死代码；真正在用户眼前乱跳的是**分类错误**：主机够不着
（网络断、服务没起）这种临时故障被记成红的 lost，下一次调用成功又变绿，红条闪一下就走。现在的口径：
**够不着记黄（reconnecting），会自己好；主机明确回话「记录没了 / 进程没了 / 有冲突要处理」才记红
（lost），要修复动作才清。** 自愈统一为「只有真正碰到通道的调用（重连/重开/发消息成功）才清红黄，
投影一律不清」。顺带把中断口径分开：主机够不着不再写成「远程 Agent 进程已停止」，两条横幅文案
也不再借用无关的连接错误。

6. **stopped 与迟到的「轮次错误完成帧」。** 迟到的 prompt_complete(error) 目前仍可把 stopped
   改成 failed（粘滞规则留了口子）。按「已结束的会话不该再被改写」的原则，这个口子要不要堵上，
   取决于你认为「用户停止」和「后端报告失败」哪个是更该保留的结局。

**（已定并已修，2026-09-29）** 定调：迟到的「本轮失败」不能把已结束的轮次改成失败。落地前
核实发现此处原判断有误：stopped 期间迟到帧整段被抑制，实际上翻不动，粘滞规则里那个口子是
够不着的；真够得着的是**已收拢的 idle 轮次**会被迟到的 prompt_complete(error) 翻成 failed。
现在一条折叠规则统一处理：已收拢（idle / stopped）的轮次不被迟到的失败报告改写，事实照记
在转录里；在途（running / 等待确认）的轮次被失败报告判失败，这是它真实的结局。
回归测试见 gateway.spec「does not let a late round failure rewrite a settled round」。

### C. 死状态 / 冗余（建议删掉或补上真实来源）

7. channelState = closed：生产代码永不赋值，客户端却有「会话已关闭」分支 —— 死状态。
   **（已删，2026-09-29）** 协议类型、网关存储校验、客户端解析与展示分支全部删除。
8. binding.state = superseded：全库 0 处赋值 —— 死状态。「被新 generation 取代」的场景目前记成
   lost，其实语义是 superseded（旧实例作废，不是会话丢失）。
   **（已补上来源，2026-09-29）** 三处「代际对不上」（attach/restart 返回、日志页返回）改记
   superseded；hostd 报无此会话、进程没了、日志缺口仍记 lost。回归测试见 gateway.spec
   「records a replaced generation as superseded, not lost」。

### D. 顺手核实过、目前没问题的组合

- 迟到退出帧改写空闲轮次：上一轮已修，且补了回归测试。
- 迟到退出帧改写「用户主动停止」：**不会**——stopped 期间迟到帧整个被抑制，连转录都不进。
  为此补了回归测试（gateway.spec「keeps a user-stopped round stopped…」）。
- 迟到内容把 failed 翻回 running：被粘滞规则挡住。
- 迟到 prompt_complete 把 failed 翻回 idle：有意为之（真实完成是比记着的失败更强的证据）。
- 用户停止后的「继续输出」不进转录：有意为之（已有测试盯着）。

## 7. 处置进度（2026-09-29 核对）

已完成：A1、A2、A3、B4、B6、B5、C7、C8（见各条下的处置记录；语义按「失败是待修信号、重连修好后
清掉并留提示；已结束的轮次不被后来的报告改写；红条只在主机明确回话说会话不可用时出现，只被
修复动作清掉」执行）。改动记录见 bugfix/2026-09-29-session-state-review.md 与
bugfix/2026-09-29-channel-classification.md。

未动：无（本轮把重构级的 B5/C7/C8 一并收掉；B5 取「收紧语义、字段不动」方案，不拆字段）。
