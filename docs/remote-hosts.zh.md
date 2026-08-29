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

ThreadHarbor 不自动安装系统 Node.js，也不调用 sudo。缺少合格 Node.js 时会在部署阶段停止并返回明确错误。Codex、Grok 与 Claude Code 的安装另行要求远端已有 npm。

## Agent 安装

打开主机后，每个 backend 会显示 installed、authenticated、running 和 session-capable 状态。点击“安装”只获取计划；Web 显示 package spec 与命令，用户再次确认才执行。

三种安装方案都编译在 hostd adapter 中，浏览器请求只有 backend 和 `confirm: true`，不能提交命令、package spec 或参数：

- Codex：`@openai/codex@latest` 与 `@agentclientprotocol/codex-acp@latest`；
- Grok：`@xai-official/grok@latest`；
- Claude Code：`@anthropic-ai/claude-code@latest`。

它们通过 npm 安装到 hostd 的用户 prefix，默认为 `~/.local`。部署管理员可以改变 prefix、超时和已安装 executable 的查找位置，但不能替换安装包或安装命令。

## Agent 配置

每个 Codex、Grok 和 Claude Code 行都有“配置”入口。浏览器只提交 backend、完整内容和上次读取的 revision；不能提交路径。hostd 固定映射并遵循各产品官方 home 环境变量：

- Codex：`${CODEX_HOME:-~/.codex}/config.toml`，TOML；
- Grok：`${GROK_HOME:-~/.grok}/config.toml`，TOML；
- Claude Code：`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`，JSON object。

hostd 在写入前限制 UTF-8 字节数、解析 TOML/JSON，并比较 revision；文件在打开后被其他进程修改时拒绝覆盖。写入使用 owner-only 临时文件和原子 rename。配置编辑器传输的是完整用户配置内容，不应用来保存明文 API key；密钥应放在远程环境变量或 Agent 自己的凭据存储中。

## Web 登录

点击“登录”后，hostd 启动独立子进程：

- Codex：`codex login --device-auth`；
- Grok：`grok login --device-auth`；
- Claude Code：`claude auth login`。

Web 会轮询 flow id，展示 HTTPS 授权地址、一次性代码和到期/成功/失败状态。授权完成后刷新 inventory。浏览器关闭或刷新不终止登录进程。Agent 的 token、auth JSON 与 keyring 数据始终留在目标主机。
