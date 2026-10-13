# SSH 自动部署远端 DSH

在**提供 Web 页面的那台机器**（本机 loopback）上，ThreadHarbor 可以通过 OpenSSH 在另一台 Linux/macOS 主机上安装 DSH Web 与 ThreadHarbor 插件，并登记为可通过 **主机 IP** 访问的地址（默认不建 SSH 隧道）。

## 前置条件

- 管理端：正在运行 `dsh --profile web` 的本机，组合里包含 `threadharbor-ssh-deploy`（见根目录 `cordis.patch.yml`）。
- 目标机：SSH 可达，Node.js **22+**，能访问 npm 与 GitHub（用于 `dsh plugin add github:…`）。
- 管理端本机：`openssh-client`；密码登录时需 `sshpass`。
- 默认通过 **GitHub 地址**安装插件（`installPluginsFromGithub: true`），可在插件配置里改 `remotePlugins` 列表；若关闭则回退为上传本机 `stable-current` 发行包。

## 访问方式

| 模式 | 远端 DSH 绑定 | 隧道 | 登记地址 |
|------|----------------|------|----------|
| **主机 IP**（默认） | 自动检测（Tailscale IPv4 或 `hostname -I` 首地址，也可手填） | 无 | `http://<IP>:<端口>` |
| **SSH 隧道** | `127.0.0.1` | `ssh -L` | `http://127.0.0.1:<本地端口>` |

仍禁止 `0.0.0.0`；非 loopback 绑定会加 `--trusted-host`。鉴权仍依赖 DSH 的 `?token=`。

## 界面：会话树与主机状态

- **各主机** 列表页左侧为 **按主机 → 项目 → 会话** 的树：本机数据来自 DSH 的 workspace/session 投影；已登记远端主机通过 `launchUrl` 由管理端 API 拉取（失败时可点 **连接** 打开远端页面）。
- 主机行显示 **已连接 / 可达 / 未连接 / 检测中**；详情页提供 **连接**、**重新部署 DSH**（SSH）、可达性检测。

## 使用步骤

1. 侧栏 **各主机** → **添加新主机** → **SSH 自动部署**（默认 **主机 IP**）。
2. 填写 SSH 与认证，批准主机密钥，点击 **部署 DSH 并登记**。
3. 使用界面上的 **带 token 链接** 复制或打开；`launchUrl` 写入登记簿。
4. 左侧会话树会随本机/远端数据刷新；远端约每 30 秒重拉一次。

## 启动 URL / token

远端从 `dsh-web.log` / journal 解析 `dsh web: …/?token=…`，回传 `LAUNCH_URL=`。隧道模式会把 token 换到本机转发地址上；已运行实例同样读日志（幂等）。

## API

| 路径 | 方法 | 作用 |
|------|------|------|
| `/api/threadharbor.host-ssh.inspect` | POST | 扫描主机密钥 |
| `/api/threadharbor.host-ssh.deploy` | POST | 异步部署（`accessMode`: `host-ip` \| `tunnel` 等） |
| `/api/threadharbor.host-ssh.operation` | GET | 进度；`result.launchUrl` |
| `/api/threadharbor.host-remote.sessions` | POST | body: `{ launchUrl }`，拉取远端项目/会话快照 |

## 安全与限制

- `launchUrl` 含 launch token，保存在管理机登记数据中。
- SSH 部署不安装 ACP agent 二进制；插件默认 `github:goodjin/threadharbor#main`（可配置）。
- 主机 IP 模式要求管理机与浏览器能访问登记地址（如局域网或 Tailscale）。
