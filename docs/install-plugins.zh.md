# ThreadHarbor 的 DSH 插件：安装说明

**核对时间：2026-10-10。** 下面每一处安装形态都对照 `reference/deepseek-harness`
（master，`5badb15009`）读过，行号在括号里。

---

## 一、先说结论

**三个 agent 各自独立，可以分别装；不装也不影响 DSH 自带的 agent。**

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
              agent: codex
              command: /Users/good/.local/bin/codex-acp
              mode: default

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
              agent: claude
              command: /Users/good/.local/bin/claude-agent-acp
              mode: default
```

**只想要一个？删掉另外两段即可。** 三段之间没有依赖。

### 各家 agent 需要的配置

| agent | 方言 | 连接方式 | 必须写的 |
|---|---|---|---|
| grok | `grok` | WebSocket | `url` |
| codex | `codex` | 子进程 | `command`，且 `mode` 用 `on-request` |
| claude code | `claude` | 子进程 | `command`，且 `mode` 用 `default` |

没有对应二进制就**不要写那一行**——写了会在第一次用到时报连接失败，
而不是安装时报错。

### 可选字段

| 字段 | 作用 |
|---|---|
| `model` | 固定模型；不写就用会话里选的 |
| `mode` | agent 的运行模式，各家取值不同 |
| `cwd` | 工作目录；不写就是进程的工作目录 |
| `models` | 声明各家提供哪些模型，供输入框的模型选择器显示 |
| `hosts` | 限定这台 preset 只在哪些主机上出现 |

`models` 是**声明**而不是探测：探测要求 agent 已经在跑，而模型选择器得在任何
会话被打开之前就能画出来。不写 = 这家暂不提供模型。

---

## 四、几个容易踩的地方

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

---

## 五、当前状态与没做完的部分

**已就绪**

- 三个 agent 的 ACP 接入（帧方言、传输、权限、终端、投影）都在
  `dsh-preset-dispatch` 与 `dsh-acp-agent` 里，三个 agent 走的是同一套代码；
- 宿主入口 `applyAcpPlugin` 已实现并有测试，作用域过滤、未知 agent 不接管、
  单个会话出错不影响其余，都有覆盖；
- 真实 agent 端到端跑通：claude、codex、grok 各一轮，外加权限请求应答后回合继续、
  以及「回合还在跑就已经流出文字」。

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

1. **客户端插件是空的。** 跨主机汇总视图的底层全通（身份、会话发布、分组、
   按主机隔离的设置、preset 按主机过滤），但还没有界面把它画出来。
2. **`exports` 映射没配。** 包目前直接指向 `src/index.ts`；作为组合行被引用时
   Cordis 走的是包名 + 配置，见上文范例。
3. **真实宿主里只验到挂载，还没验到对话。**

   已在真实 DSH（0.2.0-rc.2）上确认：插件能被加载、那一行能被 preset 注册表挂载、
   自报显示读的是投影而不是头部、启动没有失败诊断。

   **没验到的**：接管一个真实会话、写事件、答一次权限请求。原因是会话只能经
   远程接口创建，而一元调用走的是另一条传输通道（流式多路复用明确拒绝它），
   这次没找到那条路。配置里声明 `agents:` 也不行——查过 `AgentOptions`，它根本
   没有 preset 字段，preset 由注册表默认值在**会话创建时**解析，配置声明的启动
   会话绕过了这一步（实测它的 `agentPreset` 投影为 null）。

   所以事件写入与权限应答目前**只有测试覆盖，没有真机确认**。

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
