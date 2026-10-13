# SSH 自动部署远端 DSH

在**提供 Web 页面的那台机器**（本机 loopback）上，ThreadHarbor 可以通过 OpenSSH 把当前发行包里的 DSH Web 与 ThreadHarbor 插件装到另一台 Linux/macOS 主机上，并（可选）建立 SSH 端口转发或直接通过 Tailscale 访问。

## 前置条件

- 管理端：正在运行 `dsh --profile web` 的本机，组合里包含 `threadharbor-ssh-deploy` 行（见根目录 `cordis.patch.yml`）。
- 目标机：SSH 可达，Node.js **22+**，能访问 npm（用于安装 `@deepseek-ai/dsh`，若尚未安装）。
- 管理端本机：已安装 `openssh-client`；使用**密码**登录时需额外安装 `sshpass`。
- 发行包：默认上传 `~/.local/share/threadharbor/stable-current`；开发时可配置插件 `releaseDirectory`。

## 访问方式（三选一）

| 模式 | 远端 DSH 绑定 | 管理机隧道 | 登记地址示例 |
|------|----------------|------------|----------------|
| **SSH 隧道**（默认） | `127.0.0.1` | 建立 `ssh -L` | `http://127.0.0.1:<本地端口>` |
| **Tailscale 直连** | `tailscale ip -4` 或你填的 IP/主机名 | **不建隧道** | `http://100.x.x.x:3081` |
| **自定义绑定** | 你填的具体 IP/主机名（禁止 `0.0.0.0`） | **不建隧道** | `http://<bind>:3081` |

非 loopback 绑定会自动加上 `--trusted-host`（可用 MagicDNS 名覆盖），**不会**默认监听 `0.0.0.0`。远端仍是明文 HTTP + `?token=` 换 cookie，请只在可信网络（如 Tailscale）上使用直连模式。

## 使用步骤

1. 侧栏 **各主机** → **添加新主机** → **SSH 自动部署**。
2. 选择访问方式，填写 SSH 与认证信息，检查并批准主机密钥指纹。
3. 点击 **部署 DSH 并登记**；完成后界面会显示 **带 `?token=` 的完整链接**，可一键复制或打开。
4. 该链接同时写入主机登记的 `launchUrl` 字段；在主机详情页也可再次打开/复制。
5. 在新标签页打开链接完成 token 交换后，跨标签页频道会显示该主机 **在线**。

## 启动 URL / token 如何获取

部署脚本在远端启动（或检测到已在运行）DSH Web 后，从 `~/.local/state/threadharbor/<channel>/dsh-web.log`（或 systemd journal）中解析 **`dsh web: http://…/?token=…`** 行，通过 `LAUNCH_URL=` 回传给管理机。

- **隧道模式**：token 从远端日志取出，拼到本机转发地址上（`http://127.0.0.1:<本地端口>/?token=…`）。
- **已运行且未升级**：同样读取日志里**当前进程**打印的最后一行 URL，实现幂等。

若日志里没有 token，部署会失败并提示查看 `dsh-web.log` 或勾选升级后重启。

## API

| 路径 | 方法 | 作用 |
|------|------|------|
| `/api/threadharbor.host-ssh.inspect` | POST | 扫描主机密钥 |
| `/api/threadharbor.host-ssh.deploy` | POST | 异步部署（body 含 `accessMode` / `bindHost` / `trustedHost`） |
| `/api/threadharbor.host-ssh.operation` | GET | `?operationId=` 查询进度；成功时 `result.launchUrl` 含 token |

## 安全与限制

- `launchUrl` 含短期/进程级 launch token，与手动复制 `dsh web` 打印行等价；保存在**管理机** profile 登记数据中，请勿分享给不可信的人。
- SSH 部署**不安装** ACP agent 二进制。
- Tailscale 直连要求管理机浏览器能访问登记地址（通常同一 Tailnet）。
