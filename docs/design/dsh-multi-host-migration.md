# ThreadHarbor 迁移到 DSH 原生多主机架构 · 设计与实施方案

> 状态：阶段 1 已完成并固化为 §二；阶段 2 起待执行
> 核对时间：2026-09-14（初核）／**2026-10-09（复核，结论见 §二 各小节的「复核」小节）**
> 核对基准：`deepseek-harness` 官方 master `5badb15009`（复核确认未过期）；本机 DSH 0.2.0-rc.2；grok 1.0.46；codex-acp 1.6.0-grok.3；claude-agent-acp 0.76.0
> 修订：补入界面适配一章（§七）；更正 claude 支持状态的误述（§五）；**2026-10-09 复核推翻 preset 读取路径、补齐六条实施约束、新增 §2.6/§2.7**
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

**重要更正**：本项目**已经支持 claude code 的 ACP**，迁移时 claude 不是从零开始。此前误以为它不支持会话，来源是读错了测试桩——真实代码里 `sessionCapable` 对 claude 取的是「claude 的 ACP 适配器是否装在这台机器上」，装了就为真，与「支不支持会话」无关。

因此三个 agent 的迁移起点是一样的：**ThreadHarbor 侧都已有可用的 ACP 通路**，要搬的是把它们接到 DSH agent 接口上，而不是实现 ACP 本身。

**grok 之外的两个仍需核对真实帧形状**（协议细节与 grok 不同，不能照抄）。

### 5.3 preset 注册

每个 agent 注册为一条 preset（`AgentPresetDefinition` = `id` + `name` + `plugins` 的 Cordis 组合）。

**preset 按主机独立**：DSH 的 preset 注册表本就是每进程一份，远端 DSH 只注册自己实际装了/登录了的 agent。因此**未装 codex 的主机不会显示 codex preset**，天然满足需求。

### 5.4 zcode（Z.ai / GLM）：目前无法接入

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

代价（已知并接受）：
- 每个标签页是一条独立连接，聚合层要自建跨页通信与状态合并
- 关闭某台主机的标签页即等于该主机离线，聚合层要能处理「主机消失」
- 凭证仍留在各自主机的浏览器侧，不进聚合层——这与 §8.2「凭证留在主机侧」一致

**跨页通信的实现选型留到阶段 4 开工时定**（`BroadcastChannel` / `localStorage` 事件 / `postMessage` 均可行，
取决于聚合层是同源页面还是独立扩展）。

---

## 九、中途切换 agent

### 9.1 事实

DSH 硬拦（§2.4），不可绕过。注意复核结论：锁是**永久**的（有过任何回合即锁死），且只在 `turnBoundary` 投影在场时生效。

### 9.2 做法

复用 ThreadHarbor 已实现的 `session.switch`：

1. 读当前会话完整 transcript
2. 目标主机上选目标 preset（+模型）
3. 建新会话，把 transcript **完整交接**（不截断）
4. 目标 agent 承担不了那么长时**如实报错**，让用户换一个，而不是静默截断

跨主机切换时，交接文本需通过 remote 通道送达目标主机。

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
3. 界面按主机 → 项目 → 会话 分组
4. 设置按主机绑定
5. preset 可用性按主机过滤

**验证**：两台 DSH，界面能看到两边会话并按主机分组。

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