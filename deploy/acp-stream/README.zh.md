# dsh-acp 外补丁：让远程会话真正边生成边显示

## 解决的问题

ThreadHarbor 的远程后端由 hostd 以 `dsh --profile acp` 启动，经 ACP（JSON-RPC stdio）与 Gateway 通信。官方 `@deepseek-ai/dsh-acp` 只在一条消息**落盘之后**才把它转成 ACP 通知：订阅的是 `session/event`，只处理 `assistant/message` 这类已提交事件，把每个内容块原样发成一帧。

后果是，模型思考期间 hostd 收不到任何帧；一条长思考块生成完毕后，客户端在几百毫秒内收到一个几万字符的单帧。表现为"长时间没动静，然后突然全部出现"。

实测（`mimo-v2.6-pro`，jianmo 项目）：静默 588 秒后到达一帧 68,233 字符的 `agent_thought_chunk`。帧大小与静默时长严格成正比（生成速率约 110 字符/秒），证明是"攒完一次性交"，不是模型本身慢。

hostd 侧的合并器与 200ms 空闲刷新逻辑是正常的，但它按帧工作：那段时间零输入，无帧可合；帧到达时已是完整一块，直接整帧入日志。

## 改法

DSH 的 agent loop 本身**已经**把每个模型增量发到 cordis 总线上，事件名 `agent/assistant-stream`——官方 GUI 的实时刷新就是订阅它实现的（`dsh-api-session-controller` 订阅后逐帧推给前端）。只是 acp profile 里没有承载这套推送的服务，ACP 桥接也没订阅，于是这份实时数据白白丢掉。

外补丁因此只做两件事，都在插件侧完成，不改官方包：

1. 订阅这个事件，把每条增量立刻转成对应的 ACP 更新（推理增量 → `agent_thought_chunk`，正文增量 → `agent_message_chunk`），经桥接自己的连接发出去，因此顺序与其它消息、工具调用天然一致；
2. 块落盘时桥接还会再发一次同样的内容，relay 在这里把它去掉——只补发实时流没覆盖到的尾巴。文本因此只出现一次。

工具调用这类没法逐字呈现的内容，仍走桥接原路径，再经过一层分片兜底（`stream-pacer.mjs`），所以任何情况下都不会退化成一个几万字符的大块。

## 挂载方式

patch 里的 `name` 字段是**断言**不是覆盖，写错会整条跳过，所以做法是停用官方条目、插入一个替换条目。替换模块读出官方源码，只改两处，都在唯一锚点上：

- 在桥接拿到 ACP 连接的那一刻，把连接交给 relay；
- 在桥接转发已提交块的那一刻，先过 relay 去重，再交给分片器。

任一锚点不唯一、官方挪了代码、导出面变化、缓存副本导入失败——任何一步失败都退回官方原模块，并在 stderr 打印一行原因。最坏情况是回到今天的行为，不会崩，也不会跑一份过期的代码。缓存副本按官方源码哈希命名，DSH 升级自动失效重生成。

缓存目录在 DSH 包树外，所以额外建一个指向官方 `node_modules` 的符号链接，让副本里的裸导入仍能解析。

## 文件

| 文件 | 作用 |
|---|---|
| `live-stream.mjs` | 实时增量转发、提交去重、桥接挂载 |
| `stream-pacer.mjs` | 分片与节奏，实时流覆盖不到时的兜底 |
| `acp-source-transform.mjs` | 官方源码改写（锚点唯一性校验） |
| `acp-stream-entry.mjs` | profile 加载的入口：定位官方包、改写、缓存、兜底 |
| `install.mjs` | 安装 / `--check` / `--uninstall` |
| `verify.mjs` | 真实起一次 ACP 后端，握手 + 跑一轮并统计 |

## 使用

```bash
# 安装（默认写入 $DSH_HOME/profiles/acp）
node deploy/acp-stream/install.mjs

# 查看当前状态：补丁块、模块是否最新、解析后的条目
node deploy/acp-stream/install.mjs --check

# 跑一次验证：握手 + 一轮真实对话
node deploy/acp-stream/verify.mjs --prompt "讲一个需要长思考的技术问题"

# 恢复官方条目（原文件按 .th-acp-stream.bak 逐字节还原）
node deploy/acp-stream/install.mjs --uninstall
```

hostd 启动后端时不带额外参数，所以补丁必须落在 `acp` profile 自己的 `cordis.patch.yml` 里。`DSH_HOME` 和 `DSH_BIN` 可覆盖目标与可执行文件。

**已经在跑的后端不会立刻变**：每个 hold 是独立进程，新补丁对之后新建的 hold 生效。

## 可调参数（环境变量）

| 变量 | 默认 | 含义 |
|---|---|---|
| `THREADHARBOR_ACP_STREAM_LIVE` | 开启 | 关掉实时转发，只保留分片回放 |
| `THREADHARBOR_ACP_STREAM_SLICE_CHARS` | 800 | 兜底分片的每片字符数 |
| `THREADHARBOR_ACP_STREAM_MIN_INTERVAL_MS` | 60 | 片间最小间隔 |
| `THREADHARBOR_ACP_STREAM_MAX_INTERVAL_MS` | 250 | 片间最大间隔 |
| `THREADHARBOR_ACP_STREAM_MAX_TOTAL_MS` | 15000 | 单个大块回放的总时长上限 |
| `THREADHARBOR_ACP_STREAM_KINDS` | `agent_thought_chunk,agent_message_chunk` | 参与兜底分片的通知类型 |
| `THREADHARBOR_ACP_STREAM_CACHE` | 系统临时目录 | 改写副本的缓存位置 |

## 验证记录

同一台机器、同一个模型（`mimo-v2.6-pro`）、同一个问题，改动前后各跑一轮真实对话：

| | 改之前 | 改之后 |
|---|---|---|
| 首个字符出现 | 静默 200 秒后 | 1.9 秒 |
| 文本帧数 | 个位数 | 2,691 |
| 单帧最大字符 | 68,233 | 49 |
| 超过 800 字符的帧 | 有 | 0 |

完整性核对：客户端实时收到 3,715 字符，同一会话落盘消息里推理 2,314 + 正文 1,401 = 3,715 字符，工具调用块另行送达。**不丢不重**。

## 已知边界

- 只转发能逐字呈现的增量。工具调用、图片等仍等落盘后整块送达（体量本来就小）。
- 一次请求重试时，中断的那次尝试已经发出去的半截文本会保留在客户端，新尝试另起一段——与官方桥接对重试的表现一致。
- relay 订阅的是进程内所有 agent 的实时流。acp profile 是每个 hold 独立起一个进程，进程内只有这一个客户端的会话，正常不会串台。
