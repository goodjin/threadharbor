# ThreadHarbor

ThreadHarbor 是 DeepSeek Harness 的独立 Web 插件，把外部 ACP agent（grok、codex、claude code、cursor、zcode）接进 DSH：每个 agent 是一条 preset 组合行，会话仍是 DSH 原生会话，由原生的侧栏、会话界面和模型基础设施直接呈现。没有独立的 daemon——agent 子进程与连接由提供页面的那台机器上的 DSH 进程持有。

它不是 DeepSeek Harness 的 fork，也不包含 Harness 源码。开发用的 Harness checkout 位于被 Git 忽略的 `reference/deepseek-harness/`。

> 多主机迁移（hostd/gateway 下线）的背景、事实核对与分阶段计划见
> [docs/design/dsh-multi-host-migration.md](docs/design/dsh-multi-host-migration.md)；
> 旧架构描述见 [docs/architecture.zh.md](docs/architecture.zh.md)（文首有过时标注）。

## 当前能力

以下每条都以当前代码为准（核对时间 2026-10-13；「真机可达」按 `tests/wiring.spec.ts` 从宿主加载入口做的传递可达性检查口径）：

- 五个 agent 走同一套通用 ACP 接入层（`@threadharbor/dsh-acp-agent`）：stdio 与 WebSocket 两种传输、各家的帧方言（工具名/输出/模型列表位置各家不同，分别实现）、帧到 DSH 会话事件的投影、终端与文件两个子协议的应答。zcode 说的不是 ACP 而是本机 ZCode 桌面版的自有协议，由适配器包 `packages/zcode-acp` 翻译（凭证解密注入、密钥不落日志）。
- 权限请求桥接到 DSH 审批服务：请求在回合内发起，应答是回带同一 id 的 JSON-RPC 响应帧；宿主没有审批服务时一律拒绝并在启动自报里写明 `approvals=refuse-all`。
- 流式：回合进行中经 `agent/assistant-stream` 通道增量下发，回合结束后落一条内嵌压缩流的持久 `assistant/message`；两段靠同一 attemptId 对上。
- 断连与进程退出会判明并结束回合，不再无限等待；会话按会话 id 隔离外部对话，一个会话一个外部会话。
- 中途切换 agent（判定 / 历史交接 / 执行三段）：已经在说话的会话锁死了预设，只能在目标预设上新建会话继续。切换时整段对话既作为上下文交给新 agent，也原样回填到新会话自己的记录上——打开新会话看到的还是刚才那段对话，只是底下接上了新的内容；旧会话留下一条交接提示并自动跳过去。
- 切换过程看得见：面板整个换掉，所以切换一开始就在窗口顶部挂一条进度（准备 → 读新会话的历史 → 就绪），同时先把新会话的首屏读出来，读完才跳过去，跳过去时内容已经在屏幕上。首屏读不出来或迟迟不来都不卡住跳转，最多等 4 秒。历史长不长都只取首屏（DSH 自带的分页，约 50 条消息起），更早的用「加载更早」按页取。
- 主机侧的 agent 探测（发一条真实小任务看是否回应）与重启已实现，但目前没有界面入口。
- 原生 dsh preset 的行为不受影响：组合行只认得自己 presetId 下的会话，其余一律不接管。
- 各 agent 的端到端活测（建会话 → 提问 → 收到回答 → 工具调用正确投影、权限批准后回合继续）默认跳过，带 `THREADHARBOR_LIVE_ACP=1` 运行；见下文「真机活测」。

**已知未接的部分**（代码与测试都在，但从宿主加载的入口走不到，登记在 `tests/wiring.spec.ts` 的 `KNOWN_UNWIRED`）：

- 按主机过滤 preset：配置里的 `hosts` 字段目前不生效。
- 跨主机汇总面板：联邦、分组视图、按主机隔离的设置都已实现并有测试，但面板未挂进侧栏。

## 安装到 DeepSeek Harness

完整安装、升级、卸载见 [docs/install.zh.md](docs/install.zh.md)；如何把五个 agent 组合成 preset 见 [docs/install-plugins.zh.md](docs/install-plugins.zh.md)。

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

装好后 agent 不会自动出现：每个 agent 需要在 profile 组合里加一条 preset 行（`@deepseek-ai/dsh-agent-preset` 内嵌 `@threadharbor/dsh-preset-dispatch`），写明 `presetId`、`agent` 与连接方式。注意：起子进程的 agent 目前只能给一个裸 `command`，配置里**没有 `args` 字段**，要带参数得自己包一层脚本。

preset 行注册后，agent 的模型会进全局模型目录，从模型列表即可切换；binding 上的 `hideFromRoster: true` 让 `threadharbor-roster-filter` 按标记把这些 preset 从选择器名册里隐藏（切换机制依赖注册本身，不能直接删行），细节见 [docs/install-plugins.zh.md](docs/install-plugins.zh.md)。

## 真机活测

`packages/dsh-acp-agent/tests/live.spec.ts` 与 `packages/dsh-preset-dispatch/tests/live.spec.ts` 会拉起真实的 agent 二进制跑完整回合，默认跳过：

```sh
THREADHARBOR_LIVE_ACP=1 npx vitest run packages/dsh-acp-agent/tests/live.spec.ts
```

需要 PATH 上有 `claude-agent-acp`、`codex-acp` 和 `grok`；可用 `THREADHARBOR_CLAUDE_ACP` / `THREADHARBOR_CODEX_ACP` 覆盖二进制路径。活测驱动真实模型，一轮要几十秒。

## 仓库结构

```text
packages/dsh-acp-agent/        通用 ACP 接入层：客户端、传输、三家方言、投影、终端/文件子协议
packages/dsh-preset-dispatch/  preset 组合行（宿主加载入口 entry.ts）：分流、回合驱动、写回、流式
packages/dsh-client/           浏览器插件：目前只承担跨主机汇总的挂载点（面板未挂）
packages/dsh-host-federation/  跨主机汇总的库：主机身份、跨标签页通道、分组视图、按主机设置
tests/wiring.spec.ts           「代码对」与「代码跑得到」分开检查；到不了的模块登记在 KNOWN_UNWIRED
cordis.patch.yml               安装到 DSH Web profile 的标准 bundle patch（只插浏览器插件）
reference/                     被 Git 忽略的 DeepSeek Harness 参考源码
```

设计说明见 [docs/design/dsh-multi-host-migration.md](docs/design/dsh-multi-host-migration.md)，各 agent 的对接实测见 [docs/agent-acp/](docs/agent-acp/README.md)，AgentHarbor/SessionPort 对比见 [docs/landscape.zh.md](docs/landscape.zh.md)。通过 SSH 在远端安装 DSH 见 [docs/ssh-deploy.zh.md](docs/ssh-deploy.zh.md)。手机端（Android）接入方案尚未实现，见 [docs/mobile-client.zh.md](docs/mobile-client.zh.md)。

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
- 配置只声明 agent 入口（`url` 或裸 `command`），浏览器不能提交可执行文件或 shell。
- MIT License。
