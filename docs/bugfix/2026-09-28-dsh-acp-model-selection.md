# Bug Fix: ThreadHarbor 的 DSH 会话无法选择或切换模型

## 问题描述
- 日期: 2026-09-28
- 严重程度: Medium
- 影响范围: 所有 DSH 后端会话。主机用户在 DSH Web 的 Models 页配置了 DeepSeek 模型和多提供方路由，但在 ThreadHarbor 里选 dsh 新建会话时既看不到模型清单，也无法在会话中途切换；会话固定使用 hostd 启动参数里的 `deepseek-official` / `deepseek-v4-flash`。

## 根因分析
- 问题位置: `packages/hostd/src/agent-manager.ts`（DSH 发现与安装）、`packages/hostd/src/server.ts`（会话绑定与 transport）
- 原因: DSH 后端此前启动的是官方 wheel 里的 JSON-RPC 运行时。那份运行时的组成是精简版——随包 `cordis.yml` 只挂了一个 DeepSeek 适配器，凭据靠 hostd 注入的单个 key——而且它的协议在客户端方向只有 `initialize` / `session/prompt` / `shutdown` 三个方法：没有"有哪些模型"，也没有"换模型"，模型在 initialize 时定一次就锁死。主机 DSH 配置里的模型路由因此根本不会被读到。
- 代码流程: 网关 `session.start` → hostd `spawnHold`（wheel 运行时 + `DSH_SESSION_ROOT`）→ `initializeHold` 传 `provider`/`model` → hold worker 对 DSH 走 SDK 专用分支（`session.event` / `session.status` 判定轮次结束、取消时重启 stdio 进程）。

## 修复方案
- 修改文件: `packages/hostd/src/agent-manager.ts`、`packages/hostd/src/bin.ts`、`packages/hostd/src/server.ts`、`packages/hostd/src/hold-worker.ts`、`packages/hostd/src/hold-protocol.ts`、`packages/dsh-gateway/src/{index,projection,run-usage,session-config}.ts`、`packages/dsh-client/src/client/{store.ts,RemoteConversation.tsx}`
- 修改内容:
  - DSH 后端改用官方 npm 包 `@deepseek-ai/dsh`，每个会话启动它随包发布的 `dsh --profile acp`（automation-only ACP profile）。安装计划随之变成 `npm install -g @deepseek-ai/dsh@0.1.5-rc.1`，pip / wheel 定位与 `pythonCommand` 面全部移除，`dsh-sessions.ts`（wheel 时代的 JSONL 迁移）一并删除。
  - 握手与会话绑定统一走 ACP：`initialize` 只发协议版本与客户端能力；新会话 `session/new`，重开按后端选 `session/load`（Codex / Claude）或 `session/resume`（Harness acp profile 明确不实现 `session/load`）。
  - gateway 的 `session-config` 现在会展开 ACP 分组选项（Harness 把每个模型挂在提供方分组下），否则模型选择器会整项消失；prompt 帧统一为 ACP 的 `prompt` 形状；投影与用量统计改为按帧形状而非后端名分派，升级前启动、仍在运行的旧 DSH hold 继续正常显示。
  - 主机设置里的 DSH API Key 改为可选覆盖（作为 `DEEPSEEK_API_KEY` 注入，优先于 DSH 配置里的 DeepSeek 凭据），后端就绪不再以它为前提。

## 验证步骤
1. ✅ 在本机隔离 DSH home 里跑通真实 `dsh --profile acp`：`session/new` 返回 `model`（按 `deepseek-official` 分组、值为不透明的 provider/model 对）与 `reasoning_effort`；`session/resume` 恢复已持久会话；`session/set_config_option` 切换模型并回带完整状态。
2. ✅ 新增/改写覆盖：分组选项展开、dsh prompt 形状、dsh 会话 `session/resume` 重开、ACP 响应结束轮次、取消不再重启后端、npm 安装计划与"无需存储 key 即就绪"。
3. ✅ `npm run typecheck` 通过；`npm test` 34 个文件全部通过。

## 相关测试
- `packages/dsh-gateway/tests/session-config.spec.ts` › `flattens provider-grouped ACP options instead of dropping the whole setting`
- `packages/dsh-gateway/tests/gateway.spec.ts` › `flattens grouped model options from the Harness ACP profile and switches them by opaque value`
- `packages/dsh-gateway/tests/gateway.spec.ts` › `delivers a DeepSeek Harness prompt in the ACP shape its acp profile expects`
- `packages/hostd/tests/hostd-integration.spec.ts` › `places hold sockets under XDG_RUNTIME_DIR and revives a dead hold on attach`
- `packages/hostd/tests/agent-manager.spec.ts` › `treats an installed DeepSeek Harness CLI as session-ready without a hostd-stored key`

## 后续补充：发送前也能选模型（同日）

会话的模型清单（`configOptions`）只存在于后端会话里：后端在 `session/new` 时发布，网关把它折进会话视图，composer 才有的可选。原先 ThreadHarbor 是"发出第一条消息时才创建会话"，所以新建界面里的模型下拉只能显示一份客户端内置的静态小表——dsh 只有默认和两个 DeepSeek 模型，用户在配置里挂的 GLM / mimo / MiniMax 一个都不出现。

改成：**在新会话界面选中 Agent 就立刻创建会话**（`session.start` 不带消息），界面随即进入真实会话，composer 里的模型/思考强度就是后端发布的那一份，选完再发第一条消息。

- 客户端：`packages/dsh-client/src/client/store.ts` 的 `promptSessionDraft`（一次 RPC 建会话+送首条消息）由 `createSessionDraft` 取代；草稿视图只保留 Agent 选择器，选错/创建失败时保留草稿并显示原因，选同一个 Agent 重试即可（失败后选择器回到占位项）。
- 网关：会话在首条消息到达时若仍是占位标题 `新会话`，用首行内容命名（`deliverPrompt`），这样"先选 Agent 再发消息"的会话不会在侧栏里一直叫 `新会话`。
- 网关的 `session.start` 带 text 的旧一次性路径保留（gateway 侧仍有测试覆盖），只是浏览器不再使用它。

验证：新增/改写 `createSessionDraft` 的四条客户端用例（建会话即拿到目录、失败保留草稿并可重试、创建期间的重载不会丢会话、创建后失败不回退到选 Agent）、一条网关用例（首条消息给占位标题命名）、五条 DSH 后端用例；`npm run check` 全绿（410 个用例）。

## 设计建议

- 升级前已存在的 DSH 会话不再能被重开：旧 wheel 把 JSONL 写在 hostd 数据目录，acp profile 用 `$DSH_HOME/sessions`，两者不是同一位置。重开时 `session/resume` 找不到该 id，会回退成一条全新会话；旧转录仍留在 gateway 侧可看。这是本次替换接受的代价。
- 模型选择不随会话持久化：Harness ACP 的 `session/resume` 回带的是默认模型。浏览器端已有的"每个 generation 重新应用上次选择"逻辑覆盖了常规重开；若浏览器一直没打开，重开的会话会先用默认模型，等用户打开再切回。
- 若以后要支持"用 ThreadHarbor 自己的一份组成跑 DSH"，应新增一个后端标识而不是复用 `dsh`，因为那会与主机 DSH 配置的模型/凭据来源产生分歧。
