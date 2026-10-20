# ThreadHarbor

ThreadHarbor 是 DeepSeek Harness 的独立 Web 插件，把外部 agent 接进 DSH：grok、codex、claude code、cursor、qoder 走 ACP，zcode 与 minimaxi 是模型列表里单独的两组（GLM 与 MiniMax）。每个都是一条 preset，会话仍是 DSH 原生会话，由原生的侧栏、会话界面和模型基础设施直接呈现。没有独立的 daemon——连接由提供页面的那台机器上的 DSH 进程持有。

它不是 DeepSeek Harness 的 fork，也不包含 Harness 源码。开发用的 Harness checkout 位于被 Git 忽略的 `reference/deepseek-harness/`。

> 多主机迁移（hostd/gateway 下线）的背景、事实核对与分阶段计划见
> [docs/design/dsh-multi-host-migration.md](docs/design/dsh-multi-host-migration.md)；
> 旧架构描述见 [docs/architecture.zh.md](docs/architecture.zh.md)（文首有过时标注）。

## 当前能力

以下每条都以当前代码为准（核对时间 2026-10-16；「真机可达」按 `tests/wiring.spec.ts` 从宿主加载入口做的传递可达性检查口径）：

- 五个 agent（grok、codex、claude code、cursor、qoder）走同一套通用 ACP 接入层（`@threadharbor/dsh-acp-agent`）：stdio 与 WebSocket 两种传输、各家的帧方言、帧到 DSH 会话事件的投影、终端与文件两个子协议的应答。zcode 不走这条路：它在模型列表里单独成一组 GLM，用本机 ZCode 的登录密钥直连 Coding Plan，文字和工具调用交回 DSH 自己的循环。它的 5 小时/周套餐限额也带到了界面上（核对时间 2026-10-16）：GLM 会话的输入框下方、token 用量同一排有两枚胶囊，显示已用百分比，悬停看已用/总量和重置时刻，详见 [docs/agent-acp/zcode.md](docs/agent-acp/zcode.md)。 minimaxi 是同一条路的第二个模型插件：模型列表里单独一组 MiniMax，用本机 MiniMax Code 的登录凭据直连托管网关，凭据的读取与刷新采用官方那套实现，与桌面版共用同一个文件和同一把锁（核对时间 2026-10-20，国内站真机已跑通含工具调用的多轮），详见 [docs/agent-acp/minimaxi.md](docs/agent-acp/minimaxi.md)。
- 权限请求桥接到 DSH 审批服务：请求在回合内发起，应答是回带同一 id 的 JSON-RPC 响应帧；宿主没有审批服务时一律拒绝并在启动自报里写明 `approvals=refuse-all`。
- 流式：回合进行中经 `agent/assistant-stream` 通道增量下发，回合结束后落一条内嵌压缩流的持久 `assistant/message`；两段靠同一 attemptId 对上。
- 断连与进程退出会判明并结束回合，不再无限等待；会话按会话 id 隔离外部对话，一个会话一个外部会话。
- 中途切换 agent（判定 / 历史交接 / 执行三段）：已经在说话的会话锁死了预设，只能在目标预设上新建会话继续。切换时整段对话既作为上下文交给新 agent，也原样回填到新会话自己的记录上——打开新会话看到的还是刚才那段对话，只是底下接上了新的内容；旧会话留下一条交接提示并自动跳过去。轮次历史的可读性同理有兜底：「被打断且全程没有正文」的轮次（长工具轮次遇重启的常态）会在轮次结尾出现一条找回入口，一键展开全部过程内容（核对时间 2026-10-16）。
- 切换过程看得见：面板整个换掉，所以切换一开始就在窗口顶部挂一条进度（准备 → 读新会话的历史 → 就绪），同时先把新会话的首屏读出来，读完才跳过去，跳过去时内容已经在屏幕上。首屏读不出来或迟迟不来都不卡住跳转，最多等 4 秒。历史长不长都只取首屏（DSH 自带的分页，约 50 条消息起），更早的用「加载更早」按页取。
- 主机侧的 agent 探测（发一条真实小任务看是否回应）与重启已实现，但目前没有界面入口。
- 云主机中转通道（核对时间 2026-10-16）：`@threadharbor/dsh-mobile-relay` 让手机只经公网 HTTPS 连一台云主机、不装 Tailscale，即可切换多台机器——数据面是 SSH 本地隧道，tailnet 只做在线发现。入口 `dsh.agentlab.fun`（灰云 DNS + Let's Encrypt + nginx 反代 + 一层 HTTP 口令），机器清单、会话转发、审批按机器归属与事件汇流都在这个包里；配置片段由 `scripts/relay-setup.sh` 生成（只打印，不改文件）。
- 手机通道（核对时间 2026-10-15）：`@threadharbor/dsh-mobile-relay` 经 `@threadharbor/dsh-mobile-entry` 的路由实现在 DSH Web 上挂 `/threadharbor/mobile/` 手机页——主机清单（tailnet 名单 + 各机 DSH 探测）、看会话、发消息、批权限、停止回合——以及先过官方准入的 `peers` / `pair-url` 两个接口。桌面侧栏「手机配对」面板出二维码（需配置 `mobileOrigin`，只收 https 源），手机扫码经官方授权入口把令牌换成 cookie 完成配对。可达性由 `tailscale serve --bg` 提供，dsh 启动须带 `--trusted-host`；`scripts/mobile-setup.sh <dsh端口>` 一键完成发布并打印两步配置，详见 [docs/mobile-client.zh.md](docs/mobile-client.zh.md)。
- 同一窗口管理多台主机（核对时间 2026-10-18）：左侧树列出本机和其他已登记主机的项目与会话。点其他主机，主区通过本机网关打开那台机器自己的 DSH 界面，浏览器调的还是那套接口，只是地址换成了登记簿里的那台；审批、流式、模型选择和上传都在这个界面里。会话仍跑在那台主机上。登录 cookie 留在本机网关，不写进浏览器。
- 原生 dsh preset 的行为不受影响：组合行只认得自己 presetId 下的会话，其余一律不接管。
- 各 agent 的端到端活测（建会话 → 提问 → 收到回答 → 工具调用正确投影、权限批准后回合继续）默认跳过，带 `THREADHARBOR_LIVE_ACP=1` 运行；见下文「真机活测」。
- ACP 五家里的委派看得见（核对时间 2026-10-20）：握手声明 [ACP 子代理草案](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992)的 `subagents` 能力后，codex 与 claude 的子代理委派、claude 的后台任务以原生帧（`subagent_spawned` 等）到达，实时投成 `subagent` / `async_task` 卡片，子会话内容不漏进父回答（单测照真实抓包钉死投影行为；codex / claude / grok 三家帧级真机验收均已通过，2026-10-20）；grok 不实现草案但发自己的一套子代理帧（私有方法名＋蛇形字段，经方言归一化后同样投成卡片，真机抓包已钉死）；cursor 与 qoder 忽略该字段。帧表与投影规则见 [docs/agent-acp/README.md](docs/agent-acp/README.md)。

**已知未接的部分**（代码与测试都在，但从宿主加载的入口走不到，登记在 `tests/wiring.spec.ts` 的 `KNOWN_UNWIRED`）：

- 早期入口 `packages/dsh-preset-dispatch/src/service.ts` 与现行 `entry.ts` 重叠，只剩导出和测试在用。
- 手机协议常量 `packages/dsh-mobile-entry/src/wire.ts` 目前是记录，手机页用的是硬编码的 `mobile/wire.js`。

## 插件清单

`cordis.patch.yml` 是安装到 DSH Web profile 的标准 bundle patch。它插入下面这些条目，装载器按行 id 导入对应模块并执行其 `apply`（`host-store` 是纯声明式的一行，只提供一个 volatile 设置字段）。

### 运行时插件

| 插件 | 组合行 id | 用途 |
| --- | --- | --- |
| `@threadharbor/dsh-client` | `threadharbor-client` | 浏览器侧的全部 ThreadHarbor 界面：左侧多主机树与主机切换、设置里的「各主机」、手机配对二维码、输入框模型入口（外部 agent 前缀）、GLM 配额胶囊、被打断轮次的找回入口，以及设置里的「提供方与模型」屏蔽栏（只过滤模型选择器，可整体或逐模型屏蔽任何提供方——ACP agent 与内置 provider 都算；官方「模型」设置页照旧列出全部，密钥不受影响，随时可恢复）。 |
| `@threadharbor/dsh-host-federation/host-store` | `threadharbor-host-store` | 宿主侧设置槽：把主机登记簿、本机默认身份、提供方/模型屏蔽等选择存进这台机器的 profile 文档（浏览器经 `remote.settings` 读写），换浏览器或清缓存都不会丢。 |
| `@threadharbor/dsh-host-federation/tailscale` | `threadharbor-tailscale` | 在提供页面的机器上运行 `tailscale status --json`，把 peer 清单写进 host-store 的 `data` 字典，供「从 Tailscale 选主机」使用。 |
| `@threadharbor/dsh-host-federation/ssh-deploy` | `threadharbor-ssh-deploy` | 主机侧 SSH 部署与远端操作接口：检查连通性、安装/启动远端 DSH、读取远端会话和执行运维操作。 |
| `@threadharbor/dsh-host-federation/host-gateway` | `threadharbor-host-gateway` | 同源反向代理：浏览器把普通 DSH 请求发到本机 `/threadharbor/gateway/<主机标识>/`，由它转到登记主机自己的 DSH；登录 cookie 留在网关，不进浏览器。 |
| `@threadharbor/dsh-mobile-relay` | `threadharbor-mobile-relay` | 云主机侧的手机中转：公网 HTTPS 入口、手机页壳、`pair-url` / `peers`、SSH 隧道、会话/审批/事件转发。本机没有中转配置时默认停用、不注册。 |
| `@threadharbor/dsh-preset-dispatch/roster-filter` | `threadharbor-roster-filter` | 把标了 `hideFromRoster: true` 的 ACP preset 从新建会话/预设选择器中隐藏；注册本身保留，所以模型列表切换和会话接管仍可用。内部 `list()` 不过滤。 |
| `@threadharbor/dsh-preset-dispatch/zcode-quota` | `threadharbor-zcode-quota` | 宿主侧读取本机 ZCode 登录凭据并查询 Coding Plan 的 5 小时/周限额，供输入框下方的 GLM 配额胶囊显示；密钥不出宿主进程。 |

### Agent preset 行

七个 agent 不是七个 ThreadHarbor 插件包，而是七条 DSH 的 `@deepseek-ai/dsh-agent-preset` 组合行；每条内嵌同一个 `@threadharbor/dsh-preset-dispatch`（binding），只是配置不同。dispatch 负责把外部 agent 的回合、流式输出、审批/提问、模型目录、会话交接与写回接进 DSH 原生会话。

| preset / 组合行 | 名称 | 接入方式与用途 |
| --- | --- | --- |
| `acp-codex` / `acp-codex-binding` | Codex | stdio ACP，拉起本机 `codex-acp`；模型清单写在 preset 配置里。 |
| `acp-claude` / `acp-claude-binding` | Claude | stdio ACP，拉起本机 `claude-agent-acp`；默认使用逐次询问的 `default` 模式。 |
| `acp-grok` / `acp-grok-binding` | Grok | WebSocket 传输：先拉起 `grok agent serve`（随机端口、密钥、就绪等待、退出回收），再连接它返回的 ws 地址。 |
| `acp-cursor` / `acp-cursor-binding` | Cursor | stdio ACP，拉起 `cursor-agent` 并补上 `acp --trust`；模型 id 按配置组合独立成行，不按推理档归并。 |
| `acp-zcode` / `acp-zcode-binding` | ZCode | 模型插件，不拉进程：解密本机 ZCode 登录凭据后直连 GLM Coding Plan；工具调用和会话记录仍由 DSH 自己的循环处理。 |
| `acp-minimax` / `acp-minimax-binding` | MiniMax | 模型插件，不拉进程：读取并刷新本机 MiniMax Code 凭据，直连 MiniMax 托管网关；区域从凭据目录自动判断。 |
| `acp-qoder` / `acp-qoder-binding` | Qoder | stdio ACP，拉起 `qoderclicn` 并补上 `--acp`；启动时剥掉 IDE 注入的 SDK 环境变量。 |

### 只作为库引用的包

这些包没有独立的组合行，被上面的插件 import：

- `@threadharbor/dsh-acp-agent` — 通用 ACP 接入层：客户端、stdio/WebSocket 传输、各家方言、帧投影、终端与文件子协议、准入与参数补齐。dispatch 的 ACP 路径都走它。
- `@threadharbor/zcode-acp` — ZCode/GLM 模型客户端：登录凭据解密、Anthropic 格式请求、流解析、Coding Plan 配额查询。
- `@threadharbor/minimaxi-acp` — MiniMax 模型客户端：凭据发现与刷新、请求构造、流解析、模型能力表。
- `@threadharbor/dsh-mobile-entry` — 手机页静态资源、`pair-url` / `peers` 的路由实现。直连模式取消后不再独立挂载，由 `dsh-mobile-relay` 调用其导出函数出页面。
- `@threadharbor/dsh-host-federation`（主入口） — 主机身份、登记簿、跨标签页通道、分组视图与网关路径等共享库；上面挂载的是它的 `host-store` / `tailscale` / `ssh-deploy` / `host-gateway` 子路径入口。

## 安装到 DeepSeek Harness

完整安装、升级、卸载见 [docs/install.zh.md](docs/install.zh.md)；如何把各家 agent 组合成 preset 见 [docs/install-plugins.zh.md](docs/install-plugins.zh.md)。

npm 包发布后可直接作为标准 DSH bundle 安装：

```sh
dsh plugin --profile web add threadharbor
dsh --profile web
```

当前仓库可直接从源码链接安装：

```sh
git clone https://github.com/goodjin/threadharbor.git
cd threadharbor
corepack pnpm install
pnpm run build
dsh plugin --profile web add link:.
dsh --profile web
```

源码链接安装依赖这个 checkout 及其 `node_modules` 和 `lib`，不要在卸载前移动或删除目录。`npm run reference:checkout` 只创建被忽略的 `reference/deepseek-harness/`，用于开发时核对公开 API；运行和打包均不需要该参考目录。

装好后 agent 不会自动出现：每个 agent 需要在 profile 组合里加一条 preset 行（`@deepseek-ai/dsh-agent-preset` 内嵌 `@threadharbor/dsh-preset-dispatch`），写明 `presetId`、`agent` 与连接方式。配置支持可选的 `args`；省略时按 `agent` 补上它说 ACP 所必需的默认参数（cursor 是 `acp --trust`，qoder 是 `--acp`），显式写了则完全以配置为准。qoder 子进程还会剥掉 IDE 注入的 SDK 入口环境变量（`QODER_*`、`CLAUDE*`、`VSCODE_*` 等），否则从 Qoder IDE 终端启动时会直接退出。

preset 行注册后，agent 的模型会进全局模型目录，从模型列表即可切换；binding 上的 `hideFromRoster: true` 让 `threadharbor-roster-filter` 按标记把这些 preset 从选择器名册里隐藏（切换机制依赖注册本身，不能直接删行），细节见 [docs/install-plugins.zh.md](docs/install-plugins.zh.md)。

## 真机活测

`packages/dsh-acp-agent/tests/live.spec.ts` 与 `packages/dsh-preset-dispatch/tests/live.spec.ts` 会拉起真实的 agent 二进制跑完整回合，默认跳过：

```sh
THREADHARBOR_LIVE_ACP=1 npx vitest run packages/dsh-acp-agent/tests/live.spec.ts
```

需要 PATH 上有 `claude-agent-acp`、`codex-acp`、`cursor-agent`、`grok` 和 `qoderclicn`（国际版为 `qodercli`）；可用 `THREADHARBOR_CLAUDE_ACP` / `THREADHARBOR_CODEX_ACP` / `THREADHARBOR_CURSOR_ACP` / `THREADHARBOR_QODER_ACP` 覆盖二进制路径。Qoder 需先在本机完成一次 `qoderclicn login`。活测驱动真实模型，一轮要几十秒。

## 仓库结构

```text
packages/dsh-acp-agent/        通用 ACP 接入层：客户端、传输、各家方言、投影、终端/文件子协议
packages/dsh-preset-dispatch/  preset 组合行（宿主加载入口 entry.ts）：分流、回合驱动、写回、流式；另含 roster-filter / zcode-quota 两个宿主插件
packages/dsh-client/           浏览器插件：左侧主机树、主机切换、「各主机」设置、手机配对二维码、模型入口与「提供方与模型」屏蔽等界面
packages/dsh-host-federation/  跨主机汇总的库与宿主插件：主机身份、设置存储、Tailscale 桥、SSH 部署、同源网关
packages/dsh-mobile-entry/     手机页与 pair-url / peers 的路由库（由 dsh-mobile-relay 复用，不再独立挂载）
packages/dsh-mobile-relay/     手机中转（云主机侧）：公网入口、手机页、SSH 隧道、会话/审批/事件转发
packages/zcode-acp/            ZCode/GLM 模型客户端：凭据解密、请求、流解析、套餐配额
packages/minimaxi-acp/         MiniMax 模型客户端：凭据发现/刷新、请求、流解析
tests/wiring.spec.ts           「代码对」与「代码跑得到」分开检查；到不了的模块登记在 KNOWN_UNWIRED
cordis.patch.yml               安装到 DSH Web profile 的标准 bundle patch（浏览器插件、宿主插件与 agent preset 行）
reference/                     被 Git 忽略的 DeepSeek Harness 参考源码
```

设计说明见 [docs/design/dsh-multi-host-migration.md](docs/design/dsh-multi-host-migration.md)，各 agent 的对接实测见 [docs/agent-acp/](docs/agent-acp/README.md)，AgentHarbor/SessionPort 对比见 [docs/landscape.zh.md](docs/landscape.zh.md)。通过 SSH 在远端安装 DSH 见 [docs/ssh-deploy.zh.md](docs/ssh-deploy.zh.md)。手机端（Android）的通道、配对与手机页见 [docs/mobile-client.zh.md](docs/mobile-client.zh.md)。zcode 与 minimaxi 两组模型贴着 ZCode 与 MiniMax Code 两个上游走，依赖哪些上游事实、上游更新时如何判断要不要跟，见 [docs/upstream-sync.zh.md](docs/upstream-sync.zh.md)。

## 开发检查

```sh
npm run typecheck
npm run test
npm run build
```

`npm run test` 里包含 wiring 检查：凡是从宿主加载入口走不到、又没有在 `KNOWN_UNWIRED` 登记说明的模块，测试直接失败。

## 本地开发与双通道

`scripts/dev.sh` 管理本地 DSH Web 开发实例，动作 `start | stop | restart | status`，目标只有 `web | all`（hostd 目标已随阶段 6 删除）：

```sh
scripts/dev.sh status            # 默认 channel test，端口 3081
scripts/dev.sh restart web       # 重启前先 npm run build
```

常用覆盖变量见脚本头部注释：`THREADHARBOR_DSH_BIN`、`THREADHARBOR_CHANNEL` / `THREADHARBOR_WEB_PORT` / `THREADHARBOR_DSH_HOME` 等。web 的日志/pid 在 `$DSH_HOME/threadharbor-runtime/{web.log,web.pid}`。

stable / test 双通道发版规范见 [docs/release-channel.zh.md](docs/release-channel.zh.md)。原来的按频道补丁文件 `deploy/channels/<channel>.patch.yml` 已随 hostd 部署一起删除；`dev.sh` 与 `release-channel.mjs` 现在把补丁当可选项——目录里有就用，没有就以 profile 自己的组合启动。

## 安全原则

- 凭据不经过浏览器：agent 用自己机器上的登录态，Web 侧只见会话内容。
- 权限决定权在人：外部 agent 的权限请求走 DSH 审批服务，桥接层宁可拒绝错、不可放行错；没有审批服务时全拒。
- 配置只声明 agent 入口（`url`，或 `command` + 可选 `args`），浏览器不能提交可执行文件或 shell。
- MIT License。
