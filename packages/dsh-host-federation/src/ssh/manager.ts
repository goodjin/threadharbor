/**
 * SSH trust, ThreadHarbor + DSH deployment on a remote machine, and loopback tunnels.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SshConnectionConfig, SshConnectResult, SshDeployProgress, SshDeployRequest, SshDeployResult, SshHostKeyCandidate } from './types.ts'
import { composeLaunchUrl, latestLaunchUrl, parseAccessMode, parseDeployMarkers, planConnection } from './access.ts'
import { run, runWithEnv, type RunResult } from './run.ts'
import { freePort, portListening } from './port.ts'
import { deploymentChannel, destination, parseSshInput, shellQuote } from './parse.ts'
import { readReleaseVersion, resolveReleaseDirectory } from './release.ts'
import { DEFAULT_REMOTE_DSH_PLUGINS } from './deploy-plugins.ts'
import { buildRemoteAgentsPatchYaml } from './remote-agents.ts'
import { parsePeerStatus, type PeerStatus } from './peer-status.ts'
import {
  buildPeerCheckScript,
  buildServeScript,
  buildServiceScript,
  manualServeCommands,
  type ServiceVerb,
  derivePeerCheckSteps,
  launchToken,
  parsePeerCheckOutput,
  type PeerCheckReport,
  type PeerHttpsProbe,
} from './peer-check.ts'
import { buildLivenessProbe, classifyLiveness, decidePeerReport, type PeerReport } from './liveness.ts'
import { buildRemoteEnv, buildStartBranch, buildStartScript } from './start-script.ts'

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

export type ServeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly manualCommands?: readonly string[] }

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
   * Read the peer record another host wrote for itself, then ask that machine
   * whether its DSH web process is actually up.
   *
   * Any machine with SSH credentials can do this; the file says whether
   * ThreadHarbor is installed and which URL / listen mode to use. The record
   * alone cannot vouch for liveness, so — still on the same SSH connection —
   * the loopback port from the record is probed. No record means no port to
   * probe: undeployed with liveness `unknown`, never a guess. The whole read
   * runs on a capped budget; expiry reports `unknown` with a timeout note and
   * never `stopped`.
   */
  async readPeer(config: SshConnectionConfig): Promise<PeerReport> {
    if (config.hostKeyFingerprint === 'unapproved') throw new Error('hostKeyFingerprint is required')
    const approved = config
    const scans = await this.scan(approved)
    const scan = scans.find(candidate => candidate.hostKeyFingerprint === approved.hostKeyFingerprint)
    if (scan === undefined) throw new Error('SSH host key changed or does not match the approved fingerprint')
    this.persistKnownHost(approved, scan.knownHostLine)
    const materialized = await this.materializeAuth(approved)
    const deadline = Date.now() + this.peerReadBudgetMs()
    try {
      let record: RunResult
      try {
        record = await this.remoteExec(
          materialized,
          'cat "$HOME/.local/state/threadharbor/peer.json" 2>/dev/null || true',
          this.peerReadBudgetMs(),
        )
      } catch (error) {
        if (readTimedOut(error)) return { pluginsInstalled: false, liveness: 'unknown', livenessNote: '读取超时' }
        throw error
      }
      if (record.code === 255) {
        throw new Error(`无法使用当前 SSH 凭据连接目标主机：${record.stderr.trim() || 'ssh 退出码 255'}`)
      }
      if (record.code !== 0) return { pluginsInstalled: false, liveness: 'unknown' }
      const peer = parsePeerStatus(record.stdout)
      if (!peer.pluginsInstalled || peer.port === undefined) return decidePeerReport(peer, undefined)
      let probe: RunResult
      try {
        probe = await this.remoteExec(
          materialized,
          buildLivenessProbe(peer.port),
          Math.max(deadline - Date.now(), 1),
        )
      } catch (error) {
        if (readTimedOut(error)) return { ...peer, liveness: 'unknown', livenessNote: '读取超时' }
        throw error
      }
      return decidePeerReport(peer, { code: probe.code, stdout: probe.stdout })
    } finally {
      this.cleanupTempKeys()
    }
  }

  /**
   * One SSH round trip reading every readiness fact of a peer meant to be
   * reached through `tailscale serve`, then an HTTPS probe of its ts.net URL
   * from this machine. Never throws for a missing piece — only for SSH trust
   * or credential failures, which the UI shows on the `ssh` step.
   */
  async checkPeer(config: SshConnectionConfig, remoteWebPort?: number): Promise<PeerCheckReport> {
    const port = remoteWebPort ?? this.options.defaultRemoteWebPort
    const materialized = await this.trustAndMaterialize(config)
    try {
      const probe = await this.remoteExec(materialized, buildPeerCheckScript(port), this.handshakeBudgetMs())
      if (probe.code === 255) {
        throw new Error(`无法使用当前 SSH 凭据连接目标主机：${probe.stderr.trim() || 'ssh 退出码 255'}`)
      }
      let facts = parsePeerCheckOutput(probe.stdout, port)
      // The peer record knows the real port when it differs from the default.
      if (remoteWebPort === undefined && facts.peer.port !== undefined && facts.peer.port !== port) {
        const again = await this.remoteExec(materialized, buildPeerCheckScript(facts.peer.port), this.handshakeBudgetMs())
        if (again.code === 0) facts = parsePeerCheckOutput(again.stdout, facts.peer.port)
      }
      const https = facts.serveUrl === undefined ? undefined : await probeServeHttps(facts.serveUrl, launchToken(facts.peer))
      return derivePeerCheckSteps(facts, https)
    } finally {
      this.cleanupTempKeys()
    }
  }

  /**
   * Point `tailscale serve` (HTTPS 443) on the peer at its DSH loopback port,
   * as the SSH user and then via `sudo -n`. When both are refused the result
   * carries the exact commands for the operator to run on the peer.
   */
  async configureServe(config: SshConnectionConfig, remoteWebPort?: number): Promise<ServeOutcome> {
    const port = remoteWebPort ?? this.options.defaultRemoteWebPort
    const materialized = await this.trustAndMaterialize(config)
    try {
      const result = await this.remoteExec(materialized, buildServeScript(port), this.handshakeBudgetMs())
      if (result.code === 0) return { ok: true }
      if (result.code === 255) throw new Error(`无法使用当前 SSH 凭据连接目标主机：${result.stderr.trim() || 'ssh 退出码 255'}`)
      return {
        ok: false,
        error: `配置 tailscale serve 失败：${result.stderr.trim() || `退出码 ${result.code}`}`,
        ...(result.code === 3 ? {} : { manualCommands: manualServeCommands(port) }),
      }
    } finally {
      this.cleanupTempKeys()
    }
  }

  /**
   * `systemctl start|restart` of the deployed DSH Web unit (user unit, or
   * system unit via `sudo -n`), then re-read the launch token into peer.json.
   */
  async controlService(config: SshConnectionConfig, verb: ServiceVerb, remoteWebPort?: number): Promise<{ readonly launchUrl: string; readonly scope: string }> {
    const port = remoteWebPort ?? this.options.defaultRemoteWebPort
    const materialized = await this.trustAndMaterialize(config)
    try {
      const result = await this.remoteExec(materialized, buildServiceScript(verb, this.options.deploymentChannel, port), this.handshakeBudgetMs() + 45_000)
      if (result.code === 255) throw new Error(`无法使用当前 SSH 凭据连接目标主机：${result.stderr.trim() || 'ssh 退出码 255'}`)
      if (result.code === 5) throw new Error('对方没有 ThreadHarbor 安装的 systemd 服务；请先「安装/部署 DSH 与插件」')
      if (result.code !== 0) throw new Error(`${verb === 'start' ? '启动' : '重启'} DSH 失败：${result.stderr.trim() || `退出码 ${result.code}`}`)
      const markers = parseDeployMarkers(result.stdout)
      const scope = /SERVICE_SCOPE=(\w+)/.exec(result.stdout)?.[1] ?? 'user'
      return { launchUrl: markers.launchUrl ?? '', scope }
    } finally {
      this.cleanupTempKeys()
    }
  }

  private async trustAndMaterialize(config: SshConnectionConfig): Promise<SshConnectionConfig> {
    if (config.hostKeyFingerprint === 'unapproved') throw new Error('hostKeyFingerprint is required')
    const scans = await this.scan(config)
    const scan = scans.find(candidate => candidate.hostKeyFingerprint === config.hostKeyFingerprint)
    if (scan === undefined) throw new Error('SSH host key changed or does not match the approved fingerprint')
    this.persistKnownHost(config, scan.knownHostLine)
    return await this.materializeAuth(config)
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

      if (request.accessMode === 'serve') {
        // ts.net 接入：对方由 tailscale serve 暴露，安装脚本已在对方本机做过健康检查；
        // 不建 SSH 隧道。endpoint 记对方回环地址，仅作信息，登记由检测清单用 ts.net 完成。
        onProgress({ phase: 'succeeded', detail: '部署完成。' })
        return {
          endpoint: `http://127.0.0.1:${remotePort}`,
          launchUrl: remoteLaunch,
          accessMode,
          bindHost,
          remoteWebPort: remotePort,
          releaseVersion,
          alreadyRunning,
        }
      }

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

  /**
   * 确保一条到远端 `127.0.0.1:<remotePort>` 的本地转发，返回 endpoint 字符串。
   *
   * `opts.localPort`（中转隧道池用）：本地端口服从调用方分配而不是自选。各
   * 机的认证凭据绑定 authority（`127.0.0.1:<本地端口>`），落盘的端口和实际
   * 监听的端口分家会让凭据对着没人监听的地址静默失败——所以指定了就必须
   * 逐字执行。不传时行为与既有消费方（远程会话等）完全一致：自选临时端口。
   */
  async ensureTunnel(config: SshConnectionConfig, remotePort: number, opts?: { readonly localPort?: number }): Promise<string> {
    const requested = opts?.localPort
    // 调用方指定端口时在这里挡住非法值，不透传给 ssh：0 会被 ssh 解释成
    // 「随机分配本地端口」，endpoint 却仍写 0——恰好是本入口要消灭的静默
    // 分家；负数/非整数拼出 `127.0.0.1:-5:` 这类畸形转发声明，越界端口
    // bind 必败，都只会在隧道建立那一步才炸。挡在调用点，错误当场出现。
    if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) {
      throw new Error(`本地端口必须是 1-65535 的整数，收到：${requested}`)
    }
    const materialized = await this.materializeAuth(config)
    try {
      return await this.ensureTunnelWithAuth(materialized, remotePort, requested)
    } finally {
      this.cleanupTempKeys()
    }
  }

  /**
   * Start the DSH web process on an already-deployed peer.
   *
   * The same scan + fingerprint gate as `readPeer` runs first and in full —
   * starting something on that machine is a write action, so the host key is
   * re-verified against the approved fingerprint before anything is sent. The
   * script re-uses the deploy's remote environment and start branch; its
   * built-in health loop is advisory only (a stale pid file or a slow daemon
   * can fool it), so the verdict comes from probing the port on the same
   * connection: only liveness `running` reports ok, anything else carries the
   * remote stderr back as the reason.
   */
  async startPeer(config: SshConnectionConfig, port: number): Promise<{ readonly ok: true; readonly port: number } | { readonly ok: false; readonly reason: string }> {
    const fingerprint: string | undefined = config.hostKeyFingerprint
    if (fingerprint === undefined || fingerprint === '' || fingerprint === 'unapproved') {
      throw new Error('hostKeyFingerprint is required')
    }
    const scans = await this.scan(config)
    const scan = scans.find(candidate => candidate.hostKeyFingerprint === config.hostKeyFingerprint)
    if (scan === undefined) throw new Error('SSH host key changed or does not match the approved fingerprint')
    this.persistKnownHost(config, scan.knownHostLine)
    const materialized = await this.materializeAuth(config)
    try {
      const nodePath = await this.discoverRemoteNode(materialized)
      const start = await this.remoteExec(materialized, peerStartScript(this.options.deploymentChannel, nodePath, port), this.options.installTimeoutMs)
      const probe = await this.remoteExec(materialized, buildLivenessProbe(port), this.peerReadBudgetMs())
      if (classifyLiveness({ code: probe.code, stdout: probe.stdout }).liveness !== 'running') {
        const reason = start.stderr.trim() || start.stdout.trim() || `status ${start.code}`
        return { ok: false, reason }
      }
      return { ok: true, port }
    } finally {
      this.cleanupTempKeys()
    }
  }

  /**
   * Reach an already-deployed peer: read its record, plan the honest route
   * (tunnel or direct), and hand back the tokenized URL to open. Refusals
   * throw with the reason and next action; SSH failures pass through raw.
   */
  async connect(config: SshConnectionConfig, remoteWebPort?: number): Promise<SshConnectResult> {
    const peer = await this.readPeer(config)
    const plan = planConnection(peer, remoteWebPort, this.options.defaultRemoteWebPort)
    if (plan.mode === 'direct') {
      return { endpoint: new URL(plan.launchUrl).origin, launchUrl: plan.launchUrl, mode: 'direct', peer }
    }
    const endpoint = await this.ensureTunnel(config, plan.remotePort)
    return { endpoint, launchUrl: composeLaunchUrl(endpoint, plan.launchUrl), mode: 'tunnel', peer }
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

  private async ensureTunnelWithAuth(config: SshConnectionConfig, remotePort: number, requestedLocalPort?: number): Promise<string> {
    const key = alias(config)
    const prior = this.tunnelOps.get(key) ?? Promise.resolve()
    const runTunnel = prior.then(async () => {
      const existing = this.tunnels.get(key)
      // 已有隧道只有在本地端口与本次要求一致时才可复用：调用方指定端口时
      // 端口是承重约束（凭据绑定 authority），复用别的端口等于让 endpoint
      // 对着没人监听的地址。未指定时保持旧行为：有任何活着的隧道就复用。
      if (existing !== undefined
        && (requestedLocalPort === undefined || existing.localPort === requestedLocalPort)
        && (existing.child.exitCode === null || await portListening(existing.localPort))) {
        return `http://127.0.0.1:${existing.localPort}`
      }
      const localPort = requestedLocalPort ?? await freePort()
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

  /**
   * Locate node on the remote with the same candidate list and version gate
   * `deploy` uses, so the start script's PATH and `node_dir` anchor exactly
   * where the original install found them.
   */
  private async discoverRemoteNode(config: SshConnectionConfig): Promise<string> {
    const probe = await this.remoteExec(config, [
      'set -eu',
      'node_path="$(command -v node 2>/dev/null || true)"',
      'if [ -z "$node_path" ] && [ -x /opt/homebrew/bin/node ]; then node_path=/opt/homebrew/bin/node; fi',
      'if [ -z "$node_path" ] && [ -x /usr/local/bin/node ]; then node_path=/usr/local/bin/node; fi',
      'if [ -z "$node_path" ] && [ -x "$HOME/.local/bin/node" ]; then node_path="$HOME/.local/bin/node"; fi',
      'test -n "$node_path"',
      '"$node_path" -e \'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)\'',
      'printf \'%s\\n\' "$node_path"',
    ].join('; '), this.handshakeBudgetMs())
    if (probe.code !== 0) throw new Error('远端需要 Node.js 22 或更高版本才能运行 DSH Web')
    const nodePath = probe.stdout.trim().split(/\r?\n/).at(-1) ?? ''
    if (nodePath === '' || !nodePath.startsWith('/') || /[\r\n\0]/.test(nodePath)) {
      throw new Error('远端返回的 Node 路径无效')
    }
    return nodePath
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

  /** Total budget for one `readPeer` exchange (record + liveness probe). */
  private peerReadBudgetMs(): number {
    return Math.min(this.handshakeBudgetMs(), PEER_READ_BUDGET_MS)
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

/**
 * Probe the ts.net origin from this machine: plain GET for reachability, then
 * the tokenized URL (no redirect following) to confirm the token is accepted.
 */
export async function probeServeHttps(
  origin: string,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<PeerHttpsProbe> {
  const get = async (url: string): Promise<Response> =>
    await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  let base: Response
  try {
    base = await get(`${origin}/`)
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (base.status >= 500) return { reachable: false, status: base.status, error: `HTTP ${base.status}` }
  if (token === undefined) return { reachable: true, status: base.status }
  try {
    const authed = await get(`${origin}/?token=${encodeURIComponent(token)}`)
    return { reachable: true, status: authed.status, authOk: authed.status < 400 }
  } catch (error) {
    return { reachable: true, authOk: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function alias(config: SshConnectionConfig): string {
  return `threadharbor-${createHash('sha256').update(`${config.target}\0${config.port ?? 22}`).digest('hex').slice(0, 24)}`
}

/**
 * Reading a peer must answer within this window no matter how slow the remote
 * is; past it the read reports liveness `unknown` with a timeout note — never
 * `stopped`.
 */
const PEER_READ_BUDGET_MS = 8_000

/** `runWithEnv` signals budget expiry by rejecting with this message shape. */
function readTimedOut(error: unknown): boolean {
  return error instanceof Error && error.message.includes(' timed out after ')
}

function commandExists(name: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' })
  return result.status === 0
}

export function buildInstallScript(input: {
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
    buildRemoteEnv({
      channel, nodePath, remotePort, hostId, hostTitle, remoteAgentsPatch, releaseDir,
      installLines: [
        'if ! command -v dsh >/dev/null 2>&1; then',
        '  if ! command -v npm >/dev/null 2>&1; then echo "npm not found; install Node npm or place dsh on PATH" >&2; exit 1; fi',
        '  npm install -g @deepseek-ai/dsh@">=0.2.0-rc.2 <0.3"',
        'fi',
        installFromGithub ? `plugin_specs=${pluginPayload}` : '',
        installFromGithub
          ? 'printf \'%s\\n\' "$plugin_specs" | while IFS= read -r spec; do [ -z "$spec" ] && continue; dsh plugin --profile web add "$spec" || dsh plugin --profile web add "$spec"; done'
          : 'dsh plugin --profile web add "link:$release" || dsh plugin --profile web add "link:$release"',
      ],
    }),
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
    buildStartBranch({ channel, remotePort }),
  ].filter(line => line !== '').join('\n')
}

/**
 * The standalone start script: the deploy's remote environment and start
 * branch, preceded by a no-op `emit_success` — the start branch calls it when
 * its own health loop answers, but the verdict for a start comes from the
 * liveness probe afterwards, and the peer record already exists from the
 * original deploy, so there is no launch URL to emit and nothing to rewrite.
 * The fragments never define `emit_success` themselves (the install script
 * defines it inline), so the definition must travel with this script.
 */
function peerStartScript(channel: string, nodePath: string, port: number): string {
  return [
    'emit_success() { exit 0; }',
    buildStartScript({
      channel,
      nodePath,
      remotePort: String(port),
      hostId: '',
      hostTitle: '',
      remoteAgentsPatch: buildRemoteAgentsPatchYaml(),
      // The peer's real identity and remote-agent selection were written by
      // the original deploy and are unknowable here; rewriting them would
      // blank the identity the systemd restart then reloads. Leave both
      // profile files exactly as deployed.
      skipProfileWrites: true,
    }),
  ].join('\n')
}
