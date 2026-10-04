# ThreadHarbor 架构

ThreadHarbor 由一个可安装的 DeepSeek Harness bundle 和四个职责独立的包组成。它使用 Harness 的插件 API，但不把 Harness 仓库作为运行时依赖副本。

## DSH 集成

根包通过 `package.json#dsh.bundle.patch` 声明 `cordis.patch.yml`。patch 只停用官方 `ui-sidebar` 与 `ui-conversation` 两个 slot occupant，再插入 gateway 与 browser client。Harness 的 client runtime、layout、theme、settings、Session 和 Agent 服务继续正常装载。ThreadHarbor UI 不调用本地 Session/Workspace 服务，因此本地产品状态与 ThreadHarbor catalog 不会混合。

浏览器包通过 `package.json#dsh.client` 声明 Web 平台依赖，在 `apply()` 中向 `sidebar` 和 `conversation` 注册 occupant。这与第三方主题、设置页扩展和完整 Web skin 使用的是同一套模块加载器与 Cordis effect 生命周期。

## 状态所有权

每个 DSH Web 服务独立持有一个 `remote_agent` storage domain：

- host：Web 服务可访问的 hostd endpoint，以及可选的 SSH 配置；
- project：恰好属于一个 host 的远程绝对目录；
- session：恰好属于一个 project，并绑定 hostd hold generation；
- transcript：从 native frame 派生的浏览器投影，不写入 Harness `SessionEventMap`。

不同 Web 服务即使连接同一个 hostd，也不会枚举或接管对方的 catalog。hostd 的 session id 由各 Web 服务随机生成，hostd 只按显式 id start/attach。

## 断线与恢复

hostd 在进程内为每个后端持有**一条共享 Agent 连接**（桥接）。每个远程会话是桥接里的一个会话槽，持有自己的 generation、单调 seq、有界 journal 和 prompt admission 去重；同一台主机上同一后端的所有会话共用这条连接和同一次握手——实测 5 个 dsh 会话从「每会话一个后端进程、约 2.1 GB 常驻」降到「1 个进程、约 440 MB」，之后每加一个会话只增加约 10 MB。浏览器刷新只会中断到 gateway 的短请求，不会影响 gateway→hostd tunnel、hostd 或 Agent 原生连接。

运行目录（优先 `$XDG_RUNTIME_DIR/th`，其次 `/run/user/<uid>/th`，再退回 `/tmp/th-<uid>`）现在只承载一项遗留兜底：启动时清扫旧版「每会话一 worker」架构可能留下的 `h-*.sock` 控制 socket。桥接在 hostd 进程内，新会话不再有独立 socket。journal 和会话元数据仍在 `dataDir/holds/<holdId>/`；`holdId` 这个名字保留，是为了磁盘布局、会话记录和恢复逻辑原样延续。

hostd 的数据根是设计好的固定位置：`~/.local/state/threadharbor/<channel>/hostd`，本机与 SSH 主机同一形状（远端由部署写入 `--data-dir $state/hostd`，本机由 gateway 的 `defaultHostdDataDir(channel)` 给出，dev 脚本默认同一个路径）。根下固定放 `sessions.json`（会话与 hold 绑定）、`host-id`、`grok-serve-secret`、`holds/<holdId>/{config,state,journal,worker.log}` 和 `dsh-sessions/<projectKey>/*.jsonl`；运行目录只放旧版控制 socket 的清扫兜底。这些内容必须跨 hostd 重启存活，所以路径里不允许出现 `mktemp` 之类的随机段：临时目录被系统清掉会同时丢会话记录、journal、DSH 历史和 Grok 密钥。若确实以临时目录启动过，点「升级 hostd」时 `resolveLoopbackHostdDataDir` 会在设计目录为空时整体搬过去；设计目录已存在（有另一个 hostd 在写，或上一代留下的残留）则保持原样并记录一行提示，交给操作者手动合并，避免把两份状态合到一起或让新进程悄悄换成空目录。

`grok agent serve` 只绑 loopback，密钥不是给“要不要认证”用的可选项：Grok 的 CLI 在未传 `--secret` 时会自己生成一个（`--secret` 的默认行为是 auto-generated，env 为 `GROK_AGENT_SECRET`），hostd 不传就等于永远连不上，所以 hostd 必须持有并传递它。同时 loopback 并不等于可信——浏览器允许跨源页面连本机 WebSocket，命令行的 `--secret` 是挡住这类本机劫持的唯一门槛，因此密钥保留、但它的**存放位置**固定在自己的数据根里，跨重启复用，而不是每次重启重新生成。

Web 重连时调用 attach，并带着最后 generation 与 seq 读取 journal。generation 不一致时，gateway 将会话标为 lost，不会自动重发结果未知的 prompt。journal 已截断时会明确插入 gap 状态记录。

若 attach 发现会话槽已死或 Agent 进程不在了，hostd 会在**同一个会话 id 和 hold generation** 上把它恢复出来：拉起（或复用）该后端的共享连接，重新 initialize，恢复 journal，并按后端重开原生会话——Codex / Claude 用标准 `session/load`，DeepSeek Harness 的 acp profile 没有该方法，改用 `session/resume`——失败则 `session/new`。**恢复失败会显式报错**，不会悄悄换一个空白会话假装记得。UI 会话不变。原生会话被重建时 gateway 写入一条状态记录，说明模型上下文可能未恢复。仍无法恢复时，会话标为 lost，提示「在当前会话重开」，而不是只展示原始错误。

## SSH 部署

Gateway 拥有 SSH 配置和 tunnel；hostd 不接触私钥。部署分为 scan、approve、deploy 三个阶段：

1. scan 只返回算法与 SHA256 指纹；
2. approve 请求必须回传用户核对后的同一指纹；
3. deploy 再次扫描并比较，写入专用 known_hosts，随后使用 BatchMode 和 StrictHostKeyChecking 连接。

Gateway 把已安装包中的自包含 hostd artifact 上传到普通用户目录，服务只监听远程 loopback。Web 服务分配本地 loopback 端口并持有 OpenSSH `-L` tunnel。Gateway 生命周期结束时只关闭自己持有的 tunnel，不终止远程 hostd 或 holds。

hostd 的 `hostdVersion` 是 `package.json` 版本加上 `bin.js` 的短摘要。gateway 用同一规则计算当前制品版本。两者不一致时，Web 把该主机标为待升级并显示「升级 hostd」。hostd 进程启动时固定自己的版本，所以只重建制品、不重启远端进程时按钮仍会出现。

## Agent adapter

Agent manager 把 inventory、auth、config 和部署操作放在可扩展 adapter 后面。未安装时，浏览器只能确认一份 hostd 预声明的官方安装计划；实际命令在目标主机上执行，浏览器不能提交可执行文件、shell 参数或配置路径。安装走 npm 官方路径：`npm install -g` 写入该 Node 的 global prefix，hostd 从该目录和 `PATH` 发现已知命令。会话统一走 Agent Client Protocol：新建会话时后端返回的 `configOptions` 会被投影成会话视图里的可选设置，切换请求翻译成后端自己的 `session/set_config_option`（或 `set_mode` / `set_model`）。

- Codex：发现 `codex` 与 `codex-acp`，登录运行 `codex login --device-auth`。
- Grok：发现 `grok`，登录运行 `grok login --device-auth`。
- Claude Code：发现 `claude` 与 `claude-agent-acp`，登录运行 `claude auth login`。
- DSH：发现 PATH 上的 `dsh`（官方 npm 包 `@deepseek-ai/dsh`）；未安装时在主机上执行 `npm install -g @deepseek-ai/dsh@<pin>`。每个会话启动随包发布的 `dsh --profile acp`，模型清单、默认模型与凭据都来自主机用户自己的 `$DSH_HOME`（`settings.yaml` / `.credentials.yaml`），也就是 DSH Web 的 Models 页写入的同一份文档；ThreadHarbor 不自己维护模型表，也不从 ThreadHarbor 交互登录。主机设置里仍可另存一个 DeepSeek 密钥作为显式覆盖，它作为 `DEEPSEEK_API_KEY` 注入进程环境，优先于 DSH 配置里的 DeepSeek 凭据。

Auth worker 与浏览器生命周期无关。它只解析 HTTPS URL、一次性代码和终态，不向浏览器转发 CLI 原始输出或 token。Claude 等需要回填返回码的流程只能写入一行、最多 2048 字符，并拒绝换行。

Config adapter 只读写 Codex、Grok 和 Claude Code 各自官方的用户配置路径。TOML/JSON 在 hostd 解析后才以 owner-only 临时文件原子替换；读取结果带内容 revision，陈旧页面不能覆盖更新后的远程文件。它不读取 Agent 的 auth 文件或 keyring。
