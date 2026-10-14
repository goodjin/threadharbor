/**
 * SSH trust, ThreadHarbor + DSH deployment on a remote machine, and loopback tunnels.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SshConnectionConfig, SshDeployProgress, SshDeployRequest, SshDeployResult, SshHostKeyCandidate } from './types.ts'
import { composeLaunchUrl, parseAccessMode, parseDeployMarkers } from './access.ts'
import { run, runWithEnv } from './run.ts'
import { freePort, portListening } from './port.ts'
import { deploymentChannel, destination, parseSshInput, shellQuote } from './parse.ts'
import { readReleaseVersion, resolveReleaseDirectory } from './release.ts'
import { DEFAULT_REMOTE_DSH_PLUGINS } from './deploy-plugins.ts'
import { buildRemoteAgentsPatchYaml } from './remote-agents.ts'
import { parsePeerStatus, type PeerStatus } from './peer-status.ts'

export type SshManagerOptions = {
  readonly knownHostsPath: string
  readonly connectTimeoutMs: number
  readonly installTimeoutMs: number
  readonly deploymentChannel: string
  readonly releaseDirectory?: string
  readonly defaultRemoteWebPort: number
  /** `dsh plugin --profile web add` specs (GitHub URLs). */
  readonly remotePlugins?: readonly string[]
  /** When true, skip tarball upload and install plugins from `remotePlugins` only. */
  readonly installPluginsFromGithub?: boolean
}

type ScanResult = SshHostKeyCandidate & { readonly knownHostLine: string }

interface OwnedTunnel {
  readonly child: ChildProcess
  readonly localPort: number
  readonly config: SshConnectionConfig
}

export class DshSshManager {
  private readonly tunnels = new Map<string, OwnedTunnel>()
  private readonly tunnelOps = new Map<string, Promise<void>>()
  private readonly tempKeys = new Set<string>()
  private readonly options: SshManagerOptions

  // A declared field with a plain assignment, not a constructor parameter
  // property: the web host loads linked plugins through Node's strip-only
  // TypeScript mode, which rejects parameter properties at import time.
  constructor(options: SshManagerOptions) {
    this.options = options
    deploymentChannel(options.deploymentChannel)
    mkdirSync(dirname(options.knownHostsPath), { recursive: true, mode: 0o700 })
    if (!existsSync(options.knownHostsPath)) writeFileSync(options.knownHostsPath, '', { mode: 0o600 })
  }

  parseInspectionConfig(value: unknown): SshConnectionConfig {
    return parseSshInput(value, false)
  }

  parseApprovedConfig(value: unknown): SshConnectionConfig {
    return parseSshInput(value, true)
  }

  async inspect(config: SshConnectionConfig): Promise<SshHostKeyCandidate> {
    const scans = await this.scan(config)
    const first = scans[0]
    if (first === undefined) throw new Error('unable to scan the SSH host key')
    return first
  }

  async inspectAll(config: SshConnectionConfig): Promise<readonly SshHostKeyCandidate[]> {
    return await this.scan(config)
  }

  /**
   * Read the peer record another host wrote for itself.
   *
   * Any machine with SSH credentials can do this; the file says whether
   * ThreadHarbor is installed and which URL / listen mode to use.
   */
  async readPeer(config: SshConnectionConfig): Promise<PeerStatus> {
    if (config.hostKeyFingerprint === 'unapproved') throw new Error('hostKeyFingerprint is required')
    const approved = config
    const scans = await this.scan(approved)
    const scan = scans.find(candidate => candidate.hostKeyFingerprint === approved.hostKeyFingerprint)
    if (scan === undefined) throw new Error('SSH host key changed or does not match the approved fingerprint')
    this.persistKnownHost(approved, scan.knownHostLine)
    const materialized = await this.materializeAuth(approved)
    try {
      const probe = await this.remoteExec(
        materialized,
        'cat "$HOME/.local/state/threadharbor/peer.json" 2>/dev/null || true',
        this.handshakeBudgetMs(),
      )
      if (probe.code === 255) {
        throw new Error(`无法使用当前 SSH 凭据连接目标主机：${probe.stderr.trim() || 'ssh 退出码 255'}`)
      }
      if (probe.code !== 0) return { pluginsInstalled: false }
      return parsePeerStatus(probe.stdout)
    } finally {
      this.cleanupTempKeys()
    }
  }

  async deploy(
    request: SshDeployRequest,
    onProgress: (progress: SshDeployProgress) => void = () => undefined,
  ): Promise<SshDeployResult> {
    const config = this.parseApprovedConfig(request.ssh)
    const accessMode = parseAccessMode(request.accessMode)
    const remotePort = request.remoteWebPort ?? this.options.defaultRemoteWebPort
    const channel = this.options.deploymentChannel
    const releaseRoot = resolveReleaseDirectory(this.options.releaseDirectory)
    const releaseVersion = readReleaseVersion(releaseRoot)

    onProgress({ phase: 'connecting', detail: '正在验证 SSH 主机身份和连接。' })
    const scans = await this.scan(config)
    const scan = scans.find(candidate => candidate.hostKeyFingerprint === config.hostKeyFingerprint)
    if (scan === undefined) {
      throw new Error('SSH host key changed or does not match the approved fingerprint')
    }
    this.persistKnownHost(config, scan.knownHostLine)

    const materialized = await this.materializeAuth(config)
    try {
      const probe = await this.remoteExec(materialized, [
        'set -eu',
        'node_path="$(command -v node 2>/dev/null || true)"',
        'if [ -z "$node_path" ] && [ -x /opt/homebrew/bin/node ]; then node_path=/opt/homebrew/bin/node; fi',
        'if [ -z "$node_path" ] && [ -x /usr/local/bin/node ]; then node_path=/usr/local/bin/node; fi',
        'if [ -z "$node_path" ] && [ -x "$HOME/.local/bin/node" ]; then node_path="$HOME/.local/bin/node"; fi',
        'test -n "$node_path"',
        '"$node_path" -e \'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)\'',
        'uname -s',
        'uname -m',
        'printf \'%s\\n\' "$node_path"',
      ].join('; '), this.handshakeBudgetMs())
      if (probe.code === 255) {
        throw new Error(`无法使用当前 SSH 凭据连接目标主机：${probe.stderr.trim() || 'ssh 退出码 255'}`)
      }
      if (probe.code !== 0) {
        throw new Error('远端需要 Node.js 22 或更高版本才能运行 DSH Web')
      }
      const lines = probe.stdout.trim().split(/\r?\n/)
      const nodePath = lines.at(-1)
      const uname = lines.at(-3)
      const arch = lines.at(-2)
      if (nodePath === undefined || !nodePath.startsWith('/') || /[\r\n\0]/.test(nodePath)) {
        throw new Error('远端返回的 Node 路径无效')
      }
      if (uname !== undefined && !['Linux', 'Darwin'].includes(uname.trim())) {
        throw new Error(`暂不支持的远端操作系统：${uname.trim()}（仅 Linux 与 macOS 经过验证）`)
      }
      if (arch !== undefined && /^(armv7|i386|i686)$/i.test(arch.trim())) {
        throw new Error(`暂不支持的 CPU 架构：${arch.trim()}`)
      }

      onProgress({ phase: 'preparing', detail: '正在准备远端目录。' })
      const releaseDir = `$HOME/.local/share/threadharbor/releases/${releaseVersion.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      const prepare = await this.remoteExec(materialized, [
        'set -eu',
        `channel=${shellQuote(channel)}`,
        `release=${releaseDir}`,
        'state="$HOME/.local/state/threadharbor/$channel"',
        'dsh_home="$HOME/.dsh-threadharbor-$channel"',
        'mkdir -p "$release" "$state" "$dsh_home" "$HOME/.config/systemd/user"',
      ].join('; '), this.handshakeBudgetMs())
      if (prepare.code !== 0) throw new Error('无法在远端创建 ThreadHarbor/DSH 目录')

      const installFromGithub = this.options.installPluginsFromGithub !== false
      if (!installFromGithub) {
        onProgress({ phase: 'uploading', detail: '正在上传 ThreadHarbor 发行包……', current: 0, total: 1 })
        await this.uploadReleaseTar(materialized, releaseRoot, releaseDir)
        onProgress({ phase: 'uploading', detail: '发行包上传完成。', current: 1, total: 1 })
      } else {
        onProgress({ phase: 'preparing', detail: '将通过 GitHub 地址安装插件，跳过本地上传。' })
      }

      onProgress({ phase: 'installing', detail: '正在安装 DSH 与 ThreadHarbor 插件。' })
      const remotePlugins = this.options.remotePlugins ?? DEFAULT_REMOTE_DSH_PLUGINS
      const installScript = buildInstallScript({
        channel,
        releaseDir,
        nodePath,
        remotePort: String(remotePort),
        hostId: request.hostId,
        hostTitle: request.hostTitle,
        upgrade: request.upgrade === true,
        installFromGithub,
        remotePlugins,
        remoteAgentsPatch: buildRemoteAgentsPatchYaml(request.remoteAgents),
      })
      const install = await this.remoteExec(materialized, installScript, this.options.installTimeoutMs)
      if (install.code !== 0) {
        const reason = install.stderr.trim() || install.stdout.trim() || `status ${install.code}`
        throw new Error(`远端安装失败：${reason}`)
      }
      const markers = parseDeployMarkers(install.stdout)
      const alreadyRunning = markers.alreadyRunning
      const bindHost = '127.0.0.1'
      const remoteLaunch = markers.launchUrl
      if (remoteLaunch === undefined || remoteLaunch === '') {
        throw new Error('未能从远端日志读取带 ?token= 的 dsh web 启动 URL；请查看远端 dsh-web.log 或勾选升级后重试')
      }

      onProgress({ phase: 'starting', detail: alreadyRunning ? '远端服务已在运行，已读取现有启动 URL。' : '正在启动远端 DSH Web。' })

      onProgress({ phase: 'opening-tunnel', detail: '正在建立本机到远端 loopback 的 SSH 端口转发。' })
      const endpoint = await this.ensureTunnelWithAuth(materialized, remotePort)

      onProgress({ phase: 'verifying', detail: '正在确认 DSH Web 健康检查。' })
      const healthy = await this.waitRemoteHealthy(endpoint)
      if (!healthy) {
        throw new Error('部署后远端 DSH Web 未通过健康检查（本机隧道端口无响应）')
      }

      const launchUrl = composeLaunchUrl(endpoint, remoteLaunch)

      onProgress({ phase: 'succeeded', detail: '部署完成。' })
      return {
        endpoint,
        launchUrl,
        accessMode,
        bindHost,
        remoteWebPort: remotePort,
        releaseVersion,
        alreadyRunning,
      }
    } finally {
      this.cleanupTempKeys()
    }
  }

  async ensureTunnel(config: SshConnectionConfig, remotePort: number): Promise<string> {
    const materialized = await this.materializeAuth(config)
    try {
      return await this.ensureTunnelWithAuth(materialized, remotePort)
    } finally {
      this.cleanupTempKeys()
    }
  }

  releaseTunnel(config: SshConnectionConfig): void {
    const key = alias(config)
    const tunnel = this.tunnels.get(key)
    if (tunnel !== undefined) this.stopTunnel(tunnel)
    this.tunnels.delete(key)
  }

  close(): void {
    for (const tunnel of this.tunnels.values()) this.stopTunnel(tunnel)
    this.tunnels.clear()
    this.cleanupTempKeys()
  }

  private async ensureTunnelWithAuth(config: SshConnectionConfig, remotePort: number): Promise<string> {
    const key = alias(config)
    const prior = this.tunnelOps.get(key) ?? Promise.resolve()
    const runTunnel = prior.then(async () => {
      const existing = this.tunnels.get(key)
      if (existing !== undefined
        && (existing.child.exitCode === null || await portListening(existing.localPort))) {
        return `http://127.0.0.1:${existing.localPort}`
      }
      const localPort = await freePort()
      await this.startTunnel(config, localPort, remotePort)
      return `http://127.0.0.1:${localPort}`
    })
    this.tunnelOps.set(key, runTunnel.then(() => {}, () => {}))
    return runTunnel
  }

  private async waitRemoteHealthy(endpoint: string, budgetMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${endpoint}/`)
        if (response.ok || response.status === 401) return true
      } catch {
        // retry
      }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    return false
  }

  private async uploadReleaseTar(config: SshConnectionConfig, localRelease: string, remoteReleaseDir: string): Promise<void> {
    const sshCommand = config.password !== undefined ? 'sshpass' : 'ssh'
    const sshBase = config.password !== undefined ? ['-e', 'ssh', ...this.sshArgs(config)] : this.sshArgs(config)
    const args = [
      ...sshBase,
      destination(config),
      `set -eu; umask 077; mkdir -p ${remoteReleaseDir}; tar xzf - -C ${remoteReleaseDir}`,
    ]
    const child = spawn(sshCommand, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.sshEnv(config) })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192) })
    const tar = spawn('tar', ['czf', '-', '-C', localRelease, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
    tar.stdout.pipe(child.stdin)
    child.stdin.on('error', () => undefined)
    const codes = await Promise.all([
      new Promise<number>((resolve, reject) => {
        tar.on('error', reject)
        tar.on('exit', code => resolve(code ?? 1))
      }),
      new Promise<number>((resolve, reject) => {
        child.on('error', reject)
        child.on('exit', code => resolve(code ?? 1))
      }),
    ])
    if (codes[0] !== 0 || codes[1] !== 0) {
      throw new Error(`上传发行包失败：${stderr.trim() || `tar=${codes[0]} ssh=${codes[1]}`}`)
    }
  }

  private async remoteExec(config: SshConnectionConfig, script: string, timeoutMs: number) {
    const env = this.sshEnv(config)
    const sshArgs = [...this.sshArgs(config), destination(config), script]
    if (config.password !== undefined) {
      return await runWithEnv('sshpass', ['-e', 'ssh', ...sshArgs], timeoutMs, env)
    }
    return await runWithEnv('ssh', sshArgs, timeoutMs, env)
  }

  private sshEnv(config: SshConnectionConfig): NodeJS.ProcessEnv {
    if (config.password === undefined) return process.env
    return { ...process.env, SSHPASS: config.password }
  }

  private async materializeAuth(config: SshConnectionConfig): Promise<SshConnectionConfig> {
    if (config.identityPem === undefined) return config
    const dir = dirname(this.options.knownHostsPath)
    const path = join(dir, `id-${randomUUID()}`)
    writeFileSync(path, `${config.identityPem.trim()}\n`, { mode: 0o600 })
    this.tempKeys.add(path)
    const { identityPem: _drop, ...rest } = config
    return { ...rest, identityFile: path }
  }

  private cleanupTempKeys(): void {
    for (const path of this.tempKeys) {
      try {
        rmSync(path, { force: true })
      } catch {
        // best effort
      }
    }
    this.tempKeys.clear()
  }

  private async scan(config: SshConnectionConfig): Promise<readonly ScanResult[]> {
    const port = String(config.port ?? 22)
    const scan = await run(
      'ssh-keyscan',
      ['-T', String(Math.ceil(this.handshakeBudgetMs() / 1000)), '-p', port, config.target],
      this.handshakeBudgetMs(),
    )
    const lines = scan.stdout.split('\n').filter(candidate => candidate !== '' && !candidate.startsWith('#'))
    if (scan.code !== 0 || lines.length === 0) throw new Error('无法扫描 SSH 主机密钥（主机不可达或端口错误）')
    const results: ScanResult[] = []
    for (const line of lines) {
      const fields = line.trim().split(/\s+/)
      const algorithm = fields[1]
      if (algorithm === undefined) continue
      const fingerprint = await run('ssh-keygen', ['-lf', '-', '-E', 'sha256'], this.options.connectTimeoutMs, `${line}\n`)
      const value = fingerprint.stdout.match(/\b(SHA256:[A-Za-z0-9+/=]+)\b/)?.[1]
      if (fingerprint.code === 0 && value !== undefined) {
        results.push({
          target: config.target,
          hostKeyFingerprint: value,
          algorithm,
          knownHostLine: line,
        })
      }
    }
    if (results.length === 0) throw new Error('无法计算 SSH 主机密钥指纹')
    return results
  }

  private persistKnownHost(config: SshConnectionConfig, scannedLine: string): void {
    const fields = scannedLine.trim().split(/\s+/)
    const key = fields.slice(1).join(' ')
    const hostAlias = alias(config)
    const entry = `${hostAlias} ${key}`
    const existing = readFileSync(this.options.knownHostsPath, 'utf8')
      .split('\n')
      .filter(line => line !== '' && !line.startsWith(`${hostAlias} `))
    writeFileSync(this.options.knownHostsPath, `${[...existing, entry].join('\n')}\n`, { mode: 0o600 })
  }

  private handshakeBudgetMs(): number {
    return this.options.connectTimeoutMs * 4
  }

  private muxArgs(config: SshConnectionConfig): string[] {
    const dir = dirname(this.options.knownHostsPath)
    const hash = createHash('sha256')
      .update(`${config.user ?? ''}\0${config.target}\0${config.port ?? 22}\0${config.identityFile ?? ''}\0${config.proxyJump ?? ''}`)
      .digest('hex').slice(0, 16)
    const controlPath = join(dir, `cm-${hash}`)
    if (controlPath.length + 18 > 100) return []
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      return []
    }
    return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=120']
  }

  private sshArgs(config: SshConnectionConfig): string[] {
    const usePassword = config.password !== undefined
    if (usePassword && !commandExists('sshpass')) {
      throw new Error('密码登录需要在本机安装 sshpass（例如 apt install sshpass / brew install sshpass）')
    }
    return [
      '-o', usePassword ? 'BatchMode=no' : 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${this.options.knownHostsPath}`,
      '-o', `HostKeyAlias=${alias(config)}`,
      '-o', `ConnectTimeout=${Math.ceil(this.options.connectTimeoutMs / 1000)}`,
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      ...this.muxArgs(config),
      ...(config.port === undefined ? [] : ['-p', String(config.port)]),
      ...(config.identityFile === undefined ? [] : ['-i', config.identityFile, '-o', 'IdentitiesOnly=yes']),
      ...(config.proxyJump === undefined ? [] : ['-J', config.proxyJump]),
      ...(config.password === undefined ? [] : ['-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no']),
    ]
  }

  private stopTunnel(tunnel: OwnedTunnel): void {
    if (tunnel.child.exitCode === null) tunnel.child.kill('SIGTERM')
    const mux = this.muxArgs(tunnel.config)
    if (mux.length === 0) return
    void run('ssh', [...mux, '-O', 'exit', destination(tunnel.config)], 5_000).catch(() => undefined)
  }

  private async startTunnel(config: SshConnectionConfig, localPort: number, remotePort: number): Promise<void> {
    const key = alias(config)
    const current = this.tunnels.get(key)
    if (current !== undefined && current.child.exitCode === null) current.child.kill('SIGTERM')
    const sshCommand = config.password !== undefined ? 'sshpass' : 'ssh'
    const sshBase = config.password !== undefined ? ['-e', 'ssh', ...this.sshArgs(config)] : this.sshArgs(config)
    const args = [
      ...sshBase, '-N', '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      destination(config),
    ]
    const tunnel = spawn(sshCommand, args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.sshEnv(config) })
    this.tunnels.set(key, { child: tunnel, localPort, config })
    let error = ''
    tunnel.stderr?.on('data', (chunk: Buffer) => { error = `${error}${chunk.toString('utf8')}`.slice(-4096) })
    const outcome = await new Promise<{ exited?: number | null; failure?: Error }>((resolveOutcome) => {
      const timer = setTimeout(() => resolveOutcome({}), 350)
      tunnel.once('error', (cause) => { clearTimeout(timer); resolveOutcome({ failure: cause }) })
      tunnel.once('exit', (code) => { clearTimeout(timer); resolveOutcome({ exited: code }) })
    })
    if (outcome.failure !== undefined) throw outcome.failure
    if (outcome.exited === undefined) return
    if (outcome.exited === 0 && await portListening(localPort, 8)) return
    throw new Error(`SSH 隧道建立失败（退出码 ${outcome.exited ?? 1}）：${error.trim()}`)
  }
}

function alias(config: SshConnectionConfig): string {
  return `threadharbor-${createHash('sha256').update(`${config.target}\0${config.port ?? 22}`).digest('hex').slice(0, 24)}`
}

function commandExists(name: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
  return result.status === 0
}

function buildInstallScript(input: {
  readonly channel: string
  readonly releaseDir: string
  readonly nodePath: string
  readonly remotePort: string
  readonly hostId: string
  readonly hostTitle: string
  readonly upgrade: boolean
  readonly installFromGithub: boolean
  readonly remotePlugins: readonly string[]
  readonly remoteAgentsPatch: string
}): string {
  const {
    channel, releaseDir, nodePath, remotePort, hostId, hostTitle, upgrade, installFromGithub, remotePlugins,
    remoteAgentsPatch,
  } = input
  const pluginPayload = shellQuote(remotePlugins.join('\n'))
  const agentsPatchPayload = shellQuote(remoteAgentsPatch)
  return [
    'set -eu',
    `channel=${shellQuote(channel)}`,
    `release=${releaseDir}`,
    `node=${shellQuote(nodePath)}`,
    `port=${remotePort}`,
    `host_id=${shellQuote(hostId)}`,
    `host_title=${shellQuote(hostTitle)}`,
    'node_dir="$(dirname "$node")"',
    'common_path="$node_dir:$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"',
    'export PATH="$common_path"',
    'dsh_home="$HOME/.dsh-threadharbor-$channel"',
    'state="$HOME/.local/state/threadharbor/$channel"',
    'log_file="$state/dsh-web.log"',
    'export DSH_HOME="$dsh_home"',
    'if ! command -v dsh >/dev/null 2>&1; then',
    '  if ! command -v npm >/dev/null 2>&1; then echo "npm not found; install Node npm or place dsh on PATH" >&2; exit 1; fi',
    '  npm install -g @deepseek-ai/dsh@">=0.2.0-rc.2 <0.3"',
    'fi',
    installFromGithub
      ? `plugin_specs=${pluginPayload}`
      : '',
    installFromGithub
      ? 'printf \'%s\\n\' "$plugin_specs" | while IFS= read -r spec; do [ -z "$spec" ] && continue; dsh plugin --profile web add "$spec" || dsh plugin --profile web add "$spec"; done'
      : 'dsh plugin --profile web add "link:$release" || dsh plugin --profile web add "link:$release"',
    `agents_patch_yaml=${agentsPatchPayload}`,
    'agents_patch="$dsh_home/profiles/web/threadharbor-remote-agents.patch.yml"',
    'mkdir -p "$(dirname "$agents_patch")"',
    'printf \'%s\' "$agents_patch_yaml" > "$agents_patch"',
    'bind_host="127.0.0.1"',
    'identity_file="$dsh_home/profiles/web/threadharbor-identity.env"',
    'printf \'DSH_HOST_ID=%s\\nDSH_HOST_TITLE=%s\\n\' "$host_id" "$host_title" > "$identity_file"',
    'case "$bind_host" in (0.0.0.0|"") echo "refusing wildcard bind" >&2; exit 1;; esac',
    'dsh_bin="$(command -v dsh)"',
    'dsh_args="--profile web --no-open --port $port --host $bind_host --patch $agents_patch"',
    'service_name="threadharbor-dsh-web-$channel.service"',
    'service="$HOME/.config/systemd/user/$service_name"',
    'printf \'%s\\n\' \'[Unit]\' "Description=ThreadHarbor DSH Web ($channel)" \'After=network-online.target\' \'\' \'[Service]\' "Environment=PATH=$common_path" "Environment=DSH_HOME=$dsh_home" "EnvironmentFile=-$identity_file" "ExecStart=$dsh_bin $dsh_args" \'Restart=on-failure\' \'RestartSec=2\' \'\' \'[Install]\' \'WantedBy=default.target\' > "$service"',
    'health_url() { printf \'http://%s:%s/\' "$bind_host" "$port"; }',
    'port_pids() { { if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:' + remotePort + ' -sTCP:LISTEN -t 2>/dev/null; elif command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :' + remotePort + '" 2>/dev/null | grep -o "pid=[0-9]*" | cut -d= -f2; elif command -v fuser >/dev/null 2>&1; then fuser ' + remotePort + '/tcp 2>/dev/null; fi; } | tr " " "\\n" | grep -E "^[0-9]+$" | sort -u; }',
    'port_busy() { if command -v ss >/dev/null 2>&1; then [ -n "$(ss -ltnH "sport = :' + remotePort + '" 2>/dev/null)" ]; elif command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:' + remotePort + ' -sTCP:LISTEN >/dev/null 2>&1; elif command -v fuser >/dev/null 2>&1; then fuser ' + remotePort + '/tcp >/dev/null 2>&1; else return 1; fi; }',
    'launch_url_from_log() {',
    '  url=""',
    '  if [ -f "$log_file" ]; then url="$(grep -E \'^dsh web: \' "$log_file" | tail -1 | sed \'s/^dsh web: //\')"; fi',
    '  if [ -z "$url" ] && command -v journalctl >/dev/null 2>&1; then url="$(journalctl --user -u "$service_name" -n 40 --no-pager 2>/dev/null | grep \'dsh web:\' | tail -1 | sed \'s/.*dsh web: //\')"; fi',
    '  printf \'%s\' "$url"',
    '}',
    'emit_success() {',
    '  url="$(launch_url_from_log)"',
    '  if [ -z "$url" ]; then echo "missing launch url in log" >&2; exit 1; fi',
    '  echo "BIND_HOST=$bind_host"',
    '  echo "LAUNCH_URL=$url"',
    '  mkdir -p "$HOME/.local/state/threadharbor"',
    '  PEER_URL="$url" PEER_BIND="$bind_host" PEER_PORT="$port" "$node" -e \'const fs=require("fs");const os=require("os");const path=require("path");const body={pluginsInstalled:true,listen:"loopback",port:Number(process.env.PEER_PORT),bindHost:process.env.PEER_BIND,launchUrl:process.env.PEER_URL};const file=path.join(os.homedir(),".local/state/threadharbor/peer.json");fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(body),{mode:384});\'',
    '  exit 0',
    '}',
    'already=0',
    'if port_busy && command -v curl >/dev/null 2>&1; then code="$(curl -fsS -o /dev/null -w "%{http_code}" "$(health_url)" 2>/dev/null || true)"; case "$code" in 200|401) already=1;; esac; fi',
    'if [ "$already" = "1" ]; then echo ALREADY_RUNNING=1; fi',
    upgrade ? '' : 'if [ "$already" = "1" ]; then emit_success; fi',
    'if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl --user daemon-reload && systemctl --user enable --now "$service_name" && systemctl --user restart "$service_name"',
    'else',
    'pid_file="$state/dsh-web.pid"',
    'if [ -f "$pid_file" ]; then old_pid="$(cat "$pid_file")"; case "$old_pid" in (*[!0-9]*|"") ;; (*) kill "$old_pid" 2>/dev/null || true ;; esac; fi',
    'for pid in $(port_pids); do kill "$pid" 2>/dev/null || true; done',
    'for _ in 1 2 3 4 5 6 7 8 9 10; do port_busy || break; sleep 0.5; done',
    'nohup $dsh_bin $dsh_args >>"$log_file" 2>&1 </dev/null & printf \'%s\\n\' "$!" > "$pid_file"',
    'fi',
    'for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do',
    '  if command -v curl >/dev/null 2>&1; then code="$(curl -fsS -o /dev/null -w "%{http_code}" "$(health_url)" 2>/dev/null || true)"; case "$code" in 200|401) emit_success;; esac; fi',
    '  sleep 1',
    'done',
    'echo "DSH Web did not become healthy" >&2',
    'exit 1',
  ].filter(line => line !== '').join('; ')
}
