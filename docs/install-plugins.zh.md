# ThreadHarbor 的 DSH 插件：安装说明

**核对时间：2026-10-13。** 下面每一处安装形态都对照 `reference/deepseek-harness`
（master，`5badb15009`）读过，行号在括号里。
2026-10-10 第二次复核：补齐 codex / claude 示例里同样必填的 `presetId`，
按实测修正 codex 的 `mode` 取值，并标注 `models` / `hosts` 两个字段目前的实际状态。

---

## 一、先说结论

**七个入口（grok / codex / claude / cursor / qoder / zcode / minimaxi）各自独立，可以分别装；不装也不影响 DSH 自带的 agent。** zcode 与 minimaxi 是模型，另外五个是 ACP agent。

不装任何东西 = 纯 DSH，所有会话走原生 agent，行为与没装之前一样。

---

## 二、为什么是「按 agent 一行」

DSH 的 agent preset 本身**就是一个组合**（一组插件行）：

- 声明式的一行 `@deepseek-ai/dsh-agent-preset`，把自己的 `Config` 原样交给注册表
  （`packages/preset/agent-preset/src/index.ts:28`）；
- 注册表在激活这个 preset 时，把它的 `plugins` 挂载进一个独立作用域
  （`packages/preset/agent-preset-registry/src/index.ts:110-111`）；
- 会话选中 preset 时，把这些插件重新组合到该会话上；开过一轮之后就锁定，
  再选会抛 `agent-preset/locked`（同文件 `:347-362`）。

所以外部 agent 的行为**必须由组合里的某一行提供**，这就是
`@threadharbor/dsh-preset-dispatch` 的入口。

**作用域就是过滤器**：一行只能看见和它一起挂载的会话。别的 preset 上的会话根本
不会出现在它面前，因此原生会话的行为**不会被碰到，也不需要事后撤销**。

---

## 三、装法

在 `cordis.patch.yml` 的组合里，每个 agent 加一个 preset 行：

```yaml
- insert:
    # ── grok：走 WebSocket ─────────────────────────────
    - id: acp-grok
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: acp-grok
        name: Grok
        order: 10
        plugins:
          - id: acp-grok-binding
            name: '@threadharbor/dsh-preset-dispatch'
            config:
              presetId: acp-grok   # 必填：这行得知道自己是哪个 preset 的
              agent: grok
              url: 'ws://127.0.0.1:2419'
              models:
                - id: grok-4
                  name: Grok 4
                - id: grok-4-fast
                  name: Grok 4 Fast

    # ── codex：起子进程 ───────────────────────────────
    - id: acp-codex
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: acp-codex
        name: Codex
        order: 20
        plugins:
          - id: acp-codex-binding
            name: '@threadharbor/dsh-preset-dispatch'
            config:
              presetId: acp-codex   # 必填，三家一样
              agent: codex
              command: /Users/good/.local/bin/codex-acp
              # mode 留空 = 该构建的默认 agent（"Approve for me"）。
              # 想让每步都先问，用 read-only；见下方「各家 agent 需要的配置」。

    # ── claude code ────────────────────────────────────
    - id: acp-claude
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: acp-claude
        name: Claude Code
        order: 30
        plugins:
          - id: acp-claude-binding
            name: '@threadharbor/dsh-preset-dispatch'
            config:
              presetId: acp-claude  # 必填，三家一样
              agent: claude
              command: /Users/good/.local/bin/claude-agent-acp
              mode: default         # claude 默认 bypassPermissions，不写这行它永远不问

    # ── qoder：起子进程，先在本机登录一次 ──────────────
    - id: acp-qoder
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: acp-qoder
        name: Qoder
        order: 50
        plugins:
          - id: acp-qoder-binding
            name: '@threadharbor/dsh-preset-dispatch'
            config:
              presetId: acp-qoder
              agent: qoder
              # 国际版二进制叫 qodercli；CN 版是 qoderclicn
              command: /Users/good/.local/bin/qoderclicn
              mode: default         # 动手前询问；另见下方模式表
              # 不需要写 args：agent: qoder 会自动补 --acp。
              # 需先在终端跑一次 `qoderclicn login`。
```

**只想要一个？删掉其余几段即可。** 各段之间没有依赖。

`command` 之外还可以写可选的 `args`，显式写了就完全接管命令行；不写时按 `agent`
补默认值（cursor 为 `acp --trust`，qoder 为 `--acp`，其余为空）。

### 看护参数（可选，2026-10-16）

preset 行可以再写四个毫秒数的看护参数，管的是「外部 agent 活着但不出活」的形态
（典型：后端断网、agent 在自己的重试循环里打转、停止按钮按了没反应）。都可省略：

| 字段 | 默认 | 作用 |
|---|---|---|
| `stallMs` | 120000 | 帧静默期限：agent 这么久没发来任何一帧，回合按错误收场并带出 agent 日志尾部。stderr 警告不算进展。`0` 关闭 |
| `totalMs` | 1800000 | 单个回合的总上限，不管多能说。`0` 不限。外部 agent 还在等它自己的子代理（后台任务）时这个钟停住——等子代理的时间不算这一回合的预算，子代理收尾后按剩下的预算继续（2026-10-20 会话 7165a323：上限把等子代理的主回合按超时杀掉，5 个子代理的结果全丢） |
| `warnMs` | 30000 | 帧静默超过这个值，往回合里写一条「仍在等待 + agent 最近输出」的提示，只写一次。`0` 关闭；配得 ≥ `stallMs` 时自动作废 |
| `graceMs` | 3000 | 按停止后给 agent 多少时间自行了结，到期未了结杀掉进程、下一回合自动重开。`0` 立即杀 |

旧的 `answerTimeoutMs` 仍被接受，等价于 `stallMs`（两者都是帧静默期限），新配置请用新名字。

### preset 行还在，但选择器里看不到（2026-10-13）

装好后 agent 会出现在两个地方：模型列表（composer 的 provider 列）和 preset
选择器（新建会话的芯片）。两者指向同一批注册：DSH 的注册表激活 preset 时是
**急切挂载**（`agent-preset-registry/src/index.ts` 的 `register()` 一进来就
`mountPreset`），所以这些 dispatch 行一直在跑、各自的模型一直躺在全局目录里——
这就是「模型列表可切换」的来源；而选择器读的是同一个注册表的名册。

模型列表已经是完整的切换入口（空会话选 `acp:` 模型会原地切到对应 preset，
已开场的会话走交接），preset 选择器里的同名条目就是重复的门。DSH 没有
「注册但不上名册」的开关，所以补丁里加了一行 `threadharbor-roster-filter`
（`@threadharbor/dsh-preset-dispatch/roster-filter`）：在名册的**客户端出口**
`remoteExportList` 上包一层。要藏的 preset 不写进过滤器的名单，而是在该
preset 的 binding 上打 `hideFromRoster: true`；过滤器只认这个标记。新增
agent 只要打同样的标记。网关是调用时在实例上按名字取方法的
（`dsh-api-gateway` 的 `prepareInvocation` 用 `Reflect.get`），所以实例级包裹
能拦到；注册表内部的 `list()` 不动——模型→preset 跟随、会话内切换、交接都靠它，
滤掉会把切换整个拒掉。

已知代价：正在跑这些 agent 的会话，头部 preset 标签会兜底显示原始 id（如
`acp-grok`）——名册里没这条，标签只能用 id；旁边模型芯片仍显示 Grok。

### 各家 agent 需要的配置

| agent | 方言 | 连接方式 | 必须写的 | `mode` 取值（实测自各家 `session/new` 返回） |
|---|---|---|---|---|
| grok | `grok` | WebSocket | `url` | 不支持，留空 |
| codex | `codex` | 子进程 | `command` | `read-only`（每步都问）/ `agent`（默认）/ `agent-full-access`。**没有 `on-request` 这个值**——那是设计文档里 approval_policy 的词汇，不是 `session/set_mode` 收的 modeId |
| claude code | `claude` | 子进程 | `command` | `default`（Manual，每步都问）/ `acceptEdits` / `plan` / `auto` / `bypassPermissions`（默认）。**想让它问必须显式写 `mode: default`** |
| cursor | `cursor` | 子进程 | `command` | `agent`（默认）/ `plan` / `ask`。需先在终端完成一次 `agent login`；`args` 默认 `acp --trust` |
| qoder | `qoder` | 子进程 | `command` | `default`（默认，动手前询问）/ `acceptEdits` / `bypassPermissions` / `plan`。需先在终端完成一次 `qoderclicn login`（国际版 `qodercli login`）；`args` 默认 `--acp` |

（modeId 清单取自 `packages/dsh-acp-agent/tests/fixtures/` 里各家的 `session/new`
实测帧；grok 实测不返回 modes。cursor 与 qoder 的细节分别见
[docs/agent-acp/cursor.md](agent-acp/cursor.md) 与 [docs/agent-acp/qoder.md](agent-acp/qoder.md)。）

没有对应二进制就**不要写那一行**——写了会在第一次用到时报连接失败，
而不是安装时报错。

### 可选字段

| 字段 | 作用 | 现状（2026-10-10） |
|---|---|---|
| `model` | 固定模型；不写就用会话里选的 | 生效：会随 `session/prompt` 发给 agent |
| `mode` | agent 的运行模式，各家取值不同 | 生效：开完会话后经 `session/set_mode` 设置 |
| `cwd` | 旧配置里如果还写着，挂载时会说一声并忽略。外部会话只用这条会话自己的工作区；会话上没有工作区就不开工，不会改去预设里写的目录，也不会改去宿主进程所在的目录 | 已忽略 |
| `models` | 声明各家提供哪些模型，供输入框的模型选择器显示 | 生效（2026-10-10 真机已验）：注册进宿主模型目录，选择器按声明清单显示；目录构建时宿主还会逐个解析模型元数据，适配器缺 `resolveModel` 会把整组模型静默丢掉 |
| `hosts` | 限定这台 preset 只在哪些主机上出现 | **暂不生效**：过滤逻辑没接到真机路径（`tests/wiring.spec.ts` 登记为待接） |

`models` 是**声明**而不是探测：探测要求 agent 已经在跑，而模型选择器得在任何
会话被打开之前就能画出来。不写 = 这家暂不提供模型。

---

## 四、几个容易踩的地方

**〇、每个 profile 都要跑一遍统一的插件软链同步（2026-10-20）。**
宿主组合层认的是 bundle 链接（`node_modules/threadharbor -> 仓库`），但客户端包
（`@threadharbor/dsh-client` 等）的解析还需要 profile 级的一组软链。这组链以前靠
各 profile 手工 `ln -s`，结果是 web 装过、桌面没装——桌面页面上 threadharbor 的
客户端整个缺席（输入框模型入口只剩官方的裸模型名），而宿主侧照常挂载，**完全不报
错**。现在统一走一条幂等流程，来源是仓库自己的工作区
（`node_modules/@threadharbor/`，部署切工作树时改仓库这一侧即可）：

```sh
scripts/profile-link-plugins.sh ~/.dsh-web/profiles/web      # 3080（~/bin/dsh-web）
scripts/profile-link-plugins.sh ~/.dsh/profiles/desktop      # 桌面版（重启应用生效）
```

脚本幂等：已一致的软链原样保留。新增插件包（仓库 `node_modules/@threadharbor/`
下多了新名字）后，对每个在用的 profile 重跑一遍即可。

**〇½、其他机器：git 安装自带构建（2026-10-20）。**
仓库根有 `prepare` 钩子（`scripts/prepare-install.mjs`）：git 依赖落成纯 checkout
后，安装时自动补 workspace 依赖并构建出 `lib/client.js`——没有它，客户端包不会
被服务给页面（症状同上）。已经端到端验证：干净 checkout → `pnpm install`（自动
构建）→ profile `link:` 引用 → 软链脚本 → 重启，模型入口带 agent 前缀。推荐把
依赖 pin 在 commit 或 tag 上（对齐 superpowers 的用法）：

```json
{ "threadharbor": "github:goodjin/threadharbor#<commit-or-tag>" }
```

注意两点：一，profile 所在路径别放 /tmp 之类的别名目录（macOS 的 /tmp 是
/private/tmp 的别名，dsh 客户端清单的归属判定在这种别名下会漏掉插件客户端）；
二，bundle 补丁里各 agent 的 `command`、主机名等是按机器写的，装完按下面第三
节逐行核对。

**一、`session.header.agentPreset` 是平的，不是 `meta.agentPreset`。**
读 `header.meta.agentPreset`（设计文档最初的写法）永远得到 undefined，
派发会静默退回原生 agent，而且**任何地方都不报错**。

**二、头部值是会话创建时的旧值。** 一个空白会话之后可以换 preset，头部不会跟着变。
所以判断「这个会话现在到底在哪个 preset 上」要读
`ctx.sessionProjections.stateOf(session, 'agentPreset')`（`packages/preset/agent-preset-registry/src/session.ts:34-44`）。
宿主入口因此留了 `presetOf` 这个口子——能用投影就传投影。

**三、开过一轮的会话锁死了。** 换 preset 要先分叉出新会话
（`agent-preset-registry/src/index.ts:349`）。

**四、跨主机不存在。** 一个会话属于一台主机，它能看到的模型列表里只有这台机器上的
agent。注册表是每个进程一份，天然隔离，不需要额外的检查。

**五、界面上「切换 preset」不会重放 `agent/created`。** 空白会话上选一个 preset
（`agentPresets/select`）只做两件事：把活 agent 的 scope 换挂到新 preset 的组合上、
往会话日志追加 `agent-preset/selected`——`agent/created` 不再触发，捕获它的接管逻辑
因此永远等不到这一类会话。表现是：切完立刻发消息，走的是原生线路，**没有任何报错**。
`applyAcpPlugin` 现在监听 `session/event` 补这个口子，并且替换过的 step 每轮重新读
preset——切走后残留的接管会在下一轮自己让位回原生 step（2026-10-10 真机复现并修复）。

---

## 五、当前状态与没做完的部分

**已就绪**

- 五个 ACP agent（帧方言、传输、权限、终端、投影）都在
  `dsh-preset-dispatch` 与 `dsh-acp-agent` 里，走的是同一套代码。
  zcode 不另起进程：模型列表里单独一组 GLM，用本机 ZCode 登录密钥直连 Coding Plan，读文件、跑命令、审批仍是 DSH 自己的。
  minimaxi 同样不另起进程：模型列表里单独一组 MiniMax，用本机 MiniMax Code 的登录凭据直连托管网关，凭据的读取与刷新采用官方实现，与桌面版共用同一个文件与同一把锁；本机没登录 MiniMax Code 时该组不可用。
- 宿主入口 `applyAcpPlugin` 已实现并有测试，作用域过滤、未知 agent 不接管、
  单个会话出错不影响其余，都有覆盖；
- 真实 agent 端到端跑通：claude、codex、grok、cursor、qoder 各一轮，外加权限请求
  应答后回合继续、以及「回合还在跑就已经流出文字」。

**四个真机浏览器问题的修复（2026-10-10 晚，全部真机复验过）**

1. **「界面只显示已完成、没有回答内容」**：根因是写回去的事件形状不对——回合号
   写死为 0、用户消息根本没写、一次回答拆成了两条 assistant 消息（界面折叠时只留
   最后一条，思考过程就被吞了）。现在回合号取自宿主的 pre-step 瀑布（真实回合号），
   用户消息按原生形状落库，每步只写一条 assistant 消息、思考块在前。真机确认：
   提问、思考、回答、用时全部可见，落库事件序列与原生会话同构。
2. **「选了模型 A 却由 B 回答」**：现在回合开始时读会话自己的模型选择；不是本预设
   提供的模型就明确拒绝并说明原因（点名预设、模型、以及为什么不能装作没看见），
   不再悄悄换成别的模型回答。会话没选过模型时按主机默认模型判断，同样处理。
   真机确认：默认 DeepSeek 时 grok 会话拒绝并说明；选了 Grok 4.6 后正常回答。
3. **「预设列表里只有 grok」**：codex、claude 两行已进补丁文件并确认挂载，
   真机各跑通一轮问答（回答分别来自 Codex 与 claude-agent-acp 的模型）。
   顺带修了一个 codex 特有的崩溃：它不报 token 数，而会话日志的写入器拒绝任何
   含空值的字段——现在没有 token 数就不写这个字段，而不是编一个 0。
4. **「各主机面板排版烂、agent 列表空」**：面板重写为样式模块（全部走设计令牌），
   打开即自动读取 agent 名单（不再等手点刷新）；agent 名单改走模型目录这一个调用，
   不再要求探测用的四个远端服务都存在。真机确认：打开面板即列出 Grok/Codex/Claude
   三行。有一条环境限制写在面板上：浏览器侧拿不到会话列表、也拿不到别的机器的
   页面，这两点面板如实说明而不是留白。

**事件怎么写回去（已就绪，但形状不能想当然）**

没有「往会话追加事件」这种通用服务——写入口只有会话对象自己的 append
（枚举过全部 ctx 属性确认）。而三类事件的调用形状**不一样，写错不报错**：

| 事件 | 形状 | 写错的后果 |
|---|---|---|
| 消息 | append(type, data, `{ surfaceOp: 'append' }`) | 标记必填 |
| 工具调用 | append(type, data) —— **不能带第三个参数** | 纯日志类型，带了会丢事件 |
| 工具结果 | append(type, data, `{ surfaceOp: 'append', sourceEventSeqs: [调用序号] }`) | 不引用就成孤儿，界面上配不上任何卡片 |

所以这些形状集中在 `makeContentWriter` 里决定一次，不在每个调用点各写一遍。
调用序号按「回合 + 调用标识」配对——回合号每回合重置，只按调用标识配会串到
上一回合去。

**权限请求（已就绪）**

走宿主的审批服务，它只有一个放行值 `allowed-once`；其余三个拒绝值、以后新增的
任何值、以及抛错，一律按拒绝处理。宁可拒绝错，不可放行错——猜错方向就等于
交出一项没人批准过的权限。

宿主在没有进行中的回合时会抛错，此时按拒绝处理而不是干等：等一个永远不会来的
回答是更糟的失败。

**没就绪（重要）**

0. ~~**两个配置字段现在配了也白配**~~（2026-10-10 更新：`models` 已接通并真机验证，
   见上面可选字段表；**`hosts` 仍未接**）。字段本身合法、启动不报错，`tests/wiring.spec.ts`
   的登记名单里 `hosts` 还在。接上之前不要指望它起作用。
1. ~~**汇总视图画出来了，但还没挂进 DSH 的槽位系统。**~~（2026-10-10 更新：已挂上。
   `packages/dsh-client` 以 `slots.inject('sidebar.panellist')` 注册了面板
   （面板名「各主机」），并在真实浏览器里确认面板出现——验证方法见下一节。
   ~~剩下的已知限制：**面板里的行是空的**~~——面板随后接通了真实数据。）
   **（2026-10-11 更新：用户决定各主机面板只列主机及基本信息，不再显示会话与
   项目；原先画「主机 → 项目 → 会话」树的 `RollUpPanel` 组件与树渲染代码已删除，
   第一张卡现在是「主机」列表。见 `docs/design/dsh-multi-host-migration.md` §8.3
   的覆盖记录。）**
2. **包里 `exports` 已配**（主入口 + 两个子路径），但**发布形态未定**：现在
   `main` 指向 TypeScript 源码，能被 Node 的类型剥离加载（约束见上一节），
   要发布的话应改成构建产物。
3. **真实宿主里验到对话，以及后来补上的「先建后选」路径。**

   已在真实 DSH（0.2.0-rc.2）上确认：插件能被加载、那一行能被 preset 注册表挂载、
   自报显示读的是投影而不是头部、启动没有失败诊断。

   一元调用的通道是 HTTP：`POST /api/<端点>`，`content-type: application/json`，
   信封是 `{ type: 'client-request', rpcId, method, payload: { args } }`，返回值
   形如 `{ type: 'server-response', rpcId, result: { ok, value } }`。（流式
   多路复用只收 `open`/`item`/`end`/`cancel`，一元调用走不了它。）拿到它就能在真
   机上建会话、发消息、看结果。

   **真机上验到的**：会话能在真 DSH 上按 preset 建出来（`session/create` 带上
   preset）、那一行认得它、接管发生、会话的步骤被换成外部 agent 的步骤、而且这个
   步骤**确实被调用了**。

   **真机查出来的三个问题，都已修**（详见代码注释）：preset 解析在投影还没写时就
   只能读到空，导致一个会话都认不出来；同一个解析有两处写法，会出现「认出来了又
   放弃接管」；入口只打了接管日志、没有真正装上步骤。三个都不报错、不留痕迹，
   表现完全一样：会话加载了、认出来了、宣布接管了，然后什么都不回。

   **grok 的接法本项目早就做过**（见 `docs/agent-acp/grok.md`，实现已转进通用层）：

   ```
   grok agent serve --bind 127.0.0.1:<port> --secret <secret>
   客户端：ws://127.0.0.1:<port>/ws?server-key=<secret>
   ```

   **密钥在查询参数里，没有 Authorization 头**，两处都必须对。那篇文档里还点名了
   一条我这次正好踩到的规矩：**就绪判定必须是真的握手，不是「端口开了」**——端口
   检查分不出「带密钥的 serve」和别的监听器。

   接对了之后真机跑通了一整轮：思考、回复、工具调用、结果配对、文件写入、终端执行，
   文件真的建在磁盘上、内容正确、来源标成 `acp-grok`。

   **「先建后选」路径也于 2026-10-10 真机跑通**：`session/create` 以 `standard`
   建出原生会话，`agentPresets/select`（参数名是 `agentId` + `agentPreset`）切到
   `acp-grok`，紧跟着发消息——回答来自 grok，会话投影里 `agentPreset` 变为
   `acp-grok`，实例日志出现接管行。修这条路径之前的真机表现是同样的操作必然走到
   原生线路并报缺 API key。

   真机上还查出第四个问题：**声明了文件能力却没实现**。终端有实现、文件没有，
   两个都在初始化时声明。grok 会先去够文件接口，失败了才退回终端——一次白费
   的往返，外加一条「本来可以用正经工具却去跑 shell」的行为。补上了文件实现。

   **权限应答**：桥接本身本项目早就实现过（`approval-bridge.ts`，claude / codex /
   grok 都走过），但**这一行根本没把它接上去**——写在内部，一律拒绝。不报错、不
   提示，外部 agent 于是显得什么都做不了。现在接上了，走宿主自己的审批服务，
   且只有「单次允许」才算同意。宿主没有审批服务时按老样子全拒，并在自报里写明
   `approvals=refuse-all`。

   用的是「顺带看一眼」而不是声明注入：声明注入的话，宿主没有审批服务时这一行会
   拒绝挂载，把所有会话一起带走。

   链路已经过真实客户端的测试（工厂造出来的那个客户端，不是替身）。**真机上没能
   触发**：试了删目录的命令，grok 自己的策略直接放行，没问。所以这一段仍然只有
   测试覆盖。

### 真机验证时踩到的一个坑

TypeScript 源码直接当插件装是有约束的：Node 的类型剥离模式**不支持构造函数
参数属性**（`constructor(private readonly x: T)`），遇到就报
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，而且表现是「那一行从未启动」——
启动日志里不显眼，要看启动诊断文件才看得到。

本仓库已把五处参数属性改成普通字段声明。若你把自己的包做成源码安装的插件，
避开这类「需要真正代码生成」的语法。

## 六、真机验证怎么做

`dsh` 支持叠一层补丁，不用改自己的配置：

```sh
dsh --profile web --patch ./my-presets.yml --port 3941 --no-open
```

`--patch` 必须在 `--profile` 之后、应用参数之前。装本地包用
`dsh plugin --profile web add ./packages/某包`。

启动后看两处：标准错误里插件自己的自报行，以及 `$DSH_HOME/logs/` 下有没有
启动诊断文件——有的话里面有「哪一行没启动」和具体原因。

## 跨主机汇总视图：已看见（2026-10-10 更新）

之前这一节写的是「装上了，但还没看见」：面板长什么样一次都没见过，原因是手头的
浏览器实例每个标签页一导航就自己关掉。今天换了一条路，看见并确认了：

- 启动清单（`window.__DSH_BOOT__`）里出现 `@threadharbor/dsh-client` 行，
  宿主按 rev 供应它的 `client.js`（HTTP 200，内含面板与槽位注册）；
- 真实 Chromium（playwright-core 驱动的无头实例）加载页面后，侧边栏文本里出现
  「插件 / 各主机 / 工作区」，面板渲染无脚本报错。

顺带记下浏览器的坑，和上次是同一个：导航到应用页的标签页会在约 100 毫秒内被关掉，
控制台什么都来不及输出（服务端响应链完全正常：303 + Set-Cookie + 200 HTML）。
解法不是修那个浏览器，而是换 playwright-core 直接驱动一份独立的 Chromium——
机器上 `~/Library/Caches/ms-playwright/` 里现成有下载好的浏览器，装个
playwright-core 就能用。

### 依赖对齐：0.1.x → 0.2.0-rc.2（2026-10-10）

这个包的客户端依赖从第一个提交起就写着 0.1.x，装到 0.2.0-rc.2 上会被 CLI 直接拒装。
根因不是版本号写错一位：**DSH 0.2 把 `@deepseek-ai/dsh-client-runtime` 这个包删掉了**，
客户端上下文变成 cordis 的 `Context`。包没了，依赖声明还指着它，于是这个插件永远对不
上宿主。

改掉之后：

- 去掉 `dsh-client-runtime`，上下文从 `@deepseek-ai/cordis` 取（DSH 自己的插件全都这么写）
- 其余四个客户端包对齐到 `>=0.2.0-rc.2 <0.3`
- 加上 `dsh-client-ui-renderer`（`ctx.slots` 是它提供的）和 `dsh-client-ui-sidebar`
  （两个槽位的类型由它给出）

**一处副产物值得记**：之前槽位名是在本地手写声明的，因为「运行时带 ui-sidebar，但没有
对应的包可以取类型」。对齐版本后 ui-sidebar 0.2.0-rc.2 直接可装，那份手写声明就删了，
接入点从「只挡拼写错误」变成由 DSH 自己校验。连带着六处 `as never` 强转全部不需要了
——那些转义当初只是为了让错的类型勉强通过。

验证：类型检查零错误（对着 DSH 0.2.0-rc.2 真实类型）；333 个用例通过；在一个全新的
DSH 配置下安装**不再需要版本放行**，真机加载无报错。渲染仍然没有验证——理由同前。

## 两处配置层面的坑（2026-10-10 端到端复验时踩到）

**一、示例里漏了 `presetId`。** 入口的配置要求它必填——注册表不会把 preset 放到上下文上，
没有它这一行就不知道自己属于哪个 preset，会去接管所有会话。照着文档里原来的示例抄，
会在启动时被配置校验挡下，报 `$.presetId missing required value`。上面的示例已补。

**二、`args` 已支持（2026-10-20 更新）。** 这条坑最初是真的：起子进程的 agent
那时只能给一个 `command`，没法带参数，端到端复验想用一个「握完手就在回合中途死掉」
的假 agent 时，连脚本路径都传不进去。现在配置里有可选的 `args`，显式写了就完全
接管命令行；不写时按 `agent` 补默认值（cursor 的 `acp --trust`、qoder 的 `--acp`）。
qoder 子进程还会剥掉 IDE 注入的 `QODER_*` / `CLAUDE*` / `VSCODE_*` 环境变量，
否则从 Qoder IDE 的终端启动会误判为 SDK worker 并直接退出。
