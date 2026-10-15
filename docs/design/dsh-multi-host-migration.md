# ThreadHarbor 迁移到 DSH 原生多主机架构 · 设计与实施方案

> 状态：阶段 1 已完成并固化为 §二；阶段 2 起待执行
> 核对时间：2026-09-14（初核）／**2026-10-09（复核，结论见 §二 各小节的「复核」小节）**
> 核对基准：`deepseek-harness` 官方 master `5badb15009`（复核确认未过期）；本机 DSH 0.2.0-rc.2；grok 1.0.46；codex-acp 1.6.0-grok.3；claude-agent-acp 0.76.0
> 修订：补入界面适配一章（§七）；更正 claude 支持状态的误述（§五）；**2026-10-09 复核推翻 preset 读取路径、补齐六条实施约束、新增 §2.6/§2.7**；**2026-10-11 §8.3 的「主机 → 项目 → 会话」三层分组被用户决定覆盖为只列主机（会话/项目不显示），会话读取与树渲染代码随之删除**
> 原型验证：ThreadHarbor `packages/dsh-grok-agent`，已对真实 grok 跑通；codex / claude 帧形状 2026-10-09 实测补齐

---

## 一、目标

把 ThreadHarbor 从「gateway + hostd + 独立 ACP 桥」的自研栈，迁移到「**每台机器跑一个 DSH，agent 由插件提供**」的架构，消除 hostd 这一独立监督进程。

迁移后应当成立：

1. 每台被管理的机器运行一个 DSH（含本机）
2. codex / grok / claude 作为 DSH 插件存在，不再需要 hostd 常驻
3. 界面按 **主机 → 项目 → 会话** 分组
4. 每台主机自报可用 preset、模型、设置，互不影响
5. 中途切换 agent 可用（历史完整交接）
6. 旧 hostd 路径在全部迁移完成前一直可用

> **2026-10-11 更新：第 3 条被用户后来的决定覆盖。** 各主机面板改为只列主机及
> 基本信息，不再显示会话与项目——用户真机看过后明确「会话列表在这个面板里没有
> 必要」。完整记录见 §8.3 的更新小节。

---

## 二、已核对的关键事实

以下每条都来自官方源码或真实运行，不含推测。新会话执行时请勿凭印象推翻，但若 DSH 升级需重新核对。

> **2026-10-09 复核**：官方 master 仍是 `5badb15009`，基准未过期，本节结论逐条重核过。
> 本次复核**推翻一条、修正一条归属、补齐六条实施约束**，并新增 §2.6 / §2.7（实测帧形状与两处机制更正）。
> 注意本机 DSH 运行版本 `0.2.0-rc.2` 落后于 master（master 已到 `0.2.1-alpha.1`），
> 阶段 3 接进 DSH 时要按**实际运行的那个版本**验证，不能拿 master 的行号当运行时事实。

### 2.1 关于 DSH agent 架构

| 事实 | 出处 | 影响 |
|---|---|---|
| 全仓唯一实现完整 `Agent` 能力的是 `ReactLoopAgent` | `packages/core/agent-loop/src/agent.ts:98` | 我们要做的是第二个实现 |
| `Agent` 是**开放接口**，可被任意插件实现 | `packages/core/agent/src/types.ts:15-18`（基接口本体）+ `runtime-types.ts:163-243`（合并声明） | 方案成立的前提 |
| agent 工厂位**只能占一个**，重复注册直接抛错 | `packages/core/agent/src/index.ts:358-360` | 不能靠注册第二个工厂接进去 |
| 工厂槽字段是 TS `private`，**不是** `#private` | 同上，`:247` | 运行时可读可改 |
| `createAgent` 里**写死** `new ReactLoopAgent(...)` | `packages/core/agent-loop/src/index.ts:576` | 没有构造器注入口 |
| `CreateAgentOptions` 里 `meta.agentPreset` **被 agent-loop 完全忽略** | 对 `packages/core/agent-loop/src/` 全包 grep `preset` **零命中** | preset 不参与选择实现 |
| 会话头里带 preset：**`session.header.agentPreset`（平铺，没有 `meta` 层）** | `packages/core/session/src/types.ts:130`（`SessionHeader`） | **可以在运行时按 preset 分流** |
| `turn()` 负责全部回合/步骤边界记账，把模型工作交给 `step()` | `packages/core/agent-loop/src/agent.ts:296-396` | `step()` 是唯一需要替换的接缝 |
| `step()` 返回 `StepEndReason \| null`，完成时返回 `{ kind: 'completed' }` | 同上 `:398`（签名）、`:530-538`（返回）；`TurnEndReason.completed` 见 session types `:202` | 替换契约极简 |
| `step()` 是 TS `private`，运行时只是原型方法 | 同上 | 可通过原型改写替换 |
| agent-loop 服务名是 `ctx.agentLoop` | `packages/core/agent-loop/src/index.ts:355` | 可用 `inject` 约束加载顺序 |
| `prepare` / `setupAndPublish` / `initializeAgent` **外部零引用** | 全在 `AgentLoop` 服务类（`index.ts:479/754/782`），排除自身文件后搜索零命中 | 但我们仍然选择不抄（见 §四） |

#### 2026-10-09 复核更正

**⚠️ 一条不成立，照原文写会让方案静默失效。**

原文写「会话头里带 preset：`session.header.meta.agentPreset`」。**真实路径是 `session.header.agentPreset`，平铺，没有 `meta` 这一层。**

- 原文引的 `packages/core/session/src/types.ts:158` 那行确实存在，但它属于 `CreateSessionOptions['meta']`，是**创建会话时传进去的入参**。
- 真实字段在 `:130` 的 `SessionHeader` 上，而 `SessionHeader` 根本没有 `meta` 字段。
- 旁证：`packages/bundle/headless/src/index.ts:193`（`let preset = header.agentPreset`）、`packages/subagent/subagent-in-process-driver/tests/preset-inheritance.spec.ts:104`。
- **按原文写会永远读到 `undefined` → 分流 100% 落空、静默走回原生实现、且不报任何错。** 这是阶段 3 最高优先级的更正。

**归属修正**：`prepare` / `setupAndPublish` / `initializeAgent` 不是 `ReactLoopAgent` 的方法，是 `AgentLoop` 服务类的私有方法。结论（零外部引用）不变。

#### 2026-10-09 复核新增：六条实施约束

以下六条原文没有，但直接决定实现怎么写。

1. **`ReactLoopAgent` 拿不到类引用。** 它没从 `index.ts` re-export，`package.json` 的 `exports` 也没有 `./agent` 子路径——`import { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'` 运行时是 `undefined`。
   唯一可行绕法是从活着的实例反查：`Object.getPrototypeOf(agent).constructor`。
   **代价：必须等第一个 agent 诞生才拿得到原型**，`inject: ['agentLoop']` 只保证加载顺序，不保证已有实例。

2. **`step()` 的返回值不控制循环。** 完整签名：
   ```ts
   private async step(decision: { kind: 'enter'; messages: UserMessage[];
                               startsRequestSeries?: true; assembly: PromptAssembly }): Promise<StepEndReason | null>
   ```
   `turn()` 调它时是 `this.step(decision)` 方法调用（`:338`），原型一改立刻生效。
   但返回的 `completed` **只写进 `turnEnds`，不决定步骤是否继续**——真正的开关是 inbox 里还有没有 next-step 输入（`:359`、`:363`）。**想提前收尾收不回来。**

3. **preset 是持久化字段**（`types.ts:124-129` 注释：恢复时必须读回同一 preset，否则会重放模型已无法处理的历史）。
   **好消息**——重启恢复后分流依然成立，不只新建会话有效。

4. **原型改写可行，且仓内有先例。** 类没被 freeze、无 `#private` 字段、调用点是方法调用；
   `packages/experimental/webworker-runtime/src/polyfill/async-context/async-context-hooks.ts:49` 就直接改写了 `Promise.prototype.then`。

5. **替代路径不可行。** 官方扩展点 `agent/pre-step` 水位线能 reject 整步，但 reject 只让回合以 `blocked` 结束，**接管不了这一步的模型工作**。所以改 `step` 是唯一路径，必须接受它是私有 API（仓内 AGENTS.md 明写 Public APIs are pre-stable）。
   **改写时务必保留原实现引用，未命中 preset 一律走官方路径**——这样上游改签名时受影响面收敛。

6. **`step()` 用的是 `this.loopCtx`（挂载作用域）不是 `this.ctx`**。外部实现要复刻原实现的写日志行为，可用字段是 `session` / `dispatch` / `inbox` / `id`（公开），其余 private 字段运行时可访问但 TS 里需断言。

### 2.2 关于会话事件词汇

DSH 会话日志能表达 ACP 的全部输出，无需扩展：

| ACP 侧 | DSH 侧 |
|---|---|
| 助手正文 | `assistant/message`（`text` 内容块，`packages/llm/llm/src/types.ts:62-65`） |
| 助手思考 | `assistant/message`（`reasoning` 内容块，同文件 `:67-71`） |
| 工具调用 | `tool/call { turn, step, callId, name, arguments }`（arguments 保持原始字符串，不解析；`packages/core/session/src/types.ts:361`） |
| 工具结果 | `tool/result { message: ToolResultMessage }`，message 含 `role:'tool'`、`source:{kind:'tool',callId}`、`toolCallId`、`isError?` |
| 回合/步骤边界 | `turn/start`、`turn/end`、`step/start`、`step/end` |

读日志的代码**明确容忍「没有 turn 事件的 agent」**（`packages/core/agent/src/types.ts:69-77` 中 `TurnBoundaryProjection` 注释：能力缺失 ≠ 数据损坏）。
但注释同时点名了例外：**没有安全回退的读者（文中举例 step-open decision）允许直接 fail loud**。外部 agent 若不发 turn 事件，要先确认依赖的读路径属于哪一类。

#### 2026-10-09 复核新增：三条 API 硬约束

1. **`tool/call` 是 5 个字段，`turn` / `step` 也必填**，不是原文写的 3 个。
2. **`message.isError` 是可选字段**（`packages/llm/llm/src/message.ts:179`）。外部 agent 的失败工具调用**必须显式填 `true`**，否则渲染成成功态。
3. **消息类事件的 `Session.append` 第三个参数 `surfaceOp` 必填**（`types.ts:439-444`、`:462-478`；取值只有 `'append'` 或 `{op:'replace';startSeq;endSeq}`）。
   另：`Session.append()` 同步返回已落库事件，但**不可重入**——上一次 append 还在发布时再调会抛（`index.ts:736-739`）。

### 2.3 关于模型列表（重要，修正早期误判）

- **DSH 原生 agent**：模型列表来自 `modelCatalog()`，是 **Host 级**能力（`packages/api/session-controller/src/index.ts:316-319`，路由名 `session/modelCatalog`），能实时查，不需要会话。实现注释原话就是 "Build the browser model catalog **without requiring a Session**"（`src/catalog.ts:14-23`），每次调用实时查、无缓存。
- **外部 agent（codex/grok/claude）**：模型列表**没有「列出模型」的公开接口**，只能从 `session/new` 的返回里拿。
  ⚠️ 原文说「只有 `session/new` 返回里才有」**偏窄**：DSH 侧实现在模型拓扑变化时还会主动推 `config_option_update`（`packages/acp/acp/src/session.ts:211-228`），所以会话存续期间也能拿到。

**结论**：外部 agent 的模型列表**只能在建会话时获得**。但由于我们的建会话流程本身就是「建会话时拿到模型」，所以**正常建会话路径不需要任何探测**。仅在「不建会话偷看另一台主机的模型」这一非主流场景才需要探测，且可复用已有会话缓存。

> ⚠️ **2026-10-09 实测补正：三家返回的形状并不相同**，详见 §2.6 结论二。原文 §六 与 §7.2-(3) 假设「建会话时拿到一份同构的模型列表」，对 claude 不成立。

### 2.4 关于中途切换 agent

DSH **硬拦**：`AgentPresetRegistry.select()` 检查回合边界，会话已开始即抛 `agent-preset/locked`（`packages/preset/agent-preset-registry/src/index.ts:346-352`，错误码字面量确认无误）。

**结论**：中途切换只能走「新会话 + 完整历史交接」。ThreadHarbor 现有 `session.switch` 已实现并测试，直接复用。

#### 2026-10-09 复核：锁的语义比原文更硬、也有前提

- **一旦有过任何回合就是永久锁死。** `lastTurn` 是历史累计值——`turn/start` 置它，`turn/end` 只清 `openTurnStartSeq`、**不动 `lastTurn`**（`packages/core/agent-loop/src/agent.ts:305/385`）。所以不是「回合进行中锁、结束就解锁」。
- **「硬拦」有前提。** 若 `turnBoundary` 投影没注册（agent-loop 不在场），`stateOf` 返回 `undefined`，`select()` **根本不进检查分支、直接放行**（`packages/session/session-projection/src/index.ts:319-327`）。
  投影出来的外部 agent 若不注册该投影，preset 反而是可以中途切的——**这可能是个机会而非只是注意事项**。
- `recompose()` 的 JSDoc 明写「是不是空会话由调用方负责」（`:329-334`），它自身不设防。

### 2.5 实测得到的 grok ACP 细节（读代码看不出来）

1. 连接地址是 `ws://host:port/ws?server-key=<secret>`，**不是** Authorization 头
2. 建会话前后有十余条 `_x.ai/session/setup` 阶段通知（auth / resolve_workspace / folder_trust / plugin_registry / mcp_merge / persistence_init / spawn_session_actor / agent_build / model_switch）与 `_x.ai/mcp/servers_updated`，**均非对话内容，必须过滤**
3. 回合过程中会发 `available_commands_update`，同样不是对话内容
4. 思考与正文是两种不同的更新类型，分别投影为 reasoning / text 内容块
5. `_meta.totalTokens` 携带 token 计数 → **跨 agent 交接会保留 token 数**（优于现有实现）
6. **工具调用有 bug 陷阱**：首个 `tool_call` 的 `title` 是工具身份（`run_terminal_command`），后续 `tool_call_update` 会把 `title` 覆写成人话描述（`Execute \`echo ...\``）。**工具名只能取首帧**
7. 工具输出是**双层嵌套**：`content: [{ type:'content', content:{ type:'text', text } }]`，需剥两层
8. **grok 对失败的工具也报 `completed`**，`isError` 只能忠实反映 grok 的状态，不能自行推断

### 2.6 2026-10-09 新增：codex / claude 的实测帧形状

以下全部来自本机真实运行（`codex-acp`、`claude-agent-acp@0.76.0`）。抓帧工具与原始帧存于本仓 `.superpowers/sdd/dsh-multi-host-migration/`。

**结论一：工具身份字段三家三个位置 —— 照抄 grok 必错。**

| agent | 工具名在哪 | `title` 里是什么 | 输出在哪 |
|---|---|---|---|
| grok | `title`（首帧） | 工具身份 | `content`，**双层嵌套** |
| **codex** | `kind: "execute"`（**没有工具名**） | 人话命令（`ls -la\nfind ...`） | `rawOutput.formatted_output`，**根本没有 `content` 字段** |
| **claude** | `_meta.claudeCode.toolName`（如 `Bash`） | 人话描述 | `content` **双层嵌套**（同 grok）+ `rawOutput` |

照抄 grok 的两条规则会同时失效：「工具名只取首帧」会把整条命令渲染成工具名；「剥两层取输出」永远取到空串，**codex 的工具输出全丢**。

**结论二：模型列表三种形状，claude 最特殊。**

| agent | `session/new` 返回 |
|---|---|
| grok | `{ sessionId, models: { currentModelId, availableModels[] } }` |
| codex | `{ sessionId, models: { availableModels[] } }`（无 `currentModelId`） |
| **claude** | `{ sessionId, modes, configOptions }` —— **顶层没有 `models` 键**；模型在 `configOptions[]` 中 `id:"model"` / `category:"model"` 的那一条（`type:"select"`, `currentValue`, `options[]`） |

§六 与 §7.2-(3) 的「建会话时拿到模型」对 claude 需要换数据源，实现难度高于预期。

**结论三：token 计数三家不同源。**

- grok：`session/update` 的 `params._meta.totalTokens`。
- codex / claude：`session/update` 上**完全没有 `_meta`**，改由 **`session/prompt` 的响应**携带 `{ stopReason, usage: {...}, _meta.quota.token_count }`。
- 另有 `usage_update` 帧（codex 2 次 / claude 5 次），字段是 `{used, size}`——这是**上下文窗口占用，不是计费 token**，别当 token 数用。

**结论四：必须过滤的非对话内容帧。**

- 三家都有：`available_commands_update`、`usage_update`、`_auth/status_update`。
- codex 独有：`session_info_update`（`_meta.codex.threadStatus`）。
- ⚠️ **`_auth/status_update` 会带用户邮箱**（实测 codex 那次为 `{"kind":"account","email":"goodjin2@gmail.com","plan":"pro"}`）。不过滤会把邮箱写进会话日志。

**结论五：思考帧只有 claude 确认发出。** claude 实测 112 帧 `agent_thought_chunk`；codex 本次未出现（`thoughtTokens: 0`），**待确认 codex 是否支持**。

**结论六：权限请求帧形状（ACP 标准方法，三家同构）。**

```
{ method: "session/request_permission", id: <请求自带 id>,
  params: { toolCall: { toolCallId, name, status:"pending", rawInput, title, kind, content, locations[] },
            _meta: { permission: { version, title } },
            options: [ {optionId:"allow-once",        kind:"allow_once"},
                       {optionId:"allow-with-updates", kind:"allow_always"},
                       {optionId:"reject",            kind:"reject_once"} ],
            sessionId } }
```

**⚠️ 实测踩到的坑：应答必须回带同一个 `id` 的 JSON-RPC 响应帧。** 用通知帧应答会被静默接受，然后回合**挂死 240 秒**不返回——不报错、无超时提示。

另注：权限请求帧里工具名在 `toolCall.name`，而同一 agent 的 update 帧里在 `_meta.claudeCode.toolName` —— **claude 自身内部就不一致**，提取器不能只认一处。

**触发条件三家不同：**

- claude 默认 `currentModeId: "bypassPermissions"`（**默认永远不问**），必须先 `session/set_mode` 切到 `default`（Manual）才会触发。
- codex 取决于 `approval_policy`（取值 `"on-request"` / `"never"`），**本机这个构建默认是 `"never"`**，所以实测 0 次请求——是默认值问题，不是抓帧方法问题。相关配置项 `sandbox_mode`（`read-only` / `workspace-write` / `danger-full-access`）。
- grok 未触发，待验。

> **诚实标注**：本机 claude **不是真 Anthropic Claude**。`~/.claude/settings.json` 里 `ANTHROPIC_BASE_URL` 指向 `codeplan.iquestlab.com`、`ANTHROPIC_MODEL=iquest-q1`、`primaryApiKey: "any"`，是公司中转。
> 所以 claude 那份抓帧的**帧形状来自真实的 `claude-agent-acp@0.76.0` 适配器**（这正是投影依赖的部分，形状结论成立），但**背后模型不是 Claude**，模型名相关的内容不代表 Claude 真实行为。
>
> 另：本机 codex-acp 是 `1.6.0-grok.3`（软链到 `~/github/codex-acp` 本地分叉），而 hostd 里 pin 的是 `1.6.2`。codex 的帧形状取自分叉版本，**阶段 2 落地前需在 pinned 版本上复验**。

### 2.8 2026-10-09 新增：两条会推翻原设计的事实

（**核对时间 2026-10-09，参考源码 master `5badb15009`，并与在跑的 0.2.0-rc.2 逐条对过**）

#### （1）会话头里的 preset 是**创建时的值**，会过期

`session.header.agentPreset`（`packages/core/session/src/types.ts:130`）记的是会话**建立时**
用的 preset。空白会话可以在之后换 preset（`agent-preset-registry` 的 `select` 会追加一条
`agent-preset/selected`），此时**头里的值不再反映当前实际在跑的是哪个 agent**。

DSH 自己的代码也不读头。`session-controller` 读的是投影
`ctx.sessionProjections.stateOf(session, 'agentPreset')`
（`packages/preset/agent-preset-registry/src/session.ts:34-44`，该文件开头的注释解释了
为什么必须读投影；消费方先例 `session-controller/src/agent.ts:360-362`）。

**对本次迁移的影响**：分流器不能只读头。读头在「会话建立后再换 preset」时会接管错的对象——
按旧 preset 去接一个已经换成别的 agent 的会话，或者更糟，对一个原生会话做 ACP 处理。

#### （2）模型目录是**按 Host 代次全局共享**的，没有按会话改的缝

`@Remote('modelCatalog')` → `buildModelCatalog`（`session-controller/src/index.ts:313-319`）
读的是 `ctx.llm.listProviders()` / `listModels()`，即**已注册适配器的全集**。
源码注释写得很直白：「shared by every Session selector」「for Host-generation selectors」。

**没有按会话换这份列表的缝。** 已检索 session-controller、ui-model-selection 与 llm 注册表
未找到。（此为「检索后未找到」的推断，非直接证据。）

按会话存的只有**选中项**：`selectModel`（`session-controller/src/index.ts:289-292`）
→ `installModelSelection`，由 agent 作用域的 `agent/request` 瀑布在发请求时套用
（`agent/src/model-selection.ts:81-132`）。

**对本次迁移的影响**：§十 阶段 3 的「输入框模型选择器在 ACP 会话下改读各家模型列表」
按现在的设计**做不到**。要改这份列表，只有两条路，都是全局或客户端侧的：

1. **客户端侧**替换 `ui-model-selection` 贡献的那两处（`/model` 弹层 + 输入框座位）；
2. **全局侧**注册一个适配器，或替换 session-controller 那一行。

要改「某会话实际走哪个模型」，则走 `agent/request` 瀑布——这条是按会话的，明确可行。

**已决（2026-10-09）：走「agent 当 provider」这条路，见下面（3）。**


#### （2b）配置怎么到达前端：已有现成机制（2026-10-09 核对）

**插件配置本身**走 Cordis 的 `Config` schema——函数插件导出 `Config` 后，
入口签名变成 `apply(ctx, config)`（先例：`packages/acp/acp/src/index.ts:86` 的
`export const Config` 与 `:97` 的 `apply(ctx, config)`；这是仓内现成的范例）。

**但配置要送到浏览器那一半，走的是另一套**。客户端插件是「两半」结构
（范例 `packages/client/ui-model-selection/`）：

- **宿主那半**：`src/index.ts` 里的 `apply(): void {}` 是空的，作用只是让这个
  包出现在宿主 `cordis.yml` / Loader 里。
- **浏览器那半**：`exports["./client"]` 指向浏览器包，靠包清单里的
  `dsh.client` 声明被发现（`inject` 列出客户端依赖，`platform: "web"`）。

**客户端读配置的方式**：`ConfigForm<T>`，从 `ctx.configForms.get(entryId)` 取
（`packages/client/ui-settings/src/client/config-form-types.ts:39`；
取用入口 `config-form.ts:293`）。宿主插件在自己那半注册一个设置命名空间，
浏览器那半通过这个表单读写。表单自带：

- `getSnapshot()` / `subscribe()` 观察；`set()` / `mutate()` 写入；
- `revision` 版本栅栏与宿主校验；
- **`mode: 'host' | 'memory'`**（`:34`）——`'host'` 跟随宿主文档，
  `'memory'` 只在**远端浏览器进程内**保留。

**⚠️ 但要分清两种「配置」**（取证补正，2026-10-09）：**组合行的 `config:` 到不了
前端**。浏览器端的启动行只有 `{ id, inject, immediately }`，没有 config 字段
（`packages/client/modules/src/client/manifest.ts:111-117`；创建 entry 时只传
`{ name: id }`，`entries.ts:167-175`；启动循环只映射 `row.id`，`boot-client.ts:48-50`）。
所以 `ConfigForm` 这条路属于**设置通道**，不是组合配置通道。

三条能到前端的通道：

1. **宿主那半收配置后，经 `webserver/index-inject` 事件注入每个标签页的启动
   HTML**（事件声明 `packages/host/webserver/src/index.ts:26-34`；实例
   `packages/client/ui-theme/src/index.ts:41-43`）。
2. **settings 远程命名空间** `ctx.remote.settings`
   （`packages/api/settings-controller/src/index.ts:86`），Volatile 字段双向同步
   （例：`agentPresets` 的 `selectedDefault`，`agent-preset-registry/src/index.ts:56,75`）。
   `ConfigForm` 就是它前端那一侧的形态。
3. **构建期 `process.env.DSH_CLIENT_*`**——静态烧进 bundle，运行期不可变。

**对本阶段的意义**：`hostId`/`hostTitle` 属于「这台机器是谁」，走**设置通道**
（上面第 2 条）的 `'host'` 模式，由宿主插件注册命名空间、客户端通过表单读。
版本栅栏与校验都是现成的，比自造一条通道省事。

**⚠️ 但这和本阶段另做的一套按主机隔离的本地设置不是一回事**：
后者对应的是纯界面偏好（现有代码刻意不往服务端回传，见
`packages/dsh-client/src/client/display-preferences.ts:1-3`），仍应留在
localStorage，只是要按主机分开槽位。两者分工：身份与共享配置走 `ConfigForm`，
界面偏好走本地存储。

---

#### （2c）多主机：DSH 没有主机身份概念（取证，2026-10-09，master `5badb15009`）

**结论：DSH 全仓库没有「我是哪台主机」的概念。** `hostId`/`hostTitle`/
`machineId`/`machine-id` 零匹配。web 侧只有 `RemoteHostFacts { home, isLoopback }`
（`packages/api/gateway/src/client/index.ts:119-124`，经 `ctx.remote.$host` 暴露），
而 `home` 服务端取 **`os.homedir()`**（`packages/api/remotes/src/index.ts:3,42`），
**是操作系统账户家目录，不是实例身份**——同机多 home 才不同、同 home 多端口不可区分。

启动时能自报的只有：原始 argv（`packages/boot/cmdline/src/index.ts:86`）、
五个 web 旗标（`bundle/web-app/src/startup.ts:25-39`：host/port/public-url/
trusted-host/no-open，注意 `--host 0.0.0.0` 被显式拒绝，只支持 127.0.0.1）、
OS 分配后的实际端口（`host/webserver/src/index.ts:141`）、`$DSH_HOME`、匿名 id。
**没有任何机器级标识。** 最接近的是 per-`$DSH_HOME` 的匿名 UUID
（`packages/identity/anonymous-user-id/src/index.ts:2-9`），注释明确不派生自主机名。

**连接标识也不能用**：服务端每个事件代重新铸一个 `RemoteEventClientId`
（`packages/api/gateway/src/index.ts:504-505`），客户端 `generation.id` 只是页面内
自增计数（`client/connection/src/client/index.ts:212,288`）——重连即换、刷新归零。

**但「项目」概念是现成的：Workspace 就是。** README 原话就是 project sidebars；
`WorkspaceView { workspaceId, path, title, sessionIds, createdAt, updatedAt }`
（`packages/api/workspace-controller/src/types.ts:14-24`），远程命名空间 `workspace`
提供 create/list/rename/delete/排序/pin/archive（`src/index.ts:65,85-184`）。
**聚合层的「项目」直接映射到 Workspace，不需要自造。**

**preset 按主机过滤零改动**：registry 是扁平 Map，注册与查找 API 都无作用域参数
（`agent-preset-registry/src/index.ts:81-101,177-198`），但每个进程一份，
**跨主机天然隔离**，在聚合层按主机分组即可。

**现成的缝**（不必造）：

- 按主机分叉设置的持久化选择：`ctx.remote.$host.isLoopback ? 'host' : 'memory'`
  （`packages/client/ui-settings/src/client/index.ts:39`）；`$host.home` 可当主机键
  的一部分。
- 跨主机连接信任：`--trusted-host` 旗标（`bundle/web-app/src/startup.ts:63`，
  校验在 `client/connection/src/api-request-trust.ts:103`）。
- 配置传到前端：见（2b）的三条通道。

**必须自己造**：`hostId`/`hostTitle`（`home` 不够用——见上）；跨标签页/跨主机聚合
（webserver 是单主机 BFF，**无注册发现机制**）；页面稳定标识。

**版本敏感性**：行号以 master（`5badb15009`，0.2.1-alpha.1）为准。运行版
0.2.0-rc.2 的 app.asar 只能做 strings 存在性探测（`RemoteEventHostInfo`、
`workspaceRegistry`、`agentPresets`、`anonymous-user-id`、`webserver/index-inject`
全部命中），**字段级差异只能从运行时 JS 推断，未能核对**。

---

#### （3）把外部 agent 当作 provider 塞进全局目录 —— 可行，但切换有硬限制

**塞进目录：可行，且界面不用改。** `LlmAdapter` 的 `listModels` 文档写明：
「Adapters used there must advertise their available models; the base empty catalog
offers no GUI selection」（`packages/llm/llm/src/index.ts:240-248`）。也就是说
**只负责展示、不真正跑推理的适配器是官方认可的用法**。为每个外部 agent 注册一条
provider 路由、列出它真实的模型，目录和界面自动就多出这几组，UI 形态与原生一致。

**⚠️ 但 `LlmAdapter` 有抽象方法 `stream`（`:290`）必须实现。** 外部 agent 的回合
根本不走 `stream`（由改写后的 step 接管），所以这个方法**永远不该被调用**。
一旦被调用，说明接管没生效——那时**必须响亮报错**，不能假装跑通。
这正好是一个自报状态的入口。

**切换：有硬限制，且比设计文档设想的更严。**

- ⚠️ **澄清一处容易混淆的地方**：文档 §十 阶段 5 说的 `session.switch`
  是 **ThreadHarbor 自有的协议方法**，确实存在且有测试
  （`packages/dsh-gateway/src/index.ts:925`，测试 `gateway.spec.ts:3202/3253`，
  协议枚举 `packages/protocol/src/index.ts:562`，客户端调用
  `packages/dsh-client/src/client/store.ts:2204`）。**它不是 DSH 的 remote。**
- **DSH 侧没有 `switch` 这个 remote。** session-controller 的 remote 全表见
  `packages/api/session-controller/src/index.ts`：
  `list / search / create / selectModel / modelCatalog / openWorkspacePath /
  workspacePathApplications / rename / fork / prompt / attachment / updateQueue /
  cancel / page / projections`，没有 switch。
  换句话说，阶段 6 下线 hostd 后，ThreadHarbor 那条切换路径的**后端会消失**，
  必须按 DSH 的接缝重做——而唯一现成的入口就是下面这个被锁的 `select`。

- DSH 侧实际存在的切换入口是 `agent-preset/select`
  （`packages/preset/agent-preset-registry/src/index.ts:347-362`），而它**在会话
  已经开始回合后会抛错**：

  ```
  agent-preset/locked — 'This session has already started'
  ```

  判据是 `turnBoundary.openTurnStartSeq !== null || boundary.lastTurn > 0`。

**因此：**

| 场景 | 能否自动切换 | 走哪条路 |
|---|---|---|
| 新会话（尚无回合） | ✅ 可以 | `create` 带上 preset，或空白会话上 `agent-preset/select` |
| 同一 agent 内换模型 | ✅ 可以，不切 | `selectModel`（按会话，且是全局目录里的同一组） |
| 已有回合的会话换 agent | ❌ 内置被锁 | 只能 `fork` 成新会话（`fork` 复制事件前缀到**新**会话），或自行实现切换 |

**这与 §十 阶段 5「报错而非静默截断」的要求是一致的**：锁住时明确报
「这个会话已经开始过，不能直接换 agent」，并提供「另存为新会话」这条路，
而不是把历史悄悄截断。

---

**原始备注：**「按会话换列表」与「全局换列表」
的用户可感知后果完全不同：前者 ACP 会话只看到各家的模型、别的会话不受影响；
后者所有会话的模型列表都变。

---
### 2.7b 2026-10-09 新增：ACP 回合复刻流式观感的完整契约

（**核对时间 2026-10-09，参考源码 master `5badb15009`**）

要满足 §7.2-(1) 的「恢复流式观感」，ACP 回合必须复刻下面这套，缺一样都会退化成
「等半天整段出现」。证据在 `packages/core/agent-loop/src/assistant-stream.ts`、
`packages/core/agent/src/runtime-types.ts:363`、`packages/llm/llm/src/types.ts:452`。

| 项 | 事实 | 位置 |
|---|---|---|
| 事件 | `agent/assistant-stream`（emit 模式），载荷 `{ agent, frame }` | `runtime-types.ts:363` |
| 帧种类 | `start` / `chunk` / `end` 三种 | `runtime-types.ts:127-161` |
| attemptId | `` LlmAttemptId(`${sessionId}:${attempt}`) ``，attempt 为挂载期内会话内计数 | `assistant-stream.ts:45` |
| revision | **整个 agent 生命周期内单调递增**，换流不归零 | `assistant-stream.ts:52,65,92` |
| chunk.index | 本次尝试内从 0 起**稠密**递增 | `assistant-stream.ts:67` |
| settle 顺序 | **先 `append()` 同步落盘拿 `seq`，再发 end 帧**带 `{kind:'committed', eventType, seq}`；落盘失败发 `{kind:'abandoned'}` 并抛出 | `assistant-stream.ts:78-97` |
| StreamChunk | `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish` | `llm/src/types.ts:452-464` |

**⚠️ 三处容易做错的地方：**

1. **revision 不是每回合从 1 开始**，而是挂在 agent 上活过整个生命周期。
   每回合新建计数器会导致界面把新回合当成替换流重画。
2. **settle 的落盘必须早于结束帧**。反过来会让界面显示「结束」却查不到内容。
3. **流式 ≠ 多写日志**。通道上增量、日志里**一条**最终 `assistant/message`，
   两者靠同一个 attemptId 对上（注释明写：分片临时，循环在提交结束帧前
   把一条最终消息按同一次流落盘）。

**已知难点**：`push()` 内还挂了 accumulator 与 assembler（压缩与工具调用组装），
自研复刻必须对齐它们的语义，否则跨分片的工具调用会组装错。
**这一项单独排一轮做，不与其他改动混在一起。**

---

### 2.7 2026-10-09 新增：流式与审批的两处机制更正

**（1）「流式记录」不存在 —— §7.2-(1) 的措辞必须改。**

原文写「原生循环逐块产出，用 DSH 的流记录机制」。**前半对，后半错：没有「增量追加内容」的会话日志机制。**

`assistant/message` 是流被消费完之后**一次性** append（`packages/core/agent-loop/src/agent.ts:520-529`）。

流式来自**另一条完全独立的通道** `agent/assistant-stream`：**进程内、不落盘**（类型 `packages/core/agent/src/runtime-types.ts:127-161`，事件名 `:363`，发射点 `packages/core/agent-loop/src/assistant-stream.ts:60-71`，经 SessionController 走 follow 传输下发 `packages/api/session-controller/src/types.ts:563`）。

> **准确表述**：历史与静态渲染完全复用 DSH 原生界面；**实时流式需要自己接一条 `agent/assistant-stream` 通道**，并接受「这些帧不落盘，重启/重连后靠 baseline 补齐」。
> 只写日志的外部 agent，UI 必然「等半天整段出现」——但成因**不是缺一个增量接口，是增量在另一条通道上**。

**（2）审批必须在打开的 turn 内部发起。**

`ApprovalService.request()`（`packages/interaction/user-approval/src/index.ts:215`）硬检查 `hasOpenTurn(session)`，不在打开的 turn 内直接抛错（`:217-223`）——理由是回合是持久日志的提交/重放边界，回合之间落的裸事件在重载时和崩溃尾巴无法区分。

策略恰好两个值 `'ask' | 'never'`（`:67`、`:70`），原文说对了。`request()` 自动 append `approval/asked` + `approval/decided` 审计对。
结果闭集：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，其中 `unavailable` 是 fail-closed 值。
`approval/request` 是 waterfall 事件——外部 agent 既能发起审批，也能自己挂 listener 当 answerer。

**§7.1 的结论需要限定**：会话事件这一层确实可以完全复用；**流式渲染那一层不是从日志来的**。

---

## 三、总体架构

```
┌─────────────────────────────────────────────┐
│ 本机 DSH（Gateway / 界面宿主）                │
│  ├─ ThreadHarbor UI 插件（主机树、会话树）     │
│  ├─ ACP agent 插件（按 preset 分流）          │
│  └─ agent-loop 原生（dsh preset 走这里）       │
└─────────────────────────────────────────────┘
        │  DSH 原生 remote 机制
        ▼
┌─────────────────────────────────────────────┐
│ 远端主机 DSH（每台一个）                       │
│  ├─ ThreadHarbor UI 插件（可只读投影）         │
│  ├─ ACP agent 插件（grok/codex/claude）        │
│  └─ agent-loop 原生                           │
└─────────────────────────────────────────────┘
```

要点：

- **不再有 hostd**。它看护 agent 进程、管理会话、把事件推给界面的职责，由 DSH 插件系统承担。
- **不再有 gateway 自研会话存储**。会话归各自主机的 DSH。
- 主机身份由我们的代码携带（见 §七），不依赖 DSH——DSH 的 `RemoteHostFacts` 只有 `home` 和 `isLoopback`，**没有主机身份**。

---

## 四、ACP agent 接入方案（方案乙）

### 4.1 为什么选这条路

三种接法对比：

| 方案 | 代码量 | 风险 |
|---|---|---|
| 甲：接管工厂，抄生命周期 | ~300 行 | 漂移风险集中在被抄的 300 行，官方一改就得对 |
| 乙：原型改写 + 按 preset 分流 | ~130 行 | 依赖一个私有方法的契约；失败时立刻报错 |
| 丙：纯工厂包裹 | ~30 行 | 生命周期仍要自己写，绕回甲的问题 |

**选乙**：被抄的代码越少，漂移面越小。

### 4.2 实际做法（比原计划更简洁）

原计划是「包装工厂位 + 继承 agent」。核对后发现**连工厂都不用碰**：

`session.header.meta.agentPreset` 运行时可读，所以：

1. 在插件加载时改写 `ReactLoopAgent.prototype.step`
2. 改写后的 `step()` 先看 `this.session.header.meta?.agentPreset`
3. 命中 ACP preset → 走 ACP 转发路径；未命中 → 调用原实现

**收益**：

- 不碰工厂位 → 无加载顺序依赖，无 `inject` 约束
- 不抄生命周期 → 收件箱、取消、空闲等待、作用域销毁、通知顺序全部原生
- 原生 agent 走原路径，**零行为变化**

### 4.3 ACP 路径的职责

替换掉的 `step()` 需要做：

1. 从 `decision.messages` 取出用户文本（**只取新增部分**，不重发历史——外部 agent 自己记历史）
2. 发送 ACP `session/prompt`
3. 收集期间到达的 `session/update` 帧
4. 用已验证的投影逻辑翻译成 DSH 会话事件并 append
5. 返回 `{ kind: 'completed' }`

**回合/步骤边界由原生 `turn()` 记账**，我们不重复发。

### 4.4 ACP 生命周期挂载

ACP 连接（`grok agent serve` 进程 + secret + sessionId）按 sessionId 惰性建立，与 agent 实例解耦：

- 首次 `step()` 时确保连接与原生会话存在
- 连接失败 → 按回合失败记账，不崩宿主
- 进程退出/重启后按 sessionId 重建；原生会话若已丢失则用 transcript 重建（复用现有 seedContext 思路）

### 4.5 已验证的部分

`packages/dsh-grok-agent/` 已完成并对真实 grok 验证：

- ACP 连接与握手（`initialize` protocolVersion 1 → `session/new`）
- 帧 → 会话事件投影（含工具名不被覆写、双层输出解包、token 计数保留）
- 7 个回归测试，用的是从真实 grok 抓下来的帧
- 全仓 520 个测试通过，类型检查干净

**执行时**：直接复用，不要重写。

---

## 五、多个 agent 的接入

### 5.1 统一抽象

每个外部 agent 实现同一套接入：

| 组成 | 职责 |
|---|---|
| Transport | 如何连（stdio / WebSocket） |
| Handshake | `initialize` + `session/new` |
| FrameProjection | `session/update` → DSH 会话事件 |
| Lifecycle | 进程拉起、secret 管理、重连 |

### 5.2 三个 agent 的差异

| agent | 连接方式 | 特有事项 |
|---|---|---|
| **grok** | `grok agent serve` + WebSocket + `server-key` | 已实测；阶段通知多需过滤；工具失败仍报 completed |
| **codex** | `codex-acp` 子进程 stdio | ThreadHarbor 已支持，接入层需新写 |
| **claude** | claude 的 ACP 适配器进程 | **ThreadHarbor 已支持**；接入层需新写 |
| **CodeBuddy**（WorkBuddy 内置） | `codebuddy --acp` stdio，或 `--serve` 走 HTTP SSE | 已实测；**支持 HTTP 传输，多主机友好**；模型带 `credits` |
| **Qoder**（QwenWorkCN 内置） | `qoderclicn --acp`（隐藏开关） | 已实测；`session/new` 额外返回 `modes` / `configOptions` |

**重要更正**：本项目**已经支持 claude code 的 ACP**，迁移时 claude 不是从零开始。此前误以为它不支持会话，来源是读错了测试桩——真实代码里 `sessionCapable` 对 claude 取的是「claude 的 ACP 适配器是否装在这台机器上」，装了就为真，与「支不支持会话」无关。

因此三个 agent 的迁移起点是一样的：**ThreadHarbor 侧都已有可用的 ACP 通路**，要搬的是把它们接到 DSH agent 接口上，而不是实现 ACP 本身。

**grok 之外的两个仍需核对真实帧形状**（协议细节与 grok 不同，不能照抄）。

### 5.3 preset 注册

每个 agent 注册为一条 preset（`AgentPresetDefinition` = `id` + `name` + `plugins` 的 Cordis 组合）。

**preset 按主机独立**：DSH 的 preset 注册表本就是每进程一份，远端 DSH 只注册自己实际装了/登录了的 agent。因此**未装 codex 的主机不会显示 codex preset**，天然满足需求。

### 5.3b 第三方 agent 的 ACP 现状（2026-09-14 实测）

判据是**能否完成 ACP 握手**，不是包体里有没有相似字符串，也不是 help 里有没有写。

#### 关键区分：桌面壳 ≠ 内置的 agent

`WorkBuddy` 与 `QwenWorkCN` 都是**桌面壳应用**，各自内置了另一个独立 agent 的 CLI。二者是不同产品，**ACP 属于被内置的 CLI，不属于壳**：

| 桌面壳 | 标识 | 内置的 agent CLI |
|---|---|---|
| WorkBuddy | `com.tencent.workbuddy.mac` v5.7.6 | **CodeBuddy**（`codebuddy` / `cbc`，`@genie/agent-cli`） |
| QwenWorkCN（千问 Work） | `cn.qwenwork.desktop.mac` v0.1.0 | **Qoder**（`qoderclicn` v1.0.47） |

已核实：**两个壳自身的代码里都没有 ACP 方法**，ACP 是内置 CLI 提供的。

#### 总表

| agent | 来源 | ACP | 传输 | 模型列表来源 |
|---|---|---|---|---|
| **grok** | 独立 CLI | ✅ 已验证 | WebSocket（`grok agent serve`） | `session/new` → `models` |
| **codex** | 独立 CLI | ✅ ThreadHarbor 已支持 | stdio | — |
| **claude** | 独立 CLI | ✅ ThreadHarbor 已支持 | stdio | — |
| **CodeBuddy** | WorkBuddy 内置 | ✅ **实测通过** | **stdio + streamable-http** | `session/new` → `models`（含 `credits`） |
| **Qoder** | QwenWorkCN 内置 | ✅ **实测通过** | stdio | `session/new` → `models` + `modes` + `configOptions` |
| **Cursor** | 独立 CLI（`agent acp`） | ✅ 官方支持 | stdio | 官方文档未列 `session/new` 的模型列表 |
| WorkBuddy | 桌面壳 | ❌ 自身无 | — | — |
| QwenWorkCN | 桌面壳 | ❌ 自身无 | — | — |
| MiniMax Code | Electron 桌面 | ❌ | — | 无 ACP 标记，只有连接器工具 CLI |
| Doubao / DoubaoWork | Chromium 桌面 | ❌ | — | 非 Electron 打包 |
| zcode | Electron 桌面 | ❌ | — | 见 §5.4 |

#### CodeBuddy（腾讯）— 推荐优先接入

- 入口：`/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`（别名 `cbc`）
- `--acp`：以 stdio（ndJsonStream）进入 ACP 模式
- `--acp-transport`：`stdio`（默认）或 **`streamable-http`**
- `--serve` + `--port/--host/--auth`：起 HTTP 服务，**ACP 走 HTTP SSE**
- 握手实测通过；`initialize` 报告能力含 `loadSession` / `delegateToolsSupport` / `multitaskSupport`
- 会话中推送 `config_option_update`（与 ThreadHarbor 现有处理一致）
- `session/new` 返回真实模型列表，每项带 `supportsImages` / `supportsReasoning` / **`credits`** / `maxInputTokens`
- **对多主机最有价值**：支持 HTTP 传输，远端 DSH 可直连，不必依赖本机 stdio

#### Qoder（阿里）— 可接入

- 入口：`/Applications/QwenWorkCN.app/Contents/Resources/bin/qoderclicn`
- `--acp` 是**隐藏开关**（help 不显示，二进制里有 `"--acp","Starts the agent in ACP mode"`）
- 握手实测通过
- `session/new` 返回 `{ sessionId, modes, models, configOptions }`：
  - `modes`：`default` / `acceptEdits` / `bypassPermissions` / `plan` → 对应 DSH 的审批模式
  - `models`：如 `qmodel_38max`「Qwen3.8-Max（默认）… **0.50x Credit**」

#### Cursor — CLI 有官方 ACP，桌面版没有

**（1）桌面版无 ACP。** Cursor.app 3.24.9 全包检索，`session/new`、`session/prompt`、`agentclientprotocol`、`agent-client-protocol` 全部为 0。（`sessionUpdate` 有命中，但上下文是语音功能的 `sessionUpdateFrame()` / `speakGreeting` / `playbackDrains`，与 ACP 无关。）

**（2）CLI 有官方 ACP。** 见 <https://cursor.com/docs/cli/acp.md>：`agent acp`，stdio + JSON-RPC 2.0 + 换行分隔。流程与 grok 一致：`initialize` → `authenticate` → `session/new`（或 `session/load`）→ `session/prompt`，期间处理 `session/update`，权限走 `session/request_permission`。

**（3）与桌面版的关系：同一套 worker，但没有独立会话库。**

| | 证据 |
|---|---|
| 同一套 worker | 桌面版 globalStorage 下有 `cursor-agent-worker` 进程目录（152MB/204 项）；`~/.cursor/agent-cli-state.json` 按项目路径记录 workerId |
| 无独立会话库 | `~/.cursor` 下**没有**任何 chat/conversation/session 文件；会话正文在桌面版 globalStorage（`state.vscdb` 的 `glass.agentConversationPanes.*` 键 + `conversation-search.db`，436 条） |

`session/load` 官方说明是「恢复已有对话」。**CLI 能否直接加载桌面版建的会话，尚未实测**——需要先装 `agent` 再验，不做无根据断言。若能，则 Cursor 是「接进来就能看到桌面版历史」的一家，与 CodeBuddy（登录态与数据都分离）情况相反。

**（4）接入 Cursor 时的四个要点**

- **鉴权**：`cursor_login` 方法，或启动前 `agent login`、传 `--api-key` / `CURSOR_API_KEY`、`--auth-token` / `CURSOR_AUTH_TOKEN`。
- **权限请求是阻塞的**：`session/request_permission` 必须回 `allow-once` / `allow-always` / `reject-once`，**不回则工具执行卡住**。这正面印证了 §7.2-(2)「权限桥接必做」不是纸上顾虑。
- **模式**：`agent` / `plan` / `ask`，对应 DSH 的审批模式，需要映射。
- **有 ACP 之外的自定义扩展方法**，投影层必须容忍未知方法：
  - 阻塞式：`cursor/ask_question`（多选提问）、`cursor/create_plan`（计划审批）——不回则 agent 停等
  - 通知式：`cursor/update_todos`、`cursor/task`（子 agent）、`cursor/generate_image`
- **MCP 限制**：ACP 模式下支持项目级 `.cursor/mcp.json`，但**不支持** dashboard 里配置的团队级 MCP。

#### WorkBuddy 与 CodeBuddy 的关系（2026-09-14 实测）

结论：**同一套会话引擎，但不是同一套系统。** 接 CodeBuddy **读不到** WorkBuddy 已有内容，且 **CLI 目前未登录**。

**（1）会话格式相同** — 两边写出的记录结构一致：`message` / `file-history-snapshot` / `cwd` / `providerData` / `parentId`。WorkBuddy 另有 `function_call` / `function_call_result` / `reasoning` / `ai-title`。WorkBuddy 的助手记录里 `providerData` 含 `model: "glm-5.2"`、`requestModelId: "auto"`，与 CodeBuddy 的 `providerData` 是同一套结构。

**（2）但数据与登录态是分开的**

| | WorkBuddy | CodeBuddy CLI |
|---|---|---|
| 项目/会话目录 | `~/.workbuddy/projects/`（16 个项目） | `~/.codebuddy/projects/`（实测只有测试产生的） |
| 存储 | 另有 `~/.workbuddy/workbuddy.db` 等 | 不碰 WorkBuddy 的库 |
| 凭据 | `~/.workbuddy/credentials`、`keyblob` | `local_storage` 里只有 `.info`，**无凭据** |
| 会话可见性 | — | `codebuddy ps` 返回「无活跃会话」 |

**（3）CodeBuddy CLI 未登录**

握手（`initialize` / `session/new`）不需要登录，所以**握手通过并不代表能用**。实际发提示词返回 `stopReason: refusal`，错误写明「Authentication required. Please use /login command」。**WorkBuddy 的登录态没有传给内置的 CodeBuddy CLI。**

**（4）由此产生的前置条件**

接入 CodeBuddy 之前必须先解决登录，否则只能握手、不能真正对话：

- 走 CodeBuddy 自己的登录流程（`~/.codebuddy` 与 WorkBuddy 凭据互不相通）
- 或独立安装 CodeBuddy 后单独登录
- 登录态存放在哪里、能否在多主机场景下复用，**尚未验证**

**这条会直接影响排期**：ACP 可用 ≠ 可用，必须把「拿到可用登录态」算进工作量。

#### 落地风险：不要依赖应用包内的路径

两者当前都在**别的应用的包目录里**。宿主应用一升级，路径或内置版本就可能变。

- CodeBuddy 自带独立安装命令（`codebuddy install`），**应先独立安装**再接入
- Qoder 同理，优先找独立发行渠道
- 接入层把可执行文件路径做成**可配置项**，不要写死

#### 关于「用量额度」

CodeBuddy 在模型元数据里给 `credits` 字段，Qoder 在模型描述里写 Credit 倍率（`0.50x`）。**这两家把额度倍率做成了可编程读取的元数据**，比 zcode 那种锁在应用内的做法强得多。若关注额度，优先接这两家。

#### 接入成本

两者与 grok 的线路形状一致，**现有 ACP 接入层可直接复用**，各只需新增一个 provider（transport + projection）。CodeBuddy 需额外覆盖 HTTP 传输。

### 5.4 zcode（Z.ai / GLM）：目前无法接入

> **2026-10-14：** 后来没有把它做成 ACP。模型列表里的 ZCode 一组是 GLM Coding Plan 模型插件：解开本机登录密钥，按源码里的 Anthropic 地址把对话发给模型，工具仍由 DSH 的循环执行。下面几段是 2026-09-14「不能当成 ACP agent 接」的记录。

**核对结论（2026-09-14，ZCode 3.14.5）：zcode 不支持 ACP，且没有可被程序驱动的外部接口。接不进来。**

#### 为什么接不进来

**（1）没有 ACP。** 对应用包做符号检索，ACP 必需标记全部为 0：

| 标记 | 次数 |
|---|---|
| `session/new` | 0 |
| `session/prompt` | 0 |
| `session/update` | 0 |
| `agent-client-protocol` | 0 |

包内虽有 `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update`，但读的是事件自身的 `type` 字段，是 **zcode 自己的任务事件格式**。其 JSON-RPC 代码里的 `_meta` / `resumptionToken` / `relatedRequestId` 属于 **MCP**——zcode 是 MCP 的使用者，不是 ACP 的提供者。

**（2）没有可驱动的外部接口。**

- 深度链接只有两条：`zcode://workspace`、`zcode://oauth`。**没有「发消息」的路由。**
- 包内 HTTP 路由全是示例/测试残件（`/hello`、`/about/me` 之类），不是产品 API。
- 内部确实有 `sendPrompt({taskId, traceId, content, modelSelection})`、`listTasks`、`getTaskSnapshot`、`respondElicitation`，但都是 Electron 主进程与渲染进程之间的 IPC，**不对外暴露**。
- `--headless` / `--serve` 来自打包的 Playwright 依赖，不是 zcode 自己的命令行。

#### 关于「150% 用量额度」

这是接 zcode 的真正动机，但它**不能靠绕过界面拿到**。

额度对应的编码套餐端点确实存在：`https://zcode.z.ai/api/v1/zcode-plan/anthropic`，凭据是配置里一个**签名的 JWT**，且必须通过自定义头 `x-coding-plan-api-key` 传递（不是标准的 `x-api-key`）。

**实测直接调用该端点返回 401**（`x-api-key` 与 `x-coding-plan-api-key` 两种都试过，路径本身存在——返回 401 而非 404）。凭据可能已过期、需要额外头部，或由 zcode 运行时刷新。

**因此结论是：额度锁在 zcode 应用内，外部拿不到。**

#### 剩下的可能性（都不是本项目能单方面完成的）

| 方向 | 可行性 | 说明 |
|---|---|---|
| 驱动 GUI（AppleScript / 无障碍 / 注入 Electron IPC） | 不可行 | 需应用常驻前台，无法可靠流式，版本一升就碎 |
| 向 Z.ai 申请该端点的正式接入 | **值得问** | 端点显然是为编程 agent 设计的，问官方最靠谱 |
| 放弃额度优势，直接把 GLM 配成 DSH 模型 | 可行但**不满足需求** | 见下 |

#### 附：GLM 作为 DSH 原生模型（仅在放弃额度需求时考虑）

zcode 调模型走 Anthropic 兼容端点，而 DSH 的 `dsh-llm-pi-ai` 原生支持 `anthropic-messages` 协议，技术上能配：

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      glm:
        api: anthropic-messages
        apiKeyEnv: ZAI_API_KEY
        baseURL: https://api.z.ai/api/anthropic
        models:
          - id: GLM-5.3
            contextWindow: 200000
```

但**这条路会丢掉 zcode 套餐的额度**，正是用户想保留的东西，因此**不作为 zcode 的替代方案**。仅在额度需求被放弃时作为「多一个可用模型」的可选项。

---

## 六、模型列表在新建会话流程中的位置

```
用户点「新建会话」
  → 选 preset（按当前主机过滤）
  → 建会话（ACP session/new 或原生）
  → 此刻拿到真实模型列表
  → 选模型
  → 发出第一条消息
```

**与现有 ThreadHarbor 的草稿会话流程一致，无需改造。**

外部 agent 的探测会话（catalog probe）在新架构下**不再是常规路径**：
- 正常建会话天然拿到列表
- 仅「不建会话查看某主机某 agent 的模型」需要探测，且复用长驻会话缓存（30 分钟空闲回收）

---

## 七、界面适配

> 本章为后补。原设计只考虑了数据通路，漏掉了界面。这一节是实施前必须读的部分。

### 7.1 基本判断：会话区可以不变

DSH 的会话区是**渲染器**，不执行工具（工具由 agent 执行，界面只显示）。我们的投影写入的会话事件与原生循环写入的**完全同构**：

| 界面元素 | 依赖的事件 | ACP 路径是否提供 |
|---|---|---|
| 用户消息 | `user/message` | ✅ 原生 `turn()` 写 |
| 助手正文 | `assistant/message`（text） | ✅ |
| 思考过程 | `assistant/message`（reasoning） | ✅ |
| 工具调用与结果 | `tool/call` / `tool/result` | ✅ |
| 回合/步骤边界 | `turn/*`、`step/*` | ✅ 原生记账 |
| 停止生成 | `agent.cancel()` | ✅ 原生契约 |

**结论：切换 agent 不需要重写会话区。** 这是把 ACP 帧投影成 DSH 原生事件的核心回报——界面层完全复用。

### 7.2 但有四处真实差异，必须处理

**（1）流式输出会变成一次性出现。**

原生循环逐块产出，界面文字是逐步显现的。我们的原型在回合结束时一次性提交完整文本，用户会看到「等半天然后整段出现」。

> ⚠️ **2026-10-09 复核更正**：原文的处置建议「用 DSH 的流记录机制增量提交」**指向了一个不存在的机制**。
> 会话日志**没有增量追加能力**——`assistant/message` 是流消费完后一次性落盘（`packages/core/agent-loop/src/agent.ts:520-529`）。
> 流式在**另一条独立通道** `agent/assistant-stream` 上，且**进程内、不落盘**。详见 §2.7-(1)。
> 阶段 3 的正确做法是接那条通道，而不是想办法把日志拆成多次写。

**这是体验差异里最明显的一条**，需在阶段 3 处理。

**（2）权限请求要接到 DSH 的审批界面。**

ACP 协议里外部 agent 会主动发权限请求（grok 执行命令前可能问）。ThreadHarbor 现有实现已经处理这个——遇到后端请求会把回合停在用户处，等回答再继续。

DSH 侧有**自己的**审批服务（`ask`/`never` 两种策略）。需要把 ACP 的权限请求桥接过去，否则外部 agent 要批准时会卡住。

> ✅ **2026-10-09 已实测**：claude 侧走通「请求 → 批准 → 回合完成 → 被批准的操作真的执行」，帧形状见 §2.6 结论六。
> 实施时注意两条硬约束：**审批必须在打开的 turn 内发起**（§2.7-(2)）；**应答必须回带同一个 `id` 的 JSON-RPC 响应帧**，用通知帧应答会被静默接受然后挂死。

**（3）输入框的模型选择器要能显示外部 agent 的模型。**

DSH 的模型选择器读的是 Host 级模型目录（来自 DSH 自己的厂商适配器）。外部 agent 不走这套，所以**选择器会显示 DSH 的模型，而不是 grok/codex 的**。

处置：外部 agent 会话的模型列表来自 ACP `session/new` 的返回，需要让选择器在 ACP 会话下改读这个来源。

> ⚠️ **2026-10-09 实测补正**：三家返回的形状**并不相同**，claude 顶层甚至没有 `models` 键。见 §2.6 结论二——这一条的实现难度高于原文预期。

**（4）工具的「执行中」状态会一闪而过。**

原生是「发出调用 → 执行 → 返回结果」，界面能看到中间态。我们把调用和结果在回合末一起提交，界面基本同时显示。

可接受，但若要精确还原执行进度，需要在 `tool_call_update` 到达时增量更新（grok 会发 `in_progress` / `completed` 状态）。

### 7.3 需要改动的地方汇总

| 位置 | 改动 | 阶段 |
|---|---|---|
| 会话区渲染 | **不改** | — |
| 工具执行中状态 | 可选优化 | 阶段 3 |
| 权限请求桥接 | **必做** | 阶段 2 |
| 输入框模型选择器 | **必做**（ACP 会话下换数据源） | 阶段 3 |
| agent/preset 选择器 | 按主机过滤可用 preset | 阶段 4 |

---

## 八、多主机互通

### 8.1 传输层

复用 DSH 原生 remote 机制：`dsh-api-gateway`（Gateway 持有 WebSocket mux）、`dsh-api-remotes`（转发 `api-session/*`、`approval/request`、`agent-preset/selected` 等事件）。

**重要边界**（来自官方 README）：
- 能力集合**构建时显式导入**，Client **不会在运行时发现** Host 上启用的服务 → 新增能力需显式挂载
- 单向通知是 **best-effort，不回放**；需要可靠恢复的状态必须由拥有方提供查询/游标/初始基线
- `dsh-api-remotes` **不拥有**物理传输和 Host 服务发现

#### ⚠️ 2026-10-09 复核：原生 remote **不是多主机机制**

原文说「复用 DSH 原生 remote 机制」就能得到多主机。**这个前提不成立**——原生 remote 是
**「一个浏览器页面 ↔ 一个 Host」** 的通道，不是「一个界面连多台机器」。三条互相独立的证据：

- Client 侧唯一的连接状态是单例 `ctx.connection.generation`（`packages/client/connection/src/client/connection.ts:13-18`），**没有 host id 概念**。
- `isLoopback` 是**整页一个布尔**（`packages/client/connection/src/client/index.ts:248`），由 `location.hostname` 一次算出，非每连接一个。
- WebSocket 地址只有两个来源：`__DSH_TRANSPORT__.streamBaseUrl ?? document.baseURI`（`packages/api/gateway/src/client/stream-client.ts:476-477`）——**即页面自身的源**，没有任何地方允许填入别的机器地址。

官方 cookbook 对「远端」的表述也印证这点，只有二值区分、没有主机名：
`return home ?? (isLoopback ? 'local host' : 'remote host')`（`docs/cookbook/adding-a-remote-api.md:145`）

**含义：阶段 4 不能只靠挂 `dsh-api-remotes`。必须自建主机注册表与多连接管理。**
原生一律没有、必须自己做的四件事：

1. **主机注册表**：主机 id、显示名、地址/URL 的映射。
2. **多连接管理**：`ctx.connection` 与 `ctx.remote` 都是单例，一个页面只能连一个 Host。
3. **每台远端各自的凭据**（最大的结构性障碍）：原生认证是 HttpOnly + SameSite=Strict 的
   **浏览器 cookie**（`packages/client/connection/src/browser-auth.ts:121-123`），
   **应用代码读不到、也无法转发**。要么每台远端各开一个浏览器标签页，
   要么实现一条非浏览器的认证路径（**源码中未找到此类路径**）。
4. **事件按主机路由**：转发事件不带任何来源标识（`TypertRemoteEventFrame` 只有 `event` + `args`，
   `packages/api/gateway/src/types.ts:30-35`），分组得由我们的连接层自己贴标签。

**配对与认证的实际形态**（原文「确认配对配置入口」的核对结果）：

- **没有配对码、没有设备指纹、没有双向确认。** 实际是两段式：
  1. **进程 launch token**：每进程随机 32 字节 secret，存进程内 WeakMap、不落盘；
     拼成 `?token=...` 由 `dsh web` 打印（`packages/client/connection/src/browser-auth.ts:20/52-58/223-227`）。
  2. **authority 绑定的 HMAC 签名 cookie**：`v1.<payload>.<HMAC-SHA256>`，cookie 名绑定归一化的
     host+port，默认活 30 天（`:27-32/106-108/129-132`）。签名密钥存在
     `$DSH_HOME/.credentials.yaml`，删掉该记录并重启即吊销全部会话。
- **配置入口是配置文件 + CLI，没有界面操作。** 关键项是 `client-connection` 插件的
  `trustedHosts?: string[]`（`packages/client/connection/src/index.ts:110-115`），
  CLI 为 `--trusted-host <authority...>`。带端口精确匹配，不带端口匹配任意端口；
  **格式写错会导致插件加载失败**（`api-request-trust.ts:49-53`）。
- 🔴 **`--host 0.0.0.0` 被 CLI 硬性拒绝**（`packages/bundle/web-app/src/startup.ts:88-90`，
  理由是会把远程代码执行暴露到网络）。官方路径是 **loopback + SSH 端口转发 / 反向代理**。
- **转发事件不做脱敏**（`packages/api/gateway/README.md:88`）。多主机场景下一个 Host 的事件会
  原样送到连着它的浏览器——这一点在本项目的多租场景下要特别当心。

**阶段 4 的验证标准需要相应调整**：原写「两台 DSH，界面能看到两边会话并按主机分组」，
这隐含了「原生已有多连接」。实际上要么实现多连接，要么改成
「每台主机一个浏览器标签页、我们的聚合层负责跨标签页汇总」——后者能绕开 cookie 不可读的问题。

### 8.2 主机身份（必须自己带）

`RemoteHostFacts` 只有 `home` / `isLoopback`，**没有主机身份**。2026-10-09 复核**确认该判断完全正确**：
定义在 `packages/api/gateway/src/client/index.ts:118-124`，全部字段就这 2 个；底层帧
`RemoteEventHostInfo` 也只有 `home`（`packages/api/gateway/src/stream-protocol.ts:27-31`）。

所以：

- 每台 DSH 需配置一个稳定 **hostId**（建议 `hostname` 或显式配置）与人类可读 **hostTitle**
- 通过 remote 通道随会话/事件一起上报
- 界面按 hostId 分组；设置按 hostId 绑定

### 8.3 界面分组

> **⚠️ 2026-10-15 决定（最高优先，覆盖下方 2026-10-11 与 2026-10-14 两次记录）：**
> 用户澄清一贯需求：**同一个列表里展示「主机 → 项目 → 会话」，且左右两侧
> 会话区域（左侧列表 + 主会话区）都由 ThreadHarbor 插件接管渲染，不使用
> DSH 原生组件**——否则无法支撑「agent + model」自由组合的迁移目标。
> 10-11 的「面板只列主机」针对的是**面板**；10-14 撤掉的是**面板内的分栏树**；
> 两次都不等于「不要树」，而是「树长在主界面上」。详见 §8.5 接管设计。

> **⚠️ 2026-10-11 用户决定：本节原「主机 → 项目 → 会话」三层分组被覆盖。**
> 用户在真机上看过面板后明确：**各主机面板只需要主机列表**，每台主机给出基本
> 信息——名称或主机标识、是不是本机、在线状态、心跳时间、登记时填的地址和
> 显示名（如果有）；**会话与项目一律不显示，会话列表在这个面板里没有必要。**
>
> 这次覆盖落到实现上的事实（核对时间 2026-10-11）：
>
> - 面板第一张卡从「主机与会话」三层树改为「主机」一层列表；另外两张卡
>   （本机 agent、主机登记）不动。
> - 读取会话/项目的代码（从 DSH 自己的 workspaces / sessions 投影投影）与
>   树渲染代码（rollup-view / rollup-mount / workspace-map / 会话发布）随之
>   没有读者，**已删除**；删前逐符号查过引用。
> - 跨标签页频道保留，但只传「谁在场」（hello / heartbeat / bye + 静默过期），
>   不再发会话清单；'sessions' 报文从协议中撤掉。
> - 看某台主机会话的路径不变：去那台主机自己的页面。
>
> 下面保留的树形图是原设计文字，仅作历史记录，**不再描述现状**。

```
主机 A
  ├─ 项目 X
  │   ├─ 会话 1（grok-4.7）
  │   └─ 会话 2（codex）
  └─ 项目 Y
主机 B
  └─ 项目 X        ← 同名项目在不同主机上是两个项目
```

- **主机分组**：按上报的 hostId
- **项目归属**：项目恰好属于一台主机；两台主机上的相同 basename 是两个项目
- **preset 可用性**：来自该主机自己的注册表
- **设置**：按 hostId 绑定，凭证留在主机侧不下发到浏览器

### 8.4 形态决定（2026-10-09）

因 §8.1 的复核结论（原生 remote 非多主机、且 cookie 应用代码不可读），
**采用「每台主机一个浏览器标签页 + 聚合层跨页汇总」的形态**：

- 每台被管理的 DSH 各开一个标签页，页内身份用 `home` + 显式配置的 `hostId` 区分
- 聚合层负责跨页收集各主机的会话/项目/preset 可用性，按 hostId 归并成分组树
- **不实现非浏览器的认证通道**——源码无先例，安全性不可控，不值得赌

> **2026-10-11 更新**：上一条里「跨页收集各主机的会话/项目」已随 §8.3 的覆盖决定
> 取消——聚合层（跨标签页频道）现在只汇总**主机在场与心跳**；会话/项目不再收集、
> 不再显示。

代价（已知并接受）：
- 每个标签页是一条独立连接，聚合层要自建跨页通信与状态合并
- 关闭某台主机的标签页即等于该主机离线，聚合层要能处理「主机消失」
- 凭证仍留在各自主机的浏览器侧，不进聚合层——这与 §8.2「凭证留在主机侧」一致

**跨页通信的实现选型留到阶段 4 开工时定**（`BroadcastChannel` / `localStorage` 事件 / `postMessage` 均可行，
取决于聚合层是同源页面还是独立扩展）。

### 8.5 插件接管左右会话区（2026-10-15 定稿）

**目标形态**：左侧列表 = 「主机 → 项目 → 会话」一棵树（本机是第一个主机节点）；
主会话区 = 点开哪个会话就展示哪个会话（不分本机远端）；新建会话在相应主机节点下
创建。两处都由 ThreadHarbor 插件渲染。

**槽位事实（2026-10-15 核对安装目录源码）**：

- 左侧列表挂载点是单占位槽 `sidebar.workspaces`，原生占用者是主程序自带的
  工作区界面包；主会话区挂载点是单占位槽 `main.conversation`，原生占用者是
  会话界面包。
- 槽位机制**原生支持顶替**：同优先级才报错，占位提示原文「register at a
  different priority to shadow it (lowest renders)」——更低优先级数值者渲染。
  此前「插件无法顶替原生列表」的说法是误读，已纠正。
- 代价如实记录：渲染器只渲染赢家，**被顶掉的原组件无法嵌入赢家内部组合渲染**。
  因此两侧界面都采用「**复制现有原生界面为起点，再改造成树/多主机形态**」的
  策略（用户 2026-10-15 明确同意）；DSH 升级后外观行为可能漂移，届时人工
  重新对齐（用户接受此维护成本）。数据与操作尽量走槽位注入口的官方共享
  （会话标准套件、全局座位），只有外观交互是复刻件。

**数据面**：

- 本机子树：经官方注入口读本机工作区/会话（当年删除的 session-source /
  workspace-map 读取代码可从 git 历史恢复）。
- 远端子树：恢复 host-remote-sessions 服务端路由，经 SSH 隧道拉远端的项目与
  会话清单（昨日的连接/隧道闭环即其通道）；展开时拉取 + 轮询刷新。
- 项目 = Workspace（§8.3 原判定不变，映射现成）。

**分阶段落地**：

1. **阶段 L（左树）**：接管 `sidebar.workspaces`；复制原生工作区列表外观；
   本机子树真实可用（搜索/当前标记/菜单从简起步，逐项补齐）；远端主机节点
   展开拉清单；点本机会话就地打开，点远端会话先跳详情页（阶段 R 前的过渡）。
2. **阶段 R（主会话区）**：接管 `main.conversation`；复制原生会话区外观；
   本机会话读日志渲染；远端会话经隧道取日志渲染（先读后写：展示完整，
   发送消息依赖隧道代理远端接口，作为阶段 R2）。
3. **阶段 N（新建会话）**：主机节点上的「新建」入口；本机走原生创建路径；
   远端经隧道调用那台主机自己的创建接口，agent+model 候选也来自该主机。

**已知边界**：远端正在生成的会话要「边生成边显示」需要隧道上的事件流通道，
阶段 R 先做到「打开即完整展示 + 手动刷新」，实时流另立后续阶段。

---

## 九、中途切换 agent

### 9.1 事实

DSH 硬拦（§2.4），不可绕过。注意复核结论：锁是**永久**的（有过任何回合即锁死），且只在 `turnBoundary` 投影在场时生效。

### 9.2 做法

**⚠️ 实施后的更正（2026-10-10）**：§十 阶段 5 写的「复用 `session.switch`」
**做不到**——它是 ThreadHarbor 自有的协议方法（见 §2.8 的澄清），
而阶段 6 把 gateway 与协议包一并下线后，它连存在的地方都没有了。

实际做出来的是它背后的那条语义，拆成三步：

1. **判定**（`planSwitch`）：不动 / 就地切 / 分叉 / 拒绝。两个东西各自都会
   挡路——会话开过一轮就锁、历史可能装不下——合起来才是容易出错的地方。
2. **历史交接**（`decideHandover`）：装得下就整段带过去；装不下就**拒绝**，
   除非主动要求裁剪，且必须报出留了多少、丢了多少、留的是最新的。
   **分叉不会让历史变小**，所以过大就是拒绝，与锁不锁无关。
   唯一绝不产出的结果就是静默截断。
3. **执行**（`applySwitchPlan`）：先分叉再在新会话上选（反过来的话原会话已锁、
   选不动）；分叉后选中失败要说清楚建了哪个会话。

**切换只在会话所在的那台主机上进行 —— 没有跨主机切换（2026-10-10 更正）。**

一个会话属于一台主机。它能看到的模型列表里，只有这台机器上装了、且配置里
标明供它使用的那些 agent；`presetsForHost` 负责按本机标识过滤，
挂载时用它筛过的配置（见 §2.7c 的取证：每个 DSH 进程一份 preset 注册表，
跨主机天然隔离）。

本轮曾实现过一版「向另一台主机的标签页发请求、由它接管这段对话」，**已删除**。
那个设计是错的：它允许把一段对话搬到另一台机器的 agent 上继续，等于重新引入
hostd 时代的「远程主机」假设——而那正是阶段 6 要拿掉的东西。目标里
「支持跨主机」那句是迁移前写的，跟 `session.switch` 一起作废了。

原先那四步的意图仍然成立：读完整 transcript、目标上选 preset（+模型）、
新会话完整交接、承担不了就如实报错——全部发生在这台主机之内。

**记录回填（2026-10-12 补充）**：上面三步做完，界面上历史仍然是空的。
新会话是空的，整段对话只是作为「预热文本」交给新 agent 读——那是 agent 的
上下文，不是用户看的记录。于是补上第四步：把旧会话**已结束的那些回合**
按事件逐条写进新会话自己的记录（`planReplay` / `replayInto`），写在提问
之前，新会话打开就是刚才那段对话，底下接新内容。搬的是问答、工具调用与
结果，以及分组要用的 turn/step 边界；不搬旧 agent 自己的东西（请求头、
系统提示、重试记录、种子标记），也不搬压缩检查点那类按序号替换的事件。
正在切换的这一回合不搬——它的提问正要交到新会话去。

**切换过程可见（2026-10-12 补充）**：回填之后面板里仍然是整块换新内容，
中间那段空白没有任何交代。补上第五步：交接提示一挂上就开始走进度——
挂在**窗口浮层** `shell.overlay`（不是会话内，会话一换就跟着消失的进度条
等于没有），同时用 `ctx.sessions.retain` 把新会话的首屏先读出来（`ready`
是那次读取落定的那一刻），读完才跳；首屏读失败或一直没读完都不卡跳转，
最多等 `PRELOAD_TIMEOUT_MS`（4 秒）。读出来的那份 reference 跨过跳转再归还
（`HOLD_MS`），早还手会把刚读好的窗口拆掉，用户看到的正是预加载想避免的
加载态。历史长短与这条进度无关：首屏走 DSH 自带的分页（`PAGE_MESSAGES=50`
起，`hasMore` 时界面给「加载更早」），回填只决定记录里有没有那些事件。

### 9.3 与「重新选择 preset」的区别

- **第一个回合之前**：DSH 原生支持改 preset（`select()`），可直接改
- **已经开始对话**：只能新会话 + 历史交接

---

## 十、实施计划

分阶段，每阶段独立可验证、可回退。**旧 hostd 路径在阶段 6 完成前一直保留。**

### 阶段 1：核对与固化（不写生产代码）✅ 已完成 2026-10-09

1. ~~把 DSH 源码更新到最新官方 master~~ → 已拉到 `5badb15009`，与原基准一致
2. ~~核对 §二 中所有事实~~ → 逐条重核，**1 条不成立**（preset 读取路径）、1 条归属修正、6 条实施约束补齐
3. ~~核对 codex / claude 的真实帧形状~~ → 实测完成，结论见 §2.6（六条）
4. ⏸ **配置并验证 GLM 路由**（§5.4）→ **阻塞**：需要 Z.ai API Key，且 §5.4 的最新结论已改为「GLM 路线会丢掉 zcode 套餐额度，不作为替代方案」，与本条要求冲突，**待定**
5. ~~验证 ACP 权限请求~~ → claude 侧已验证打通（含一个静默挂死的坑，见 §2.6 结论六）；codex 默认 `approval_policy="never"` 不触发，需改配置复验；grok 未触发
6. ⏳ 确认 DSH `remote` 的配对配置入口 → 进行中

**产出**：核对结论已固化为本文档 §二（含 §2.6 / §2.7 新增两节）。原始抓帧存于 `.superpowers/sdd/dsh-multi-host-migration/frames/`。

### 阶段 2：ACP 接入层通用化

1. 把 `packages/dsh-grok-agent` 的 transport / projection 抽成通用 ACP 接入层
   —— ⚠️ 按 §2.6 结论一，**三家工具名/输出字段位置各不相同，抽象层不能把提取规则写死**
2. 让 claude / codex 各实现一套 transport + projection
   —— ⚠️ claude 的模型列表在 `configOptions`，不在 `models`（§2.6 结论二）
3. **桥接 ACP 权限请求到 DSH 审批服务**（§7.2-(2)，否则外部 agent 会卡住等批准）
   —— ⚠️ 审批必须在打开的 turn 内发起（§2.7）；应答必须回带同一 `id` 的响应帧
4. 每套都用真实 agent 抓帧做回归测试
   —— ⚠️ codex 需先在 pinned `1.6.2` 上复验（本次抓的是 `1.6.0-grok.3` 分叉）

**验证**：每个 agent 独立跑通「建会话 → 提问 → 收到回答 → 工具调用正确投影」，且**权限请求能被批准并让回合继续**。

### 阶段 3：接进 DSH（方案乙）

1. 实现原型改写 + 按 preset 分流
   —— ⚠️ **读 `session.header.agentPreset`，不是 `.meta.agentPreset`**（§2.1 复核更正，照原文写分流静默失效）
   —— ⚠️ **拿不到 `ReactLoopAgent` 类引用**，须从活着的实例反查原型（§2.1 约束 1）
   —— ⚠️ 改写处**必须保留原实现引用**，未命中 preset 一律走官方路径（§2.1 约束 5）
   —— ⚠️ `step()` 返回 `completed` **收不回来**回合，开关是 inbox（§2.1 约束 2）
2. 原生 dsh preset 回归验证零行为变化
3. grok preset 跑通完整会话
4. **输入框模型选择器在 ACP 会话下改读 ACP 模型列表**（§7.2-(3)）—— 三家数据源形状不同
5. **恢复流式观感**（§7.2-(1)）—— ⚠️ **不是「增量提交日志」**：日志没有增量接口，流式在**独立的 `agent/assistant-stream` 通道**且不落盘（§2.7-(1)）

**验证**：同一台 DSH 里，dsh 会话和 grok 会话共存，界面都能正常对话。

### 阶段 4：多主机

1. 每台 DSH 配置 hostId / hostTitle
2. 主机身份随会话上报
3. 界面按主机 → 项目 → 会话 分组 **（2026-10-11 覆盖：只列主机及基本信息，见 §8.3）**
4. 设置按主机绑定
5. preset 可用性按主机过滤

**验证**：两台 DSH，界面能看到两边会话并按主机分组。
**（2026-10-11 覆盖：验证标准改为「两台主机的标签页都开着时，任一页的主机列表
能看到两台，各带本机/在线徽标与心跳；不再验证会话分组」——会话在这个面板里
不显示。）**

### 阶段 5：中途切换 agent

1. 复用 ThreadHarbor 自有的 `session.switch`，支持跨 preset、跨主机
2. 历史完整交接

**验证**：在 grok 会话里切到 codex，历史完整保留；目标承担不了时报错而非截断。

### 阶段 6：下线 hostd

1. 三个 agent 全部迁移完成并稳定后
2. 删除 hostd 包与相关部署流程
3. gateway 退化为薄路由层或一并下线

---

## 十一、风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `step()` 私有方法契约变化 | ACP 路径失效 | 阶段 1 每次 DSH 升级重新核对；改写处加断言，形状不符立即抛错 |
| 原型改写影响原生 agent | 回归 | 未命中 preset 必须严格走原实现；补原生 agent 回归测试 |
| codex / claude 帧形状未知 | 阶段 2 返工 | 阶段 1 先抓真实帧，不照抄 grok |
| 工具失败状态不可靠 | 界面错误提示不准 | 忠实反映外部 agent 状态，不自行推断；必要时从输出文本判断 |
| 权限请求未桥接 | 外部 agent 卡住等批准 | 阶段 2 专门验证；桥接到 DSH 审批服务 |
| 模型选择器仍显示 DSH 模型 | 选不到外部 agent 的模型 | 阶段 3 换数据源 |
| 流式观感丢失 | 「等半天整段出现」 | 阶段 3 增量提交 |
| DSH remote 不回放单向通知 | 丢事件 | 拥有方提供查询/游标/初始基线 |
| 主机身份需自建 | 分组做不出来 | 阶段 4 显式加 hostId 配置 |
| 历史交接超长 | 目标 agent 承担不了 | 按既定决策：**报错让用户换**，不静默截断 |

---

## 十二、给执行会话的提醒

1. **不要凭印象**。本文档 §二 每条都有出处；改动前先读源码，改动后更新本文档并标注核对时间。
2. **不要照抄 grok 到 claude/codex**。三者协议细节不同（已实测出 grok 至少两处代码里看不出来的坑）。但要注意：这三个的 ACP 通路 ThreadHarbor 侧**都已有可用实现**，是搬运不是从零实现。
3. **不要重写已验证部分**。`packages/dsh-grok-agent` 有真实帧回归测试，直接复用。
4. **每阶段做完先验证再进下一阶段**，别攒着一起验。
5. **hostd 在阶段 6 之前不要删**。

#### 各 agent 的 ACP 对接文档

已拆成独立文档，放在 `docs/agent-acp/`：

| Agent | 状态 | 文档 |
|---|---|---|
| grok | ✅ 已实现并实测 | [grok.md](../agent-acp/grok.md) |
| codex | ✅ 已实现并实测 | [codex.md](../agent-acp/codex.md) |
| claude code | ✅ 已实现并实测 | [claude-code.md](../agent-acp/claude-code.md) |
| Cursor | 📄 官方支持，未接入 | [cursor.md](../agent-acp/cursor.md) |

三家已实现的差异对照表、以及接新 agent 要改的地方，在 [README.md](../agent-acp/README.md) 里。

**接 Cursor 前必读的两条**：它的安装脚本会覆盖 `~/.local/bin/agent`（本项目 grok 正在用的链接）；且它是唯一握手后还有鉴权硬门槛的一家。

---

## 十三、主机侧存储落地记录（2025-07-09 核对）

按 §「现成的缝」的 `isLoopback ? 'host' : 'memory'` 决策落地。主机登记簿与本机默认身份
不再存浏览器 localStorage，改走本机设置通道（`ctx.remote.settings` 的
`threadharbor-host-store` 命名空间，宿主组合条目 `@threadharbor/dsh-host-federation/host-store`
的 volatile 配置段）；单标签页身份覆盖（sessionStorage）保持原样不动。

已真机验证（playwright-core + 独立 Chromium，DSH_HOME=/tmp/dsh-verify，端口 3081）：

1. 登记跨浏览器上下文存活；新上下文姿态为 host，界面如实说明数据存在「这台机器上」。
2. 本机改名与登记改名跨上下文都在。
3. 双标签页各自声明不同主机：各保存过一次后，tab 层声明互不覆盖；新标签页继承
   最近一次保存（分层写约定：一次保存同时记录 tab 层与默认层）。
4. 旧 localStorage 数据迁移：文档为空的机器上启动，旧登记与本机名搬入主机文档，
   旧拷贝保留；文档已有数据时不覆盖。
5. 硬证据：实例 profile 的 cordis.patch.yml 出现 `threadharbor-host-store` 用户段，
   含 `dsh.host.registry` / `dsh.host.identity` 数据。

落地中确认的三个坑（后来者必读）：

- **浏览器端读 `remote.settings` 必须在插件代码里写 literals `inject`**（`export const inject`
  含 `'remote.settings'`）；package.json 的 dsh.client.inject 只服务模块图。官方先例：
  dsh-client-ui-settings-models。
- **宿主组合条目不能带模块级 `inject`**：会让条目 fiber 永远 pending，settings 的
  describe 不再收录它，命名空间凭空消失。要读 settings 就在 apply 里用
  `ctx.inject(['settings'], child => …)` 子作用域读取。
- **表单组件的 React key 不要带「后台刷新计数」**：详情表单 key 里含 identityRevision 时，
  登记写入触发的存储通知 → 身份重读 → 表单重挂载，把用户正在输入的草稿冲回旧值
  （真机表现为改名偶尔不生效，保存的是旧标题）。key 只随数据身份（hostId）变化。

非本机（非回环）走内存 + 界面如实说明，为单元级验证（host-store.spec「非本机页面」）；
真机路径需要服务端放行非回环访问，当前启动器未提供该开关。

### 落地记录：打包陈旧与接线登记（2026-10-12 核对）

围绕「构建会静默打包旧代码」和「接线检查误登记」两处收尾，均已落地并通过
（typecheck --force + 546 用例 + build 全绿）：

- **打包陈旧防护**：`scripts/build.ts` 驱动 tsdown，其 `entry` 指向编译产物
  `lib/types/index.js`（client 与 plugin 两个 tsdown 配置皆如此）。正常路径
  `build.sh` 先 `tsc -b` 再打包，安全；但 `tsc -b` 是增量的——改了 `src/` 文件、
  而它的 `tsBuildInfoFile` 比产物新时，`tsc` 会跳过重编且不报错，随后 tsdown
  把旧 `lib/` 照打、退出 0。**实测可复现**：`touch` 一个 client 源文件后跑
  `tsc -b`（不加 `--force`），产物不更新，源码却比产物新。
  新增 `scripts/check-freshness.mjs`：从每个打包入口的源码出发，沿相对 import 走
  可达集，逐个比对 `lib/types/` 下对应 `.js` 的 mtime，比源码旧即**退出 1**，
  在 `build.sh` 里 `tsc` 之后、tsdown 之前调用。只查入口真正会打进包的文件
  （plugin 入口是空 `apply()`，几乎不拉 `src/`，按全量 `src` 查会误报）。
  另一道 `verify-build.mjs` 管的是浏览器产物的**内容**（每个导出名都要在
  `client.js` 里能找到），这道管的是**新旧**，两者互补。
- **接线检查认识组合登记**：`tests/wiring.spec.ts` 的可达性根清单原只看代码
  import，看不见 `cordis.patch.yml` 的组合条目——宿主经 `@threadharbor/...`
  specifier 加载 `host-store` 半边，于是被误判成「跑不到」。改为从组合文件的
  `name:` 字段抽出 `@threadharbor/...` specifier，解析到各自导出的文件、作为
  根种子喂进可达性 walk。`host-store.ts` 因此真正可达，`KNOWN_UNWIRED` 里的
  误登记随之删除（不再留豁免口子）。真·遗留 `service.ts` 仍登记，清掉条件不变。
- **删除无用依赖**：`packages/dsh-client/package.json` 声明了
  `@threadharbor/dsh-preset-dispatch`，但 client 源码只 import
  `@threadharbor/dsh-host-federation`，preset-dispatch 由宿主侧组合条目加载，
  与 client 包无关。已删除，lockfile 同步更新（只动这一条 importer 边）。
- **清理 `undefined/`**：仓库根曾有 `undefined/threadharbor/known_hosts`（空文件，
  gitignored、未被 git 跟踪，mtime 9 月 1 日，早于 hostd 移除）。全仓检索确认
  无任何**当前**源码构造 `known_hosts` 路径（仅 `.worktrees/abc` 的旧 hostd
  gateway 与 `reference/` 里有），属 hostd 时代遗留、不会再生成的死文件，已删除。

### 落地记录：思考强度独立 + 主机管理入口（2026-10-12）

用户本轮四项诉求，按依赖顺序逐项落地（4→3→1→2），验收在 3081 web 页面上点
起来对不对。全绿（typecheck --force + 560 用例 + freshness + build）：

- **模型去重 + 思考强度独立成选择框（第 3、4 项）**：根因是真机探针确认的——
  codex-acp 把思考强度**拼进模型 id**（`gpt-6-astra[low]`…`[ultra]` 是六个真实
  不同的 wire id，不是显示标签；claude/grok 是裸 id，不带后缀）。catalog 原样
  列出全部，于是「一个模型出现六次」且没有独立的强度维度。改法数据驱动、按
  agent 各自处理，不写死后缀表：`collapseEffortModels()` 把同一基础模型的多个
  `[强度]` 归并成一行，各后缀收进 `reasoning.efforts`——DSH 的选择器只在模型带
  `reasoning` 时渲染强度子控件，于是强度成了独立的一轴。`selection.ts` 按基础
  id 认账（picker 选基础 id，预设声明的是带后缀的 wire id），选基础 id 时把
  `[后缀]` 拼回，让 effort 经 DSH 自己的 `reasoningEffort` 字段流到 agent。**刻意
  不带 `defaultEffort`**：DSH 的选择器把它缺省为「显示 Provider default 行、不
  预选」，这是诚实的首屏——agent 自己挑默认，直到用户选；设了会静默预选用户没
  选的强度。
- **各 Agent 下模型去重（第 4 项）**：同一 `collapseEffortModels` 顺手解决——带
  后缀的归并成一行，裸 id（claude/grok）原样通过，不发明强度。
- **主机管理入口（第 2 项）**：用户要「设置按钮去掉、各主机按钮进面板、点开每台
  主机进设置界面、现有主机信息作为其中一个栏目」。**设置按钮压不掉**——它来自
  `dsh-client-ui-settings`（不在本仓库），slot API 也没有隐藏标志，所以按用户
  备选项「只加主机管理，保留设置」走。详情页本来就是单台主机的设置界面（登记
  字段 + 自报标识 + 状态 + agent + 删除登记 + 测网络可达），只缺个名字：顶部加
  「主机管理」标记，点明这是主机管理设置界面，下面的主机信息仍是其中一个栏目。
- **desktop→web profile 模型配置（第 1 项）**：web profile 缺 `llm-deepseek` 块、
  `agent-default-model` 指向 `iquest/glm-5.2`（desktop 是 `minimax-cn/MiniMax-M3.1-Flash-Preview`）。
  两项都改（用户确认「与 desktop 一致」）。**注意这份文件在仓库外**
  （`~/.dsh/profiles/web/cordis.patch.yml`），改前已给用户看 diff，改的是本机
  profile，不进版本库。

### 落地记录：多主机界面第三轮返工（2026-10-13）

用户在真机上用过第二轮的三界面后给了七条反馈，逐条落地（typecheck --force +
622 用例 + build 全绿；3081 重启后浏览器实测：列表三列对齐、返回在方框外、
选择器在表单前、选中自动填名称+IP、按钮下无内容）：

- **主机列表改成一张正常的表（第 1 条）**：原来是「一列表头 + 行内上下两行」
  的混合体。现在是三列表头（名称 / IP / 状态）配同栅格的行：名称单行省略、
  IP 等宽数字、状态徽标右对齐；本机没有登记地址时 IP 列以 — 占位，不再把
  内部标识塞进副行。空列表给一行「还没有主机」占位，不再只剩光秃表头。
- **返回按钮移到方框外面（第 2 条）**：添加/详情页顶部拆成「‹ 返回」导航行
  （方框外）＋ 表单卡片（方框内）。方框框的是表单，导航不是表单的一部分。
- **「从 Tailscale 选」放在表单前面（第 3 条）**：入口从地址输入框旁边挪到
  表单上方；点开后的节点清单带「刷新」「收起」，收起只关不填。
- **选中后自动填名称和 IP（第 4 条）**：原来只把地址填成
  `http://<MagicDNS 名>:3081`，名称要手动抄。现在选一台 peer，名称填 peer
  名、IP 填它的 tailnet 地址，两边一次到位。
- **主机只留「名称」「IP」两个字段（第 5、6 条）**：显示名撤销；原来的
  「主机标识」改名「名称」并兼任显示名——登记时 hostTitle 落库留空，存储层
  回落到 hostId，列表显示的就是名称（旧登记里不一样的 hostTitle 在下一次
  保存时被名称取代）。本机身份保存时名称同时写 hostId 和 hostTitle：id 是
  频道认账的键，title 是列表显示的名，只写 id 会让本机行退回派生名。IP 字段
  放去协议的主机（可带端口），入库前补 `http://`，出库时剥掉——两个方向的
  互转（hostPartOfAddress / addressFromHostPart）有独立单测。原来 :3081 的
  预填端口不再默认写入：字段里看到什么就存什么，端口不一样的自己补
  （占位文本给了带端口的示例）。
- **确定和取消下面的内容去掉（第 7 条）**：添加页按钮下方的「登记不是建连」
  说明和「添加一台主机需要什么」折叠（ssh -L、--trusted-host、token、安全
  代价）整块删除。这些是第一轮的解释包袱，用户明确不要了。
- 详情页事实区随之收缩：显示名字段没了，「主机自报名字」的比对行也没有
  意义了，一并去掉；「主机自报标识」改叫「主机自报名称」，不一致时的提示
  改为「把名称改成它，两边就对上了」。

### 落地记录：主机列表第四轮（2026-10-13）

第三轮列表上线后用户再给三条排版要求：有表头、每行高度一致、三列＝名称、
IP、设置按钮。落地：

- **状态徽标列撤销，换成设置按钮列**：行尾是一个「设置」按钮外观，点它
  （或点整行——整行仍是那个按钮，设置只是第三列长相，不是又一个独立
  控件）进那台主机的设置页。状态不丢：以名称旁的圆点标示（本机=品牌色、
  在线=绿、未连接=灰），悬停有词，不再单占一列。
- **行高一致**：表头定高 32px、数据行定高 40px（不是最小高）——内容都是
  单行（超长省略号），行与行不会因内容不同而高矮不齐。
- **表头第三列留空**：按钮自己说明自己。第三列宽度定死 56px（不是 auto）：
  表头的空单元格会塌成 0 宽，1fr 的名称列把差吃掉，IP 表头就横移出它
  该标的那一列——真机上量到过 46px 的错位，定宽后表头与行严格同栅格。
- 构建链上发现并绕过一个坑：tsc 增量编译只重写真正变了的输出文件，
  未变的入口（client/index.js 编译产物）mtime 落后于改过的 panel.tsx，
  check-freshness 因此拒绝打包——这不是误报，是它在阻止旧代码静默上线；
  先 `tsc -b --force` 重写全部产物再打包即可。

### 落地记录：会话树二次撤销（2026-10-14）

用户反馈「现在点开各主机，出现左右区域，左边是会话列表，这不是原先设计
的」。来源查明：2026-10-13 晚合入主干的 SSH 部署分支
（cursor/ssh-deploy-dsh-6dfb）把 2026-10-11 已按用户决定撤掉的会话树整个
加了回来——左侧「会话（按主机）」树 + 右侧主机表的双栏布局。本轮按
§8.3 的既有决定再次撤销，这次连代码一起清干净：

- **面板回单区域**：列表页只剩主机表一栏；data-session-tree /
  data-rollup-host / data-host-pane 全部消失，说明区只剩「在线的含义」与
  「另一台机器不在频道里」两条。
- **随树撤掉的代码**（先查读者再删，全部只服务于那棵树）：
  客户端 session-source（DSH 投影读本机会话）、remote-session-store（远端
  会话缓存）、host-roll-up（树视图合成）、surface（树的挂载生命周期）；
  联邦侧 workspace-map / rollup-view / rollup-mount（树的渲染与分组）、
  host-remote-sessions（按 launchUrl 拉远端会话）及其 host-ssh 路由
  （/api/threadharbor.host-remote.sessions，浏览器侧的
  fetchRemoteHostSessions 一并删除）。
- **频道协议回纯在场**：Announcement 只剩 hello/heartbeat/bye；收到旧版
  客户端发来的 sessions 报文按噪音丢弃（测试钉死这一行为）。
  listSessions/publishSessions/rollUp 分组等会话面 API 全撤。
- **保留的 SSH 分支功能**：SSH 自动部署、主机连接状态列（已连接/可达/
  检测中/未连接）、peer 探测、Tailscale 桥——它们不依赖会话树。
- inject 里 workspaces 一并除名：会话树撤销后无人再读它（sessions 仍留，
  会话切换进度条在读）。
- 验证：npm run check 全绿（939 通过）；3081 真机浏览器确认单区域、
  四列表头（名称/状态/IP/设置）与行内容正常、详情页可进。

### 已知限制（2026-10-12 核对，文档化，未修）

- **「已切换」卡片不在重访时渲染**：跨 preset 切换（§9.2）后，目标会话会显示一张
  「已切换」提示卡，但**重新打开该会话时不复现**——切换是一次性动作，卡片只在该次
  会话里出现一次。这是刻意为之（切换不是状态，是事件），不是 bug，但用户可能预期
  它重访时还在。
- **agent 自报名字可能与选择器标签不一致**：选择器里显示的是预设配置的 label
  （如 `@deepseek-ai/dsh-agent-preset`），而 agent 自报的名字是另一套（如
  `Claude Opus 4.8`）。详情页把两个值都摆出来、不一致就明说，但用户会困惑「为什么
  同一个 agent 有两个名字」。这是 ACP 协议下 agent 自报身份 vs 预设配置的固有差，
  无法消除，只能并列展示。
- **跨机器模型目录读取失败时无提示**：某台主机未连接时，它的 agent 区显示「这台
  主机没有列出任何 acp agent」——但真正原因可能是网络不通、token 过期、或目录
  读取失败，三者在这个空态里无法区分。诊断信息只在主机自己页面的控制台里。

### 落地记录：主机详情「使用 + 部署」闭环（2026-10-14 晚）

用户反馈：光有「检测可达」不够——怎么用上那台主机的 DSH？怎么部署、装插件？
详情页此前只有一个跳回新增页的「重新部署」小按钮，SSH 参数不保存，网页服务重启
后隧道消失、链接失效，一切重来。这一轮把闭环做进详情页，状态机如实呈现：

- **登记簿记住 SSH 连接方式（非秘密）**：新增可选 ssh 字段（目标/端口/用户/
  跳板/认证方式/密钥文件路径/已批准指纹/远端网页端口）。密码与粘贴私钥在
  add 校验里点名拒绝，读侧解析对历史/手改记录宽容但不带回任何秘密
  （registry.spec 钉死）。applyRegistrationEdit 升级：编辑沿用未提及的事实
  （标题/launchUrl/ssh），launchUrl 与新地址源不一致时丢弃而非报错。
- **服务端 connect 路由**：planConnection（纯函数）按 peer 记录如实决策——
  未安装拒绝并指路、缺带令牌网址拒绝并指路、回环监听走隧道、遗留直连记录
  直开；manager.connect 编排 readPeer→ensureTunnel→composeLaunchUrl，
  SSH 原始错误透传不加工。
- **详情页两个新区块**：
  - 「使用这台主机」：隧道状态四种说法（在线/未连通/检查中/未检查）各配按钮
    （连接并打开/重新连接/检查隧道/打开页面）；密钥文件方式免输入重连；
    密码/粘贴私钥方式如实说明不保存并指去部署区；连接失败原文全量展示+重试。
  - 「远程部署与插件」：默认收起；展开后主机名锁定、连接参数自动带出；
    四个动作（检查密钥/读取对方状态/连接不重新部署/部署）+ 升级重装勾选；
    部署进度逐阶段留痕（不再只显最后一行）；失败原文+重试；成功即更新登记
    （地址/访问网址/连接方式）。
- **顺带修了一个既有缺陷**：operation 路由只登记 GET，可用性探测发 HEAD 永远
  404，导致整套 SSH 界面在测试站从未出现。路由补 HEAD 并短路 200。
- 验证：npm run check 971 项全绿；3081 真机浏览器走通：使用区块引导态、部署区
  展开（主机名锁定）、对迷你主机真实 SSH 检查列出三枚真实指纹、连接被真实拒绝
  时原始原因（Permission denied (publickey,password,keyboard-interactive)）
  原样上屏。

### 8.5 落地记录：阶段 L 左树接管（2026-10-15 深夜）

- **接管方式**：优先级 -10 注册进 `sidebar.workspaces` 遮蔽原生工作区列表
  （槽位机制官方语义：同优先级才冲突，数值最小者渲染）。回退开关
  `localStorage.threadharbor.sidebarTree = 'off'`：跳过注册，原生列表回来。
- **组件分工**：HostSessionTree 纯渲染（不发请求，全部 data-* 钩子可点可测）；
  ShadowTreeHost 容器负责本机 30 秒读（cordis 服务 workspaces/sessions 经
  buildHostSessions）、部署过的远端 60 秒拉（ROUTE_REMOTE_SESSIONS，失败原文
  入树）、登记簿合成 RollUpView。
- **阶段 L 过渡**：点远端/未部署主机行 → 切到面板并广播 focus-host 事件打开
  该机详情页（阶段 R 换成主区直接展示会话）；本机项目行内「新会话」经
  uiWorkspace.startSession；远端项目暂无新建（阶段 N）。
- **过程中修掉的真缺陷**：①session-actions 把方法拆离宿主对象裸调丢 this；
  ②cordis 对未授予服务 ctx.get 抛异常（当年代码有 tryRead，漏抄）；
  ③容器 effect 依赖每帧新建数组致远端拉取死循环；④根出口 re-export 服务端
  路由常量把 node 内建拖进浏览器包（verify-build 拦下）。①②③均有回归测试。
- **真机验证（3081）**：原生列表被遮蔽；本机五个真实项目、真实会话全列出；
  点本机会话主区真的打开（hero 出现、输入框出现）；jinmac 灰显未部署+提示；
  开关 off 刷新后原生列表回归；临时注入渲染抛错 → 树消失、页面与侧栏存活、
  原生列表自动顶回（槽位失败即弃权机制），探针已撤并复原。
- 已知边界：外观为复刻简化（无搜索框/右键菜单/归档过滤，后续按需补）；
  远端「边生成边显示」不在本阶段（§8.5 已声明）。

### 8.5 落地补记二：各主机入设置 + 树三处打磨（2026-10-15 午后）

- **各主机移入设置界面**：宿主管理面从「侧栏条目 + 主区面板」改为
  `settings.section` 槽位上的一个分区（排在 Superpowers 之后），完整保留
  登记/连接/部署闭环。侧栏不再有「各主机」条目。设置壳的 openSection
  无跨插件通路（读过全部提供方），树内未部署提示改为文字指引
  「到 设置 → 各主机」；阶段 R 落地后远端行直接开会话，不再需要这层。
- **选中态**：当前打开的会话行高亮（原生同款规则：主视图占用标记
  retainedBy.mainView > 0；面板激活时让位不亮），随服务发布与
  panelInfo 订阅即时刷新。
- **会话编号条**：会话头工具行（conversation.session.header.utilities，
  会话作用域，inject 首参即编号）显示短编号 + 复制按钮，悬停见全号，
  剪贴板拒绝时如实报错。
- **旧格式空白会话兜底**：v3 未迁移的会话运行时缺 blank 标记，按
  「无原始标题且展示名等于项目名或路径基名」识别为空白假会话丢弃；
  用户改过名或 LLM 起过名的会话不受影响（title 有值即保留）。
- 排版与层级（上一轮）：行高/字号对齐原生实测，主机与项目同级缩进、
  仅会话缩进，主机行独立弱化灰。

### 8.5 落地补记三：原生项目行功能全量保留（2026-10-15 晚）

树的项目行与会话行补齐原生列表的整套动作，全部经原生同一批服务派发：
- 项目行：点击折叠/展开（本地记忆），菜单含 新会话/重命名项目/删除项目
  （删除需二次确认），改名走行内输入；重命名与删除落在 workspaces 控制器。
- 会话行：菜单含 重命名会话/归档会话/置顶（及取消）/分叉会话；归档、
  置顶、分叉走 uiWorkspace 服务，会话改名走 sessions.using 的绑定引用
  （原生同一跳数）。收纳阈值对齐原生的 5 条 + 「展开其余 {n} 个会话」。
- 置顶会话排到项目最前（数据面排序 + 组件兜底各一层）；动作失败原文
  上树（data-tree-action-error），不静默。
- 边界如实记：树沿用原生默认「隐藏已归档」，所以菜单没有取消归档
  （原生也要切筛选才看得见已归档行）；视图选项（分组/排序/筛选）与
  搜索框属于区头而非行内功能，留待后续轮次。
