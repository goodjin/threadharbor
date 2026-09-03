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

Web 重连时调用 attach，并带着最后 generation 与 seq 读取 journal。generation 不一致时，gateway 将会话标为 lost，不会自动重发结果未知的 prompt。journal 已截断时会明确插入 gap 状态记录。

## SSH 部署

Gateway 拥有 SSH 配置和 tunnel；hostd 不接触私钥。部署分为 scan、approve、deploy 三个阶段：

1. scan 只返回算法与 SHA256 指纹；
2. approve 请求必须回传用户核对后的同一指纹；
3. deploy 再次扫描并比较，写入专用 known_hosts，随后使用 BatchMode 和 StrictHostKeyChecking 连接。

Gateway 把已安装包中的自包含 hostd artifact 上传到普通用户目录，服务只监听远程 loopback。Web 服务分配本地 loopback 端口并持有 OpenSSH `-L` tunnel。Gateway 生命周期结束时只关闭自己持有的 tunnel，不终止远程 hostd 或 holds。

## Agent adapter

Agent manager 把 inventory、auth 和 config 操作放在可扩展 adapter 后面。Agent 由远端管理员安装，hostd 从部署服务的受控 `PATH` 发现已知命令；浏览器不能提交可执行文件、shell 参数或配置路径。

- Codex：发现 `codex` 与 `codex-acp`，登录运行 `codex login --device-auth`。
- Grok：发现 `grok`，登录运行 `grok login --device-auth`。
- Claude Code：发现 `claude` 与 `claude-agent-acp`，登录运行 `claude auth login`。
- DSH：发现 `dsh-jsonrpc-agent`，使用远端已有配置与凭据，不从 ThreadHarbor 交互登录。

Auth worker 与浏览器生命周期无关。它只解析 HTTPS URL、一次性代码和终态，不向浏览器转发 CLI 原始输出或 token。Claude 等需要回填返回码的流程只能写入一行、最多 2048 字符，并拒绝换行。

Config adapter 只读写 Codex、Grok 和 Claude Code 各自官方的用户配置路径。TOML/JSON 在 hostd 解析后才以 owner-only 临时文件原子替换；读取结果带内容 revision，陈旧页面不能覆盖更新后的远程文件。它不读取 Agent 的 auth 文件或 keyring。
