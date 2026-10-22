# SSH 自动部署远端 DSH

每台主机地位相同。任意一台已经在跑 ThreadHarbor 的机器，都可以 SSH 到另一台：读取对方是否装好插件和带 token 的地址，再通过本机 SSH 隧道打开页面。也可以在对方还没装的时候直接部署。对方的 DSH 只听 `127.0.0.1`。

## 前置条件

- 发起连接的那台：正在运行 `dsh --profile web`，组合里包含 `threadharbor-ssh-deploy`（见根目录 `cordis.patch.yml`），本机有 `openssh-client`；密码登录时需 `sshpass`。
- 对方：SSH 可达，Node.js **22+**，能访问 npm 与 GitHub（用于 `dsh plugin add github:…`）。
- 默认通过 **GitHub 地址**安装插件（`installPluginsFromGithub: true`），可在插件配置里改 `remotePlugins` 列表；若关闭则回退为上传本机 `stable-current` 发行包。

## 访问方式

对方 DSH 绑定 `127.0.0.1`。连接方用 `ssh -L` 把本机一个端口转到对方的回环端口，带 `ServerAliveInterval`。隧道进程退出后，下次连接会重新打开。页面地址是连接方本机的 `http://127.0.0.1:<端口>/?token=`。鉴权仍依赖 DSH 的 `?token=`。

「从 Tailscale 选」只用来填写 SSH 目标，不让 DSH 听在 Tailscale 地址上。自 2026-10-15 起，从清单里选一台节点只填名称和 SSH 目标，地址一栏刻意留空，交给随后的部署或连接去写——以前选完节点就把地址写死，登记出来的主机可达性检测永远失败，正是这里改掉的老毛病。

## 界面：会话树与主机状态

- **各主机** 列表页左侧为 **按主机 → 项目 → 会话** 的树：本机数据来自 DSH 的 workspace/session 投影；已登记的其他主机通过 `launchUrl` 拉取（打不开时可点 **连接并打开** 重建隧道、打开那台机器的页面）。
- 主机行的圆点和详情页的状态行用同一组状态词，共九个；当前该做的事就是那一行的主按钮：

| 状态词 | 含义 | 主按钮 | 次按钮 |
|---|---|---|---|
| 本机 | 这台就是运行 DSH 的机器 | 无 | 无 |
| 检测中 | 正在读对方状态，暂时不给动作 | 无 | 无 |
| 未部署 | 读到了对方，但没装 DSH | 部署 DSH 并登记 | 读一次对方状态 |
| 未启动 | 装过，但对方进程没在跑 | 启动对方 DSH | 重新部署 |
| 已连接 | 装过、在跑，而且这次真的打开过 | 打开页面 | 检查能否打开 |
| 可达未同步 | 装过、在跑，但还没真的打开过 | 连接并打开 | 检查能否打开 |
| 未连接 | 装过、在跑，但打不开 | 连接并打开 | 检查能否打开 |
| 未验证 | 刚登记，什么都没测过 | 检查能否打开 | 连接并打开 |
| 未知 | 读不到、或只知道部分事实 | 填写连接方式 | 重试读取 |

「已连接」只属于在本源自己的跨标签页频道上报到过的主机——这是一条同源机制，例如按地址登记、同时又在本机浏览器开着同一个 Web 应用页面的那台。经 SSH 部署或访问的对方走隧道，页面在另一个源上，永远不会在这个频道里报到，所以走 SSH 这条路的主机到不了「已连接」，状态的上限就是「可达未同步」。

「可达未同步」不等于「已连接」：前者只是探测到对方端口有应答——那里有东西在听；后者表示报到过的正是对方自己的页面。一个证明有东西在听，一个证明听着的确实是对方的页面。

「在线」不再作为主机状态词，它只留给心跳报数的事实行与 Tailscale 节点徽标——Tailscale 说某台机器在线，只说明它的组网节点是通的，不说明 DSH 在对方跑着，也不说明它的页面能从这里打开。

## 使用步骤

1. 侧栏 **各主机** → **添加新主机** → 选 **通过 SSH 部署 / 接管**（或先 **从 Tailscale 选** 再进 SSH 表单）。
2. **SSH 主机** 可手输或从本机 `~/.ssh/config` 的 Host 列表选；选中有 `User` / `IdentityFile` 的块会预填。**用户名** 必填，不会默认本机用户。**本机私钥路径** 可从 `~/.ssh` 列表选、浏览文件或手输。填写 SSH 与认证后，批准主机密钥后可点 **通过 SSH 读取对方状态**：读 `$HOME/.local/state/threadharbor/peer.json`（插件是否已装、`launchUrl`）。没有这份文件就还没装好。
3. 勾选要启用的 ACP preset，再 **部署 DSH 并登记**。对方只听 `127.0.0.1`，连接方打开本机隧道。部署成功时对方会写下 `peer.json`，之后任何主机都能用同一条 SSH 读到。
4. 使用界面上的 **带 token 链接** 复制或打开；`launchUrl` 写入登记簿。
5. 左侧会话树会随本机/远端数据刷新；远端约每 30 秒重拉一次。

## 启动 URL / token

远端从 `dsh-web.log` / journal 解析 `dsh web: …/?token=…`，回传 `LAUNCH_URL=`。隧道模式会把 token 换到本机转发地址上；已运行实例同样读日志（幂等）。

## API

| 路径 | 方法 | 作用 |
|------|------|------|
| `/api/threadharbor.host-ssh.local.assets` | GET | 本机 `~/.ssh/config` 的 Host 列表与 `~/.ssh` 下候选私钥路径 |
| `/api/threadharbor.host-ssh.local.pick-identity` | POST | 打开原生文件选择器，返回私钥路径（取消则 `cancelled: true`） |
| `/api/threadharbor.host-ssh.inspect` | POST | 扫描主机密钥（body 里 `ssh.user` 必填） |
| `/api/threadharbor.host-ssh.peer` | POST | SSH 读取对方 `peer.json`（插件与 URL） |
| `/api/threadharbor.host-ssh.deploy` | POST | 异步部署（对方只听回环，连接方建 SSH 隧道） |
| `/api/threadharbor.host-ssh.operation` | GET | 进度；`result.launchUrl` |
| `/api/threadharbor.host-remote.sessions` | POST | body: `{ launchUrl }`，拉取远端项目/会话快照 |

## 安全与限制

- `launchUrl` 含 launch token，保存在管理机登记数据中。
- SSH 部署不安装 ACP agent 二进制；需在目标机自行安装并在 PATH 上提供 `codex-acp`、`claude-agent-acp`、`grok`、`cursor-agent` 等。部署会写入 `threadharbor-remote-agents.patch.yml` 并用 `dsh web --patch` 启用/禁用各 preset。插件默认 `github:goodjin/threadharbor#main`（可配置）。
- 页面走本机隧道，只要求 SSH 通。

## Tailscale Serve 接入（添加主机的逐项检测）

前提：tailnet 已开启 MagicDNS 与 HTTPS 证书。对方 DSH 仍只听 `127.0.0.1:<端口>`，由对方的 `tailscale serve` 以 `https://<主机>.<tailnet>.ts.net` 代理；远端命令一律走 SSH。

1. **各主机 → 添加新主机 → SSH 自动部署**，填 SSH 目标（可直接填 Tailscale 主机名）与认证，点「扫描主机密钥」。只有一把密钥时自动批准并立即开始检测。
2. 「对方状态检测」逐项显示（一次 SSH 读完，前序未通过的项显示「待前序完成」）：
   SSH 可连接 → Tailscale 已安装并登录（MagicDNS 名）→ Node.js 22+ → DSH 已安装 → 插件已部署（peer.json）→ DSH Web 正在运行 → `tailscale serve` 已代理 DSH 端口 → ts.net 地址可访问且令牌有效（本机发起 HTTPS 请求）。
3. 每项带动作按钮：**安装/部署 DSH 与插件**、**启动 DSH**、**启动/重启 DSH**（轻量 `systemctl start|restart threadharbor-dsh-web-<channel>.service`：用户单元，或经 `sudo -n` 的系统单元；随后从 journal/日志回读令牌写回 peer.json）、**配置 tailscale serve**（先以普通用户执行 `tailscale serve --bg --https=443 http://127.0.0.1:<端口>`，再试 `sudo -n`；都被拒时界面列出需在对方手动执行的命令并可复制，执行后点「重新检测」）。清单里触发的部署不建 SSH 隧道、**重新检测**。
4. 全部通过后点 **用 ts.net 地址保存这台主机**：登记的 `address` 为 ts.net origin，`launchUrl` 为 `https://…ts.net/?token=…`，不再依赖 SSH 隧道。详情页的部署区同样提供这份清单，可把旧的隧道登记切换到 ts.net。

| 路径 | 方法 | 作用 |
|------|------|------|
| `/api/threadharbor.host-ssh.check` | POST | body: `{ ssh, remoteWebPort? }`，返回逐项检测报告 |
| `/api/threadharbor.host-ssh.serve` | POST | 在对方配置 `tailscale serve` 后重新检测；失败时返回 `failure.manualCommands` |
| `/api/threadharbor.host-ssh.service` | POST | body: `{ ssh, action: start\|restart, remoteWebPort? }`，systemctl 启停并刷新令牌后重新检测 |

Linux 上普通用户执行 `tailscale serve` 需要先在对方执行一次 `sudo tailscale set --operator=$USER`。
