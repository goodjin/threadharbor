# SSH 自动部署远端 DSH

每台主机地位相同。任意一台已经在跑 ThreadHarbor 的机器，都可以 SSH 到另一台：读取对方是否装好插件和带 token 的地址，再通过本机 SSH 隧道打开页面。也可以在对方还没装的时候直接部署。对方的 DSH 只听 `127.0.0.1`。

## 前置条件

- 发起连接的那台：正在运行 `dsh --profile web`，组合里包含 `threadharbor-ssh-deploy`（见根目录 `cordis.patch.yml`），本机有 `openssh-client`；密码登录时需 `sshpass`。
- 对方：SSH 可达，Node.js **22+**，能访问 npm 与 GitHub（用于 `dsh plugin add github:…`）。
- 默认通过 **GitHub 地址**安装插件（`installPluginsFromGithub: true`），可在插件配置里改 `remotePlugins` 列表；若关闭则回退为上传本机 `stable-current` 发行包。

## 访问方式

对方 DSH 绑定 `127.0.0.1`。连接方用 `ssh -L` 把本机一个端口转到对方的回环端口，带 `ServerAliveInterval`。隧道进程退出后，下次连接会重新打开。页面地址是连接方本机的 `http://127.0.0.1:<端口>/?token=`。鉴权仍依赖 DSH 的 `?token=`。

「从 Tailscale 选」只用来填写 SSH 目标，不让 DSH 听在 Tailscale 地址上。

## 界面：会话树与主机状态

- **各主机** 列表页左侧为 **按主机 → 项目 → 会话** 的树：本机数据来自 DSH 的 workspace/session 投影；已登记的其他主机通过 `launchUrl` 拉取（失败时可点 **连接** 打开那台机器的页面）。
- 主机行显示 **已连接 / 可达 / 未连接 / 检测中**；详情页提供 **连接**、**重新部署 DSH**（SSH）、可达性检测。

## 使用步骤

1. 侧栏 **各主机** → **添加新主机** → **SSH 自动部署**。
2. 填写 SSH 与认证，批准主机密钥后可点 **通过 SSH 读取对方状态**：读 `$HOME/.local/state/threadharbor/peer.json`（插件是否已装、`launchUrl`）。没有这份文件就还没装好。
3. 勾选要启用的 ACP preset，再 **部署 DSH 并登记**。对方只听 `127.0.0.1`，连接方打开本机隧道。部署成功时对方会写下 `peer.json`，之后任何主机都能用同一条 SSH 读到。
4. 使用界面上的 **带 token 链接** 复制或打开；`launchUrl` 写入登记簿。
5. 左侧会话树会随本机/远端数据刷新；远端约每 30 秒重拉一次。

## 启动 URL / token

远端从 `dsh-web.log` / journal 解析 `dsh web: …/?token=…`，回传 `LAUNCH_URL=`。隧道模式会把 token 换到本机转发地址上；已运行实例同样读日志（幂等）。

## API

| 路径 | 方法 | 作用 |
|------|------|------|
| `/api/threadharbor.host-ssh.inspect` | POST | 扫描主机密钥 |
| `/api/threadharbor.host-ssh.peer` | POST | SSH 读取对方 `peer.json`（插件与 URL） |
| `/api/threadharbor.host-ssh.deploy` | POST | 异步部署（对方只听回环，连接方建 SSH 隧道） |
| `/api/threadharbor.host-ssh.operation` | GET | 进度；`result.launchUrl` |
| `/api/threadharbor.host-remote.sessions` | POST | body: `{ launchUrl }`，拉取远端项目/会话快照 |

## 安全与限制

- `launchUrl` 含 launch token，保存在管理机登记数据中。
- SSH 部署不安装 ACP agent 二进制；需在目标机自行安装并在 PATH 上提供 `codex-acp`、`claude-agent-acp`、`grok`、`cursor-agent` 等。部署会写入 `threadharbor-remote-agents.patch.yml` 并用 `dsh web --patch` 启用/禁用各 preset。插件默认 `github:goodjin/threadharbor#main`（可配置）。
- 页面走本机隧道，只要求 SSH 通。
