# SSH 自动部署远端 DSH

在**提供 Web 页面的那台机器**（本机 loopback）上，ThreadHarbor 可以通过 OpenSSH 把当前发行包里的 DSH Web 与 ThreadHarbor 插件装到另一台 Linux/macOS 主机上，并建立 `127.0.0.1` 端口转发，便于登记与访问。

## 前置条件

- 管理端：正在运行 `dsh --profile web` 的本机，组合里包含 `threadharbor-ssh-deploy` 行（见根目录 `cordis.patch.yml`）。
- 目标机：SSH 可达，Node.js **22+**，能访问 npm（用于安装 `@deepseek-ai/dsh`，若尚未安装）。
- 管理端本机：已安装 `openssh-client`；使用**密码**登录时需额外安装 `sshpass`。
- 发行包：默认上传 `~/.local/share/threadharbor/stable-current`；开发时可指向当前工作区（见插件配置 `releaseDirectory`）。

## 使用步骤

1. 打开侧栏 **各主机** → **添加新主机** → **SSH 自动部署**。
2. 填写 SSH 目标、用户、端口，以及认证方式：
   - **本机私钥路径**：私钥文件在 **Web 服务主机**上的绝对路径（与旧版 gateway 相同，密钥字节不经过浏览器协议）。
   - **粘贴私钥 PEM**：经已认证的 `/api` 请求发给本机 DSH，写入临时文件后删除。
   - **密码**：经 `/api` 交给本机 `sshpass`，不会写入日志。
3. 点击 **检查 SSH 主机密钥**，核对 SHA256 指纹后选择要信任的那把钥匙。
4. 填写主机标识、显示名与远端 DSH Web 端口（默认 3081，仅监听远端 `127.0.0.1`）。
5. 点击 **部署 DSH 并登记**。进度通过 `threadharbor.host-ssh.operation` 轮询展示。
6. 成功后登记地址为 `http://127.0.0.1:<本地转发端口>`。在浏览器打开该地址（需远端 `dsh web` 打印的 `?token=…`）后，跨标签页频道才会显示 **在线**。

## 设计说明与限制

- **幂等**：若远端同端口已有健康的 DSH Web 且未勾选升级，部署会跳过并返回 `alreadyRunning`；勾选升级会重新上传发行包并重启服务。
- **不支持的操作系统**：安装脚本仅验证 Linux / Darwin；其他 `uname` 会报错。
- **远端身份**：部署脚本会写入 `DSH_HOME/profiles/web/threadharbor-identity.env` 供 systemd/nohup 环境使用；请在远端面板上确认 **主机标识** 与登记一致。
- **Agent**：SSH 部署只装 DSH 与 ThreadHarbor bundle，不安装 Codex/Grok/Claude 等 ACP 二进制；需在目标机自行安装并在 profile 中配置 preset。
- **安全**：转发把远端 DSH 的远程执行能力映射到管理机 loopback；仅信任的网络路径应能访问该端口。

## API（供集成与测试）

| 路径 | 方法 | 作用 |
|------|------|------|
| `/api/threadharbor.host-ssh.inspect` | POST | 扫描主机密钥 |
| `/api/threadharbor.host-ssh.deploy` | POST | 启动异步部署，返回 `operationId` |
| `/api/threadharbor.host-ssh.operation` | GET | `?operationId=` 查询进度与结果 |
