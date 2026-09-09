# ThreadHarbor

ThreadHarbor 是 DeepSeek Harness 的独立 Web 插件，用来创建、持有和恢复远程 Codex、Grok 与 DeepSeek Harness Agent 会话。浏览器或 SSH 断开时，会话仍由远程 `threadharbor-hostd` 与 detached hold worker 继续运行；Web 重连后按 journal cursor 补齐记录。

它不是 DeepSeek Harness 的 fork，也不包含 Harness 源码。安装时只有标准 `dsh.bundle` 与 `dsh.client` 插件进入目标 profile；开发用的 Harness checkout 位于被 Git 忽略的 `reference/deepseek-harness/`。

## 当前能力

- 每个 DSH Web 部署独立保存自己的主机、项目、会话和 transcript，多个 Web 服务互不发现、互不接管。
- hostd 持有 Agent 原生连接、at-most-once prompt admission 和有界 journal，网页断线不终止会话。
- 使用 Harness 的公开 slot 机制替换 `sidebar` 与 `conversation`，保留原生 Web runtime、layout、theme、settings 和本地会话服务；不修改 Harness 源码。
- Web 内配置 SSH 主机，先展示并确认 SSH host-key 指纹，再以远程普通用户部署 hostd、安装 user service 并建立 loopback tunnel。
- hostd 从远端主机的通用 `PATH` 发现已有 Codex、Grok、Claude Code、ACP adapter 与 DSH runtime。未安装时，主机设置提供部署按钮；确认后在该主机上执行官方安装命令，ThreadHarbor 不打包这些 Agent。
- Web 内启动 detached 登录流程，展示授权链接和一次性代码。Codex、Grok 使用 `--device-auth`；Claude Code 使用 `claude auth login`，需要时可把浏览器返回码送回远程 CLI。
- Web 内编辑 Codex、Grok 和 Claude Code 的官方用户配置文件；hostd 固定文件位置、限制大小、校验 TOML/JSON，并用 revision 防止覆盖其他编辑器的新修改。
- 登录凭据始终保存在远程主机；Web 只看到链接、一次性代码与流程状态。

Claude Code 的登录与配置已经支持，但当前没有配置 Claude 原生会话 adapter，因此不会出现在“新建会话”的可选后端中。这个限制会明确显示在主机库存里。

## 安装到 DeepSeek Harness

完整安装、升级、卸载和首个远程主机操作见 [docs/install.zh.md](docs/install.zh.md)。npm 包发布后可直接作为标准 DSH bundle 安装：

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

## SSH 主机流程

在 ThreadHarbor 侧栏选择“添加主机 → SSH 自动部署”：

1. 输入主机、用户、端口，以及可选的 Web 服务本机私钥绝对路径和 ProxyJump。
2. ThreadHarbor 运行 `ssh-keyscan` 与 `ssh-keygen`，展示 SHA256 指纹。请先与主机管理员提供的指纹核对。
3. 确认后，Web 服务把密钥写入 ThreadHarbor 自己的 `known_hosts`，以 `StrictHostKeyChecking=yes` 建连。
4. Web 服务上传与自身版本一致的自包含 hostd artifact 到 `~/.local/share/threadharbor/current`，优先启用 `systemd --user`；没有 systemd 时使用 detached fallback。
5. Web 服务持有 SSH loopback tunnel。网页断开不会关闭 tunnel、hostd、登录进程或 Agent hold。

远程主机部署 hostd 需要 Node.js 22 或更新版本。未安装的 Agent 可在主机设置中点部署，由 hostd 在该主机上执行官方 `npm install -g` / `pip install --user --break-system-packages`，安装到 npm 与 pip 自己的目录。ThreadHarbor 不使用 `sudo`，也不再打包 Agent 二进制。详细配置见 [docs/remote-hosts.zh.md](docs/remote-hosts.zh.md)。

## 仓库结构

```text
packages/protocol/     浏览器、gateway、hostd 共用的 JSON 协议
packages/hostd/        远程 daemon、hold worker、Agent 发现、登录与配置 adapter
packages/dsh-gateway/  DSH host 插件、独立 catalog、SSH tunnel 与 transcript projection
packages/dsh-client/   DSH browser 插件，接管 sidebar/conversation slots
cordis.patch.yml       安装到 DSH Web profile 的标准 bundle patch
reference/             被 Git 忽略的 DeepSeek Harness 参考源码
```

设计说明见 [docs/architecture.zh.md](docs/architecture.zh.md)，其他 Web 插件的实现调研见 [docs/dsh-web-plugin-research.zh.md](docs/dsh-web-plugin-research.zh.md)，AgentHarbor/SessionPort 对比见 [docs/landscape.zh.md](docs/landscape.zh.md)。

## 开发检查

```sh
npm run typecheck
npm run test
npm run build
```

需要 loopback TCP 或 Unix socket 的 hostd 测试在受限沙箱中可能得到 `EPERM`，应在允许本机 IPC 的环境原样重跑。

## 开发环境管理（web / hostd）

`scripts/dev.sh` 管理本地两个 dev 服务，动作统一为 `start | stop | restart | status`，目标为 `web | hostd | all`（默认 `all`）：

- **web** —— ThreadHarbor 测试 GUI（默认 channel `test`、端口 `3081`；每个 channel 有独立的 DSH home 与频道补丁 `deploy/channels/<channel>.patch.yml`）。
- **hostd** —— 本地开发 hostd（默认端口 `62846`，数据目录通过 `--data-dir` 指定）。

```sh
# 状态（不指定目标则显示两个）
scripts/dev.sh status web
scripts/dev.sh status

# 启动/重启 3081 测试 GUI（重启前先 npm run build，让 gateway/client 用上新构建）
scripts/dev.sh start web
scripts/dev.sh restart web

# 管理本地 dev hostd（--data-dir 必须指向持有 holds/journal 的原数据目录）
scripts/dev.sh start hostd --data-dir /tmp/threadharbor-hostd-run.mA1zJL
scripts/dev.sh restart hostd --data-dir /tmp/threadharbor-hostd-run.mA1zJL
scripts/dev.sh stop hostd --data-dir /tmp/threadharbor-hostd-run.mA1zJL

# 带原生帧日志启动 hostd（THREADHARBOR_FRAME_LOG=1；只对启动后新建的会话生效）
scripts/dev.sh start hostd --data-dir /tmp/threadharbor-hostd-run.mA1zJL --frame-log

# 两个一起
scripts/dev.sh restart all --data-dir /tmp/threadharbor-hostd-run.mA1zJL
```

`start` 在服务已运行时是幂等 no-op；`stop`/`restart` 先读各自 pid 文件发 `SIGTERM` 并等待端口释放；**不会**杀已 detach 的 hold worker（旧会话的 worker 继续独立运行）。常用覆盖变量见脚本头部注释：`THREADHARBOR_DSH_BIN`（默认走 `scripts/dsh-wrapper.sh`）、`THREADHARBOR_CHANNEL` / `THREADHARBOR_WEB_PORT` / `THREADHARBOR_DSH_HOME`、`THREADHARBOR_HOSTD_PORT` / `THREADHARBOR_HOSTD_DATA_DIR` 等。web 的日志/pid 在 `$DSH_HOME/threadharbor-runtime/{web.log,web.pid}`；hostd 的默认在 `/tmp/threadharbor-hostd-<port>.{log,pid}`。若端口被非脚本启动的进程占用，脚本会拒绝代杀并提示先手动处理或把 pid 文件指过去。

## 安全原则

- SSH 私钥只以 Web 服务上的文件路径引用，默认不上传、不持久化密钥内容。
- 新主机必须显式确认 host-key 指纹；后续连接使用固定的专用 `known_hosts`。
- Agent 部署只执行 hostd 内置的官方安装命令，安装到 npm/pip 的默认位置；浏览器不能提交可执行文件、shell 或配置路径。hostd 从 `PATH` 以及 npm global bin、pip user scripts 发现并启动已知命令。
- OAuth/device token、API key 和 Agent auth 文件不通过 gateway 或浏览器。
- 配置编辑器会传输用户主动打开的完整配置文件；不要在这些文件中保存明文密钥，优先使用远程环境变量或 Agent 自己的凭据存储。
- hostd 只监听 `127.0.0.1`，远程访问必须经过 SSH tunnel。

MIT License
