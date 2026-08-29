# 远程主机、Agent 安装与登录

## Web profile 配置

`cordis.patch.yml` 中的 gateway 配置控制远程部署：

```yaml
config:
  sshKnownHostsPath: ~/.dsh/threadharbor/known_hosts
  sshConnectTimeoutMs: 15000
  sshInstallTimeoutMs: 600000
  hostdRemotePort: 3091
```

Gateway 从自己已安装的 `@threadharbor/hostd` 包读取 `bin.js` 与 `hold-worker.js`，通过受 host-key 校验保护的 SSH stdin 上传。远端不会再次从 npm 下载 hostd，因此部署版本与 Web 插件依赖的版本完全一致。

## SSH 输入

- `target`：可由 `ssh-keyscan` 直接访问的 DNS 名或 IP；
- `user`、`port`：可选；
- `identityFile`：DSH Web 服务所在机器上的绝对路径，文件内容不进入浏览器或 catalog；
- `proxyJump`：可选 OpenSSH ProxyJump 目标；
- `hostKeyFingerprint`：scan 后由用户从 Web 界面确认的 SHA256 指纹。

主机密钥扫描目前要求 gateway 能直接扫描最终 target。经 ProxyJump 才能到达、且不能直接扫描的目标，需要先由管理员把可信 host key 放入专用 known_hosts；后续版本会提供经 jump host 的扫描通道。

## hostd 服务

远程部署 hostd 需要 Node.js 22 或更新版本。上传与服务安装发生在普通用户目录：

```text
~/.local/share/threadharbor/current/
~/.local/state/threadharbor/
~/.config/systemd/user/threadharbor-hostd.service
```

ThreadHarbor 不自动安装系统 Node.js，也不调用 sudo。缺少合格 Node.js 时会在部署阶段停止并返回明确错误。Codex 与 Claude Code 的 npm 安装另行要求远端已有 npm。

## Agent 安装

打开主机后，每个 backend 会显示 installed、authenticated、running 和 session-capable 状态。点击“安装”只获取计划；Web 显示 package spec 与命令，用户再次确认才执行。

Codex 与 Claude Code 默认安装到 `~/.local`。hostd CLI 可覆盖 package spec、命令路径、超时和 npm prefix。Grok 的发行方式必须由 hostd 管理员通过 `--grok-install-command` 配置；这个配置不接受浏览器输入。

## Web 登录

点击“登录”后，hostd 启动独立子进程：

- Codex：`codex login --device-auth`；
- Grok：`grok login --device-auth`；
- Claude Code：`claude auth login`。

Web 会轮询 flow id，展示 HTTPS 授权地址、一次性代码和到期/成功/失败状态。授权完成后刷新 inventory。浏览器关闭或刷新不终止登录进程。Agent 的 token、auth JSON 与 keyring 数据始终留在目标主机。
