# 手机端线上协议探针（Task 6）：端点、信封、mux 帧序与双连接派发结论

- 日期：2026-10-15（实例实测）
- 探针脚本：`scripts/probe-mobile-wire.mjs`（可重复运行，见 §1.3）
- 常量落点：`packages/dsh-mobile-entry/src/wire.ts`（本文每个值都可回溯到本文的实录或参考源码行）
- 参考源码：`reference/deepseek-harness` @ 当前 worktree 的 pin（下称 ref/<行号>）
- 运行时实测对象：dsh `0.2.0-rc.2` 全局安装（`/Users/good/.local/share/node-v24.18.1-darwin-arm64/.../@deepseek-ai/dsh`），与参考源码同构；关键常量（`/api/remote.mux`、`$events`、端点表）在运行时 `lib/` 逐串核对存在

约束提醒：本文只记录两件事——探针实录、参考源码逐行核对。凡源码可推而未实测的，一律标注「源码钉死 / 实测未覆盖」。

## 1. 探针环境

### 1.1 实例

| 项 | 值 |
|---|---|
| 端口 | 3091（Ruling R3：避开 3081 常驻实例） |
| DSH home | `~/.dsh-threadharbor-probe`（专用探针 home，决策见 §1.4） |
| 组合 | worktree 的 `cordis.patch.yml`（含 `threadharbor-mobile-entry` 行），`dsh plugin --profile web add link:<worktree>` 安装 |
| 装载验证 | `GET /threadharbor/mobile/hello` → 200 `{"mobile":true}`（Task 1-5 路由首次真机装载成功） |
| 启动/停止 | `THREADHARBOR_DSH_BIN=… THREADHARBOR_DSH_HOME=~/.dsh-threadharbor-probe THREADHARBOR_WEB_PORT=3091 scripts/dev.sh start|stop web` |

实例启动日志要点：`acp row mounted: … approvals=host questions=host`（五个 preset 都把审批/提问桥到宿主）；有一条与本任务无关的既有缺陷：`threadharbor-ssh-deploy` 装载失败（`1 entry did not activate`），其余全部激活。

### 1.2 为什么不用共享 test home

`~/.dsh-threadharbor-test` 的 web profile 依赖 `threadharbor: link:/Users/good/github/threadharbor`（主 checkout，main 分支），其快照补丁（`cordis.patch.imported.yml`）没有 mobile-entry 行，主 checkout 也没有这个包。把共享 profile 改指 worktree 会波及 3081 常驻实例，故按 `docs/install.zh.md` 的源码安装路径为探针单开 home。代价：探针 home 没有用户凭据，DSH 原生会话（`standard` preset）无可用模型——这直接决定了 §6 审批实测的边界。

### 1.3 重复运行

```sh
TOKEN=$(grep -o 'token=[^& ]*' "$DSH_HOME/threadharbor-runtime/web.log" | tail -1 | cut -d= -f2)
node scripts/probe-mobile-wire.mjs "$TOKEN"        # 或 DSH_PROBE_TOKEN=… / DSH_PROBE_BASE=…
```

每次运行自建探针会话、自换 cookie、自行收尾（cancel + 关 socket），输出逐行 JSON。本文引用三轮实测：run-1（全量形状）、run-2/3（审批升级尝试；run-3 为最终脚本）。

### 1.4 构建期补充（提交内可见）

- 根 `package.json` dependencies 增加 `"@threadharbor/dsh-mobile-entry": "workspace:^"`：组合行 `@threadharbor/dsh-mobile-entry` 的包解析走 bundle 根依赖（对照参考仓库规则：组合行指向的包必须出现在解析清单的 dependencies 里），没有这一行 profile 安装后无法解析该行、装载即失败。属「必要的 package.json 补充」，已申报。

## 2. 鉴权与 RPC 信封（实测）

### 2.1 令牌换 cookie（手机端配对后的同一条路）

探针第一步实录（run-1/2/3 一致）：

```
GET http://127.0.0.1:3091/?token=<43字符进程令牌>
→ 303 See Other, location: ./
→ set-cookie: dsh-auth-<sha256(authority) 的 base64url>=v1.<body>.<sig>; HttpOnly; SameSite=Strict
```

- 换取只发生在 `GET /`（pathname 严格等于 `/`），其余路径带令牌一律 401——ref `packages/client/connection/src/browser-auth.ts:238-280`（`authorizeIndex`），`TOKEN_QUERY='token'` 在 :15。
- cookie 名是 `dsh-auth-` + authority 的 sha256 base64url（ref `browser-auth.ts:106-108`）；后续所有 `/api` 请求与 WS 升级都只认这个 cookie（ref `browser-auth.ts:287-300`），令牌本身不再参与。
- 结论：手机端打开 pair-url（带令牌）→ 浏览器自动 303 + 种 cookie → 之后与桌面端完全同权限。探针用 `fetch(redirect:'manual')` 读 `getSetCookie()`，手机 WebView 无需任何特殊处理。

### 2.2 RPC 信封（一次错误换来的钉死）

第一次不带 `args` 包装的调用被宿主拒绝：

```
POST /api/session/list  payload={} → 200
{"type":"server-response","rpcId":"…","result":{"ok":false,"error":{"code":"gateway/internal",
 "message":"Remote payload must contain exactly one plain-object args field","details":{}}}}
```

第二次缺命名参数又被拒：

```
payload={"args":{}} → error gateway/arguments-invalid
"typert gateway: session/list: args fields do not match the descriptor: missing \"_request\""
```

钉死的信封（全部后续调用按此成功）：

- 请求：`POST /api/<endpoint>`，body `{"type":"client-request","rpcId":"<uuid>","method":"<endpoint>","payload":{"args":{…命名参数…}}}`
  - `method` 必须与路径端点逐字相等（ref `packages/client/connection/src/rpc-host.ts:230-258`；`type:'client-request'` 字面量必填，ref `packages/client/connection/src/rpc-schema.ts:39-44`，浏览器侧组装 ref `packages/client/connection/src/client/rpc.ts:36-72`）
  - 端点段字符集 `[A-Za-z0-9_$.-]+`（ref `rpc-host.ts:36,280-289`）
- 响应：`{"type":"server-response","rpcId":"<回显>","result":{"ok":true,"value":…}|{"ok":false,"error":{"code","message","details"}}}`（ref `rpc-host.ts:291-312`）
- 命名参数：`session/list` 的参数名是 `_request`，其余目标端点是 `request`（来自 typert 运行时契约 descriptor 的 `wire` 字段；实测证据即上面两条错误）

## 3. 问题 (a)：四个端点——请求/应答实录

### 3.1 会话列表 `session/list`

```
→ {"method":"session/list","payload":{"args":{"_request":{}}}}
← {"ok":true,"value":{"items":[ … ]}}
```

item 字段名实录（run-3，5 个会话）：`sessionId, updatedAt, agentAvailable, running, blank, cwd, projections`；普通会话缺省 `origin`/`parentSessionId`（ref `packages/api/session-controller/src/types.ts:177-191`，可选字段不出现而非 null）。类型 ref `types.ts:248-252`（`SessionListValue{items}`）；调用方 ref `sessions/manager.ts:403`。

### 3.2 历史分页读（加载更早）`session/page`

```
→ {"method":"session/page","payload":{"args":{"request":{
     "address":{"kind":"session","sessionId":"session-…"},
     "throughSeq":10,"maxMessages":5}}}}
← {"ok":true,"value":{"records":[
     {"type":"event","event":{"type":"permission/preset","seq":0,"time":1791917134005,"data":{"preset":"workspace-write"}}},
     {"type":"event","event":{"type":"sandbox/mode","seq":1,…}},
     … ],"hasMore":false}}
```

- `address` 只有两种形状：`{kind:'session',sessionId}` 与 subagent 三元组（ref `types.ts:408-414`）。
- 请求字段全集：`{address, throughSeq, beforeSeq?, maxMessages?, turnWindow?}`（ref `types.ts:471-484`）；响应 `{records, hasMore}`（ref `types.ts:546-549`）。
- **`throughSeq` 语义（实测钉死）**：它是「已载入窗口最旧记录之下」的含端截断。日志最旧 seq 为 0 时传 `-1` 得 `{records:[],hasMore:false}`（run-1/3 `page.chain` 实录）；超出日志长度报 `gateway/bad-request "…past cursor N"`（实测，错误信息顺带披露当前游标 N）。翻页循环：`throughSeq ← 本页最旧 seq − 1`；`-1` 即到底。
- follow 开窗的 `cursor` 是当时的日志末位（下帧见 §4.2），`session/page` 不接受超过它的 `throughSeq`——「加载更早」永远向下走。

### 3.3 发消息 `session/prompt`

```
→ {"method":"session/prompt","payload":{"args":{"request":{
     "requestId":"765ea83f-…","sessionId":"session-363718f9-…","mode":"queue",
     "content":[{"type":"text","text":"请只回复一个词：ok"}],
     "clientTimeZone":"Asia/Shanghai"}}}}
← {"ok":true,"value":{"accepted":true}}
```

- `requestId` 由客户端铸造（uuid），宿主把它持久化在对应 user/message 事件上（实测：journal `agent/inbox/spliced.inserted[].source.rpcId` 与之相等，run-1/3）。
- `mode`：`'queue' | 'steer'`；`content` 部件：`{type:'text',text}` / image / file（ref `types.ts:331-346`、`sessions/session.ts:271-277`）。

### 3.4 取消（停止）`session/cancel`

```
→ {"method":"session/cancel","payload":{"args":{"request":{"sessionId":"session-…"}}}}
← {"ok":true,"value":{"accepted":true}}
```

ref `sessions/session.ts:347-355`（运行中回合取消；排队项保留）。实测两次（普通会话、审批会话收尾）均即时 `accepted:true`，随后 `api-session/status` emit `(sessionId,false)`。

**结论 (a)**：四个端点全部存在、与参考客户端用法一致，无 question (e) 的停报条件。名称都以 `/` 连接（`session/page`，不是点号）——ref `packages/api/gateway/src/index.ts:1383-1385`（`endpointOf = namespace + '/' + method`）。

## 4. 问题 (b)：mux 握手、帧序与日志流帧

### 4.1 握手与 `$events` 订阅（双连接实测）

```
WS  ws://127.0.0.1:3091/api/remote.mux            （Upgrade 带 cookie；无 cookie → HTTP 401 拒绝升级）
C→  {"type":"open","streamId":"<uuid>","endpoint":"$events","payload":{"args":{}}}
S→  {"type":"item","streamId":"<同上>","value":{"type":"ready","clientId":"8f65c756-…","host":{"home":"/Users/good"}}}
```

- 路径 ref `packages/api/gateway/src/stream-protocol.ts:7`；`$events`/payload/ready 常量 ref `stream-protocol.ts:10-19`；就绪帧必为首项 ref `packages/api/gateway/src/client/remote-events.ts:132-146`。
- 两个连接各得**不同 clientId**（run-3 `events.ready`：`8f65c756…` vs `54bbf303…`）——它是应答回路的身份（§6）。
- 客户帧全集四个：`open/item/end/cancel`，字段校验 exactKeys（ref `stream-protocol.ts:234-244, 264-286`）；二进制帧 close 1003、非法帧 close 1008、重复 open（同 streamId）close 整条 socket（ref `packages/api/gateway/src/stream-server.ts:150-159, 201-204`）——手机端**只发这四种形状，不要盲探**。
- 服务端下行只有三种：`{type:'item',streamId,value?}` / `{type:'end',streamId}` / `{type:'error',streamId,error:{code,message,details}}`（ref `stream-protocol.ts:254-257, 293-315`；`end`/`error` 实测出现在逻辑流收尾，`error` 形状见 §6.2 的 `$events/result` 无效流错误路径）。

### 4.2 会话事件流 `session/follow`（手机端读会话的实时通道）

```
C→  {"type":"open","streamId":"<uuid>","endpoint":"session/follow",
     "payload":{"args":{"request":{"address":{"kind":"session","sessionId":"session-…"},"assistantStream":true}}}}
S→  item value = 开窗快照（每连接恰好一次）：
    {"type":"snapshot","header":{"version":4,"id":"session-…","createdAt":1791917479668,
      "cwd":"/Users/good/github/threadharbor/.worktrees/mobile-entry","isSeeded":false,
      "agentPreset":"acp-claude"},
     "cursor":13,"hasMore":false,"records":[ {…}×14 ],
     "projections":{"asOfSeq":2,"values":{"title":null,"goal":null,"tokenUsage":{…},…}},
     "assistantStream":{"revision":106}}
S→  item value = 之后每条落盘事件，一条一帧：
    {"type":"event","event":{"type":"agent/inbox/spliced","seq":3,"time":…,"data":{…}}}
S→  item value = 助手流式帧（assistantStream:true 时）：
    {"type":"assistant-stream","frame":{"type":"start","attemptId":"session-…:1","revision":1,"turn":1,"step":1,"startedAfterSeq":12}}
    {"type":"assistant-stream","frame":{"type":"chunk","attemptId":"…:1","revision":2,"index":0,"time":…,"chunk":{…}}}
    {"type":"assistant-stream","frame":{"type":"end","attemptId":"…:1","revision":3,"index":1,"outcome":{"kind":"committed","eventType":"assistant/message","seq":…}}}
```

（帧形全部实测：run-1 `journal.snapshot`/`journal.items`/mux.frame 实录 + 补测一次带 header 的快照；类型 ref `types.ts:552-563`、`types.ts:494-545`。）

**append/prepend 澄清（对 Task 8 重要）**：线上**没有** append/prepend 帧——follow 流的下行就是 `snapshot` + 逐条 `event` + `assistant-stream` 三种 item value；「append（活事件追加）还是 prepend（loadOlder 前插）」是浏览器端 `RemoteJournalStream` 按 seq 排序后的分类（ref `packages/api/gateway/src/client/journal-stream.ts:190-215`，`SessionJournalChange` ref `packages/api/session-controller/src/client/transport.ts:50-78`）。手机端照抄这个分类即可，别在协议层找它们。

会话控制流 `session/control`（宿主级快照流，投影/收件人基线）同机制存在（ref `transport.ts:115-134`）；手机端 v1 用 `session/list` + `api-session/*` emit + `session/follow` 已覆盖，control 流未开。

### 4.3 会话列表的实时性（emit）

两连接同时在线期间实测（run-1/3 `events.inventory`，A、B 完全一致）：`api-session/added`（创建）、`api-session/status`（运行起/停，mount 时有一次 true→false 抖动）、`api-session/activity`（心跳时间戳）、`api-session/error`（消息为可展示字符串）。事件名与参数形状 ref `packages/api/remotes/src/remote-events.ts:20-48`（转发白名单）+ `types.ts:591`（`api-session/added(summary)`）。

## 5. 问题 (c)：`approval/request` 的到达、应答与回路

### 5.1 线上形状（源码钉死，逐行）

- 下行帧（$events 流上的 item value）：`{"type":"waterfall","event":"approval/request","eventId":"<uuid>","agentId":"<agent>","request":{…}}`，`request` 内**不含** `agent`/`signal`（传输时剥除，ref `stream-protocol.ts:52-58`、`packages/api/gateway/src/index.ts:549-606`）。
- `request` 字段：`toolName`（必有）、`callId?`、`reason?`、`displayReason?`（ref `packages/interaction/user-approval/src/types.ts:68-87`）。
- 应答（HTTP，不是 WS 帧）：`POST /api/$events/result`，body `{"type":"client-request","rpcId":"<uuid>","method":"$events/result","payload":{"args":{"clientId":"<本连接 ready 帧的 clientId>","eventId":"<帧里的 eventId>","outcome":…}}}`（ref `packages/api/gateway/src/client/remote-events.ts:186-228`；payload 解包 ref `gateway/src/index.ts:1117-1125`）。
- `outcome` 三型：`{"kind":"next"}` / `{"kind":"result","value?":…}` / `{"kind":"rejected","error":{name,message,code?,details?}}`（ref `stream-protocol.ts:88-95, 102-138`）。审批答案的 `value` 是封闭词表字符串：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（ref `user-approval/src/types.ts:31-36`；浏览器监听器返回值即答案，ref `packages/client/ui-approval/src/client/index.ts:104-106`）。

### 5.2 端点实测（真实审批不可行时的替代证据）

`$events/result` 本身已实测钉死（run-3）：

```
→ {"method":"$events/result","payload":{"args":{"clientId":"probe-bogus","eventId":"probe-bogus","outcome":{"kind":"next"}}}}
← {"ok":false,"error":{"code":"gateway/internal",
   "message":"typert gateway: Remote event result identifies no active event stream","details":{}}}
```

即：端点存在、`{clientId,eventId,outcome}` 形状校验成立（形状错误会报 `api gateway: invalid Remote event result`，run-2 曾因探针自身双层 args 包装实录过该错误——见 §8.3）、按 clientId 找不到活跃订阅时显式报错而非静默吞掉。

### 5.3 真实审批为什么没能触发（证据链，不臆测）

三轮升级（写家目录文件 → 网络访问 → 提问工具），两连接全程在线，均无 `approval/request`（也无 `user-questions/request`）。会话日志给出原因：

- `approval/policy {"policy":"ask"}` 在案（seq 2），但被拒的工具调用**没有**产生 `approval/asked` 审计事件。宿主审批服务 `request()` 必须先追加 `approval/asked` 才进入应答链（ref `packages/interaction/user-approval/src/index.ts:217-231`）——没有该事件 = 宿主审批服务从未被调用。
- 即工具闸发生在 acp 后端（iquest 系）自身：越权写被后端以自身文案拒绝（tool/result 实录 "User refused permission…"），提问工具则根本不存在于该后端的工具面（模型只能文字回复，journal seq 11 assistant/message，无 tool/call）。
- 另一半路（DSH 原生 agent，工具闸确定走宿主审批服务）在探针 home 无模型凭据，无法开轮（§1.2）。

**结论 (c)**：`approval/request` 的到达形状、应答帧、outcome 词表=源码逐行钉死；`$events/result` 端点与校验=实测。**「应答完成整条回路」的端到端实测未覆盖**——采用的正是任务书许可的 fake（源码级）路线，并如实记录。这不成 question (e)：四个数据端点全部实测在案，审批只是事件类，Task 11 真机验收时在带凭据的实例上补一次真实审批即可闭合。

## 6. 问题 (d)：双连接派发结论

### 6.1 emit 事件（实测）：广播，无应答

两连接各自订阅 `$events` 期间，每个 `api-session/*` 事件在 A、B 上**都到达、同序**（run-1/3 inventory 与逐帧日志）。宿主实现即逐客户端入队（ref `gateway/src/index.ts:539-547`），无竞争、无抑制。

### 6.2 waterfall 事件（源码钉死）：广播送达 + 首答生效 + 其余收 cancel

- 事件挂起期间，**每个**已连接客户端都收到同一 `eventId` 的 waterfall 帧（ref `gateway/src/index.ts:602` + `:608-612`）；事件挂起中新接入的连接也会先补收挂起中的 waterfall（ref `:513`）。
- 任一客户端应答：`kind:'result'` → 事件以该值了结（ref `:614-633` `receiveRemoteEventResult`）；`kind:'rejected'` → 事件以拒绝取消；`kind:'next'` → 仅当该应答者是最后一个未答的投递对象时才以 `next` 了结（ref `:630-631`）。
- 事件了结瞬间，宿主向**其余**客户端逐个推 `{"type":"cancel","eventId":"<同一id>"}`（ref `:646-668` `finishRemoteEvent`），并从投递表摘除；迟到者的应答是幂等 no-op（ref `:619-621` 注释）。
- **对手机 UX 的直接含义**：手机与桌面同时在线时，审批请求两边都会弹；谁先答谁生效，另一端收到同 eventId 的 `cancel` 帧后应即时撤卡。手机端**不做**「抢答抑制」的特殊处理——协议本身保证一致；但 UI 必须处理 `cancel` 帧（把等待中的审批卡收掉），否则桌面先答后手机端会挂着一张死卡。

**实测覆盖声明**：6.2 的「cancel 到达输家」一环未获线上复现（依赖 §5.3 的真实 waterfall），手机端联调（Task 8/11）首次遇到真实审批时应回看本节与 `gateway/src/index.ts:614-668` 核对行为。

## 7. `wire.ts` 常量对照表

| 常量 | 值 | 实测出处 | 源码核对 |
|---|---|---|---|
| `SESSION_LIST_ENDPOINT` | `'session/list'` | §3.1（run-1/3 rpc 实录） | ref `manager.ts:403`；端点拼接 ref `gateway/src/index.ts:1383-1385` |
| `SESSION_HISTORY_ENDPOINT` | `'session/page'` | §3.2（records 页 + 空页 + past-cursor 错误） | ref `transport.ts:228`、`types.ts:471-484,546-549` |
| `SESSION_PROMPT_ENDPOINT` | `'session/prompt'` | §3.3（accepted:true） | ref `sessions/session.ts:271-277` |
| `SESSION_CANCEL_ENDPOINT` | `'session/cancel'` | §3.4（accepted:true ×2） | ref `sessions/session.ts:347-355` |
| `MUX_PATH` | `'/api/remote.mux'` | §4.1（WS 升级 + ready 帧） | ref `stream-protocol.ts:7`；升级准入 ref `gateway/src/index.ts:245-262` |
| `EVENTS_STREAM_ENDPOINT` | `'$events'` | §4.1（ready 双 clientId） | ref `stream-protocol.ts:10-19` |
| `EVENT_RESULT_ENDPOINT` | `'$events/result'` | §5.2（unknown clientId 错误） | ref `stream-protocol.ts:13`、`gateway/src/index.ts:430-444` |
| `MuxClientFrame` | 四帧型字面量 | §4.1（open/item 被 0.2.0-rc.2 接受） | ref `stream-protocol.ts:234-244, 264-286` |

## 8. 偏差、缺陷与遗留记录

1. **信封比计划多一层**：计划文本写 `{method, payload, rpcId}`，实测 `payload` 必须是 `{args:{…}}` 且参数名按 descriptor（`_request`/`request`）。wire.ts 与研究笔记以实测为准。
2. **端点是斜杠**（`session/page`）：若按客户端调用语法猜成 `session.page` 会 404。已钉死。
3. **探针自身两处已修正**（记录以免误读旧日志）：run-1 的 `$events/result` 调用误包双层 `args`（错误信息「invalid Remote event result」即由此来，不代表端点坏）；run-2 的早退水印读了上一轮的 status 帧（导致候选 2 与 fallback 被提前放弃）。最终脚本已修。
4. **实例装载缺口（既有，非本任务引入）**：`threadharbor-ssh-deploy` 在组合中激活失败（`failed to import`），不影响探针面；提请后续任务/triage 注意。
5. **审批实测缺口**：§5.3/§6.2 所述，源码钉死、线上未复现。补验路径：带模型凭据的实例上走 DSH 原生会话触发工具审批。
6. **`session/control` 流、`subagents.*`、`commands.execute`、附件/搜索/改题等其余端点**：不在本任务四类之内，未探针；手机端后续若要，先读 ref `typert` 契约再探。
