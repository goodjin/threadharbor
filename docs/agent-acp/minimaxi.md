# minimaxi：MiniMax 模型插件

minimaxi 在模型列表里是单独的一组，名字是 MiniMax。选 M3.1 Flash 或 MiniMax M3 就是选它。

它不拉起任何进程，也不走 ACP。凭据来自**本机 MiniMax Code 的登录**——和 zcode 读 ZCode 桌面版登录是同一路子，只是读取、校验、刷新全部采用 MiniMax 官方自己的实现，而不是我们另写一套（原因见文末）。

读文件、跑命令、审批、取消、会话记录都是 DSH 现成的循环，不经过 MiniMax 的工具。

本文说的是怎么用。**上游（MiniMax Code）更新后要不要改我们这边**——搬运了哪些源码、依赖哪些点、怎么判断、怎么同步——见 [上游同步说明](../upstream-sync.zh.md)。

**先决条件**：本机装过 MiniMax Code（或命令行版 `mcode`）并登录过。没登录时这一组模型发消息会直接失败，并说明去哪登录——本插件不另设密钥。

## 身份怎么来的（核对时间 2026-10-20）

官方把登录模块 `@mavis/oauth-core`（MIT）放在开源仓库 `MiniMax-AI/minimax-code` 的 `packages/oauth-core` 里，但没有单独发布到 npm。我们把该目录的源码**原样搬进** [packages/minimaxi-acp/src/vendor/mcode-oauth](../../packages/minimaxi-acp/src/vendor/mcode-oauth)，来源版本与同步办法记在同目录的 `PROVENANCE.md`。搬运的理由只有一个：**共用同一套凭据，才不会互相踢**。

凭据落在 `<数据目录>/auth/<build环境>/<区域>/mcode-public/auth.json`（明文，目录 0700、文件 0600），同目录还有 `auth-state.json` 与 `auth.lock`。数据目录按官方顺序取：`MINIMAX_DATA_DIR` → `MAVIS_DATA_DIR` → `~/.minimax` → 改名之前的老目录 `~/.mavis`。

刷新由官方那段代码在同一把跨进程文件锁内完成，并写回同一个 `auth.json`。**这是不互相踢的关键**：谁先刷新谁写文件，桌面版与本插件读到的都是最新那份，不存在「一方刷新把另一方作废」。

一处刻意的差异：官方读数据目录时会顺手把新旧目录名互相迁移，本插件**只读不搬**。一个聊天宿主不该在用户没要求的时候移动他的 MiniMax 目录，因此老目录在哪儿就读哪儿，不动它。

**区域不靠猜**：从凭据所在目录读出 `cn` 还是 `en`，据此选托管网关——`https://agent.minimax.cn/mavis/api/v1/llm/v1` 或 `https://agent.minimax.io/mavis/api/v1/llm/v1`。国内账号配国际网关是稳定 401，不是能读懂的报错。

## 请求与思考

托管网关说的是 anthropic messages 协议，所以请求体、流式解析、思考签名回放都与 GLM 那套同构。四处是 MiniMax 自己的：

1. **档位**是 `low/medium/high/xhigh/max`，比 GLM 多两档；默认 high。
2. **有些模型关不掉思考**。M3.1-Flash 对 `thinking: {type: "disabled"}` 直接返回 2013 错误，所以推理档选 none 时该请求被丢掉，它照常思考。M3 可以关。
3. **思考签名必须原样回传**。上一轮 assistant 的 `content` 整块带回，`thinking.signature` 一个字符都不能改，否则思维链断裂、多轮工具调用质量下降。流式时签名走独立的 `signature_delta`，本插件把它挂在结束信封上，下一轮原样送出。
4. **工具调用与结果必须成对挨着**。会话日志里结果不一定挨着调用：后台子代理的调用一直没等到结果时，DSH 的补救把「结果未知」写在日志末尾，隔了几百条消息。anthropic 消息格式要求每个 tool_use 由紧跟其后那条 user 消息里的 tool_result 应答，网关对这条很严（2013）。所以发请求前会把历史重新配对一遍：结果搬回它应答的调用旁，没有结果的调用补一条「结果未知」，找不到调用的结果不进请求。详见 [这次事故的记录](../bugfix/2026-10-20-tool-result-pairing-on-replay.md)。

输出上限取模型自己公布的（两个在售模型都是 128000）；调用方要更小就听调用方的，要更大则被截到这个上限。

## 模型清单（核对时间 2026-10-20）

preset 里默认只挂两个：**M3.1 Flash** 与 **MiniMax M3**。这是官方 anthropic 兼容接口在售的两个模型，也是官方目录里思考能力最完整的两个。

官方目录里还有 M2.7 与 M2.7-highspeed，**默认不挂**：M2.7 已公告 2026-11-18 正式下线，且在 Anthropic 兼容接口上只支持文本与工具调用。需要时手工加进 preset 的 `models` 即可。

模型目录本身是从官方搬来的（上游派生自 models.dev，MIT，出处见 [NOTICE](../../packages/minimaxi-acp/src/vendor/mcode-runtime/NOTICE.md)），所以官方加模型时我们跟进一次即可，不用自己维护一份清单。

## 稳定性

托管网关地址 `agent.minimax.cn/mavis/api/v1/llm/v1` 是 MiniMax 的**产品内部路由，官方文档一个字都没承诺过**，随时可能改。我们把它抄过来是为了跟官方保持一致，不是因为它稳。真出问题时先查官方是否已经改了——`src/vendor/mcode-runtime/PROVENANCE.md` 记着同步自哪个提交。

相比之下 MiniMax 开放平台的 `https://api.minimax.cn/anthropic/v1/messages` 是有文档的稳定接口，但它认的是平台密钥或订阅密钥，与桌面版登录**不是同一套凭据**，官方明确写了二者不可互换。本插件走前者，是为了「装了 MiniMax Code 就能用」。

## 验收

`packages/minimaxi-acp/tests/` 覆盖：凭据定位与区域判定、过期后经官方端点刷新、刷新结果留在同一个文件里、请求地址与鉴权头、思考开关与档位、签名回放、流式帧到块的投影、失败信息里令牌被抹掉。工具配对的重放由 `packages/dsh-preset-dispatch/tests/tool-pairing.spec.ts` 覆盖。

真机已跑通（2026-10-20，国内站 `cn`/`prod`，`MiniMax-M3.1-Flash`）：

1. 本机登录已过期 154 小时，插件经官方端点刷新成功，令牌有效期回到 1 小时后；
2. 第一轮发出思考并调用工具 `read_file`，拿到真实工具 id；
3. **第二轮把思考签名原样回传、把工具结果按真实 id 喂回，网关接受并给出正确答案**——签名回传这条最险的路是通的；
4. `MiniMax-M3` 关掉思考直连正常回答；
5. 一段配对坏了的历史（结果记在日志末尾），重新配对前被拒（2013），重新配对后 200 并正常作答。

顺带记一条实测发现：工具调用的 id 形如 `call_function_…`，网关对 tool_result 的 id 校验很严——id 对不上会直接返回 `invalid params, tool result's tool id not found (2013)`。
