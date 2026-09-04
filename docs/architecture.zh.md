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

hostd 为每个会话启动 detached hold worker。worker 持有 Grok WebSocket、Codex ACP stdio 或 DSH JSON-RPC stdio，记录 generation、单调 seq、有界 journal 和 prompt admission ledger。浏览器刷新只会中断到 gateway 的短请求，不会影响 gateway→hostd tunnel、hostd、hold worker或 Agent 原生连接。

hold worker 的控制 socket 放在短路径运行目录：优先 `$XDG_RUNTIME_DIR/th`，其次 `/run/user/<uid>/th`，再退回 `/tmp/th-<uid>`。journal 和会话元数据仍在 `dataDir/holds/<holdId>/`。Unix domain socket 路径长度有限，所以运行目录必须短；`/tmp` 只作无法创建系统运行目录时的回退。

Web 重连时调用 attach，并带着最后 generation 与 seq 读取 journal。generation 不一致时，gateway 将会话标为 lost，不会自动重发结果未知的 prompt。journal 已截断时会明确插入 gap 状态记录。

若 attach 发现控制 socket 已死（`ECONNREFUSED` / `ENOENT` 等），hostd 会在**同一个会话 id 和 hold generation** 上重启 worker：恢复 journal，重新 initialize，并尝试 `session/load`；失败则 `session/new`。UI 会话不变。原生会话被重建时 gateway 写入一条状态记录，说明模型上下文可能未恢复。仍无法恢复时，会话标为 lost，提示「在当前会话重开」，而不是只展示原始 socket 路径。

## SSH 部署

Gateway 拥有 SSH 配置和 tunnel；hostd 不接触私钥。部署分为 scan、approve、deploy 三个阶段：

1. scan 只返回算法与 SHA256 指纹；
2. approve 请求必须回传用户核对后的同一指纹；
3. deploy 再次扫描并比较，写入专用 known_hosts，随后使用 BatchMode 和 StrictHostKeyChecking 连接。

Gateway 把已安装包中的自包含 hostd artifact 上传到普通用户目录，服务只监听远程 loopback。Web 服务分配本地 loopback 端口并持有 OpenSSH `-L` tunnel。Gateway 生命周期结束时只关闭自己持有的 tunnel，不终止远程 hostd 或 holds。

hostd 的 `hostdVersion` 是 `package.json` 版本加上 `bin.js` 与 `hold-worker.js` 的短摘要。gateway 用同一规则计算当前制品版本。两者不一致时，Web 把该主机标为待升级并显示「升级 hostd」。hostd 进程启动时固定自己的版本，所以只重建制品、不重启远端进程时按钮仍会出现。

## Agent adapter

Agent manager 把 inventory、auth、config 和部署操作放在可扩展 adapter 后面。未安装时，浏览器只能确认一份 hostd 预声明的官方安装计划；实际命令在目标主机上执行，浏览器不能提交可执行文件、shell 参数或配置路径。安装走 npm/pip 官方路径：`npm install -g` 写入该 Node 的 global prefix，`pip install --user --break-system-packages` 写入 Python user scripts（Homebrew 等 PEP 668 环境禁止裸 `pip install --user`）。hostd 从这些目录和 `PATH` 发现已知命令。

- Codex：发现 `codex` 与 `codex-acp`，登录运行 `codex login --device-auth`。
- Grok：发现 `grok`，登录运行 `grok login --device-auth`。
- Claude Code：发现 `claude` 与 `claude-agent-acp`，登录运行 `claude auth login`。
- DSH：发现 PATH 上的 `dsh-jsonrpc-agent`，或官方 wheel 的 `bundled_runtime_path()`；未安装时在主机上执行 `python3 -m pip install --user --break-system-packages deepseek-harness-runtime-bin`。使用远端已有配置与凭据，未设置 `DSH_CORDIS_CONFIG` 时注入 wheel 自带的 `cordis.yml`。不从 ThreadHarbor 交互登录。

Auth worker 与浏览器生命周期无关。它只解析 HTTPS URL、一次性代码和终态，不向浏览器转发 CLI 原始输出或 token。Claude 等需要回填返回码的流程只能写入一行、最多 2048 字符，并拒绝换行。

Config adapter 只读写 Codex、Grok 和 Claude Code 各自官方的用户配置路径。TOML/JSON 在 hostd 解析后才以 owner-only 临时文件原子替换；读取结果带内容 revision，陈旧页面不能覆盖更新后的远程文件。它不读取 Agent 的 auth 文件或 keyring。
