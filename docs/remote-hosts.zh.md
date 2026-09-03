# 远程主机、Agent 发现与登录

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

ThreadHarbor 不自动安装系统 Node.js，也不调用 sudo。缺少合格 Node.js 时会在部署阶段停止并返回明确错误。

## 运行日志

hostd 和 detached hold-worker 的运行日志进入同一个服务日志流。systemd user service 下使用 `journalctl --user -u threadharbor-hostd-<channel>.service` 查看；没有 systemd、使用 detached fallback 时查看 `~/.local/state/threadharbor/<channel>/hostd.log`。

hold-worker 会输出低频 JSON line 指标，前缀为 `threadharbor-hold-journal`，用于实际运行后分析 journal IO 行为。当前记录恢复、追加采样和 compact 事件，包含 backend、holdId、journalEvents、journalBytes、latestSeq、droppedThrough、appendsSinceCompact 和写入耗时。设置 `THREADHARBOR_HOLD_JOURNAL_METRICS=0` 可以关闭这类指标日志。

## Agent 发现与部署

hostd 从服务 `PATH`、当前 Node 的 `npm prefix -g`/bin，以及 Python user scripts 发现下面的命令。未安装时，主机设置会显示部署按钮；确认后 hostd 在该主机上执行官方安装命令，安装到 npm/pip 自己的目录，而不是 ThreadHarbor 另开前缀：

- Codex：`npm install -g @openai/codex@0.150.1 @agentclientprotocol/codex-acp@1.6.2`
- Grok：`npm install -g @xai-official/grok@1.0.5`
- Claude Code：`npm install -g @anthropic-ai/claude-code@2.1.251 @agentclientprotocol/claude-agent-acp@0.69.0`
- DSH：`python3 -m pip install --user --upgrade deepseek-harness-runtime-bin==0.1.1rc1`

远端管理员也可以按各 Agent 的官方方式自行安装。hostd 发现的命令：

- Codex：`codex` 与 `codex-acp`；
- Grok：`grok`；
- Claude Code：`claude` 与 `claude-agent-acp`；
- DSH：`dsh-jsonrpc-agent`。

SSH 自动部署为 hostd 配置以下通用路径：Node.js 可执行文件所在目录、`~/.local/bin`、`~/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin` 和 `/bin`。使用其他位置时，应把命令链接到这些目录之一；直接启动 hostd 时也可以通过 `--codex-cli-command`、`--codex-command`、`--grok-command`、`--claude-command`、`--claude-acp-command` 和 `--dsh-command` 指定绝对路径。

`dsh-jsonrpc-agent` 还需要配置文件路径。远端可设置 `DSH_CORDIS_CONFIG`，或在直接启动 hostd 时传入 `--dsh-arg <cordis.yml>`。打开主机后，每个 backend 会显示 installed、authenticated、running 和 session-capable 状态；重新安装或调整 `PATH` 后刷新库存即可。

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
