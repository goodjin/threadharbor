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

**没就绪（重要）**

1. **事件写回与审批接线尚未接上宿主。** 入口目前通过 `install` 这个口子把接管
   交给调用方，写事件、答审批这两件事的 DSH 侧接线还没有实现。
2. **客户端插件是空的。** 跨主机汇总视图的底层全通（身份、会话发布、分组、
   按主机隔离的设置、preset 按主机过滤），但还没有界面把它画出来。
3. **`exports` 映射没配。** 包目前直接指向 `src/index.ts`；作为组合行被引用时
   Cordis 走的是包名 + 配置，见上文范例。

以上三条做完才算「装上就能用」。
