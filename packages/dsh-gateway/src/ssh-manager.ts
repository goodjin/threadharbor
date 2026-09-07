/** OpenSSH host trust, hostd deployment, and loopback tunnel ownership. */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import {
  type RemoteOperationPhase,
  type RemoteSshConfig,
  type RemoteSshInspection,
} from '@threadharbor/protocol'

/** Administrator-resolved SSH and hostd deployment settings. */
export interface SshManagerOptions {
  readonly knownHostsPath: string
  readonly connectTimeoutMs: number
  readonly installTimeoutMs: number
  readonly hostdRemotePort: number
  readonly deploymentChannel: string
  readonly hostdArtifactDirectory: string
}

/** Safe deployment progress emitted without exposing command output. */
export interface SshDeploymentProgress {
  readonly phase: Extract<RemoteOperationPhase,
    'connecting' | 'preparing' | 'uploading-hostd' | 'starting-hostd' | 'opening-tunnel'>
  readonly detail: string
  readonly current?: number
  readonly total?: number
}

interface ScanResult extends RemoteSshInspection {
  readonly knownHostLine: string
}

interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface OwnedTunnel {
  readonly child: ChildProcess
  readonly localPort: number
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return text(value, name)
}

function sshPort(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) throw new Error('ssh.port must be an integer from 1 to 65535')
  return value as number
}

function parseSsh(value: unknown, requireFingerprint: boolean): RemoteSshConfig {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error('ssh must be an object')
  const record = value as Record<string, unknown>
  const identityFile = optionalText(record['identityFile'], 'ssh.identityFile')
  if (identityFile !== undefined && (!isAbsolute(identityFile) || !existsSync(identityFile))) {
    throw new Error('ssh.identityFile must be an existing absolute path on the Web service')
  }
  const fingerprint = optionalText(record['hostKeyFingerprint'], 'ssh.hostKeyFingerprint')
  if (requireFingerprint && fingerprint === undefined) throw new Error('ssh.hostKeyFingerprint is required')
  const port = sshPort(record['port'])
  const user = optionalText(record['user'], 'ssh.user')
  const proxyJump = optionalText(record['proxyJump'], 'ssh.proxyJump')
  return {
    target: text(record['target'], 'ssh.target'),
    ...(port === undefined ? {} : { port }),
    ...(user === undefined ? {} : { user }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(proxyJump === undefined ? {} : { proxyJump }),
    hostKeyFingerprint: fingerprint ?? 'unapproved',
  }
}

function run(command: string, args: readonly string[], timeoutMs: number, stdin?: string | Buffer): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let stdinError: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-65_536) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-65_536) })
    // A remote command can exit before an upload has finished. Node emits that
    // broken pipe on child.stdin, not on the ChildProcess itself; leaving it
    // unhandled terminates the entire DSH Web process.
    child.stdin.once('error', (error) => { stdinError = error })
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      rejectRun(error)
    }
    child.once('error', (error) => { fail(error) })
    timer = setTimeout(() => {
      child.kill('SIGTERM')
      fail(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('exit', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      if (settled) return
      if ((code ?? 1) === 0 && stdinError !== undefined) {
        fail(stdinError)
        return
      }
      settled = true
      resolveRun({ code: code ?? 1, stdout, stderr })
    })
    try {
      if (stdin !== undefined) child.stdin.end(stdin)
      else child.stdin.end()
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function deploymentChannel(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) {
    throw new Error('deploymentChannel must use 1-32 lowercase letters, digits, or hyphens')
  }
  return value
}

function alias(config: RemoteSshConfig): string {
  return `threadharbor-${createHash('sha256').update(`${config.target}\0${config.port ?? 22}`).digest('hex').slice(0, 24)}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPort(new Error('failed to allocate a loopback port'))
        return
      }
      const port = address.port
      server.close((error) => error === undefined ? resolvePort(port) : rejectPort(error))
    })
  })
}

/** Owns SSH subprocesses for the Web service; browser disconnects do not affect them. */
export class SshManager {
  private readonly tunnels = new Map<string, OwnedTunnel>()

  /** @param options - deployment settings controlled by the DSH profile. */
  constructor(private readonly options: SshManagerOptions) {
    deploymentChannel(options.deploymentChannel)
    mkdirSync(dirname(options.knownHostsPath), { recursive: true, mode: 0o700 })
    if (!existsSync(options.knownHostsPath)) writeFileSync(options.knownHostsPath, '', { mode: 0o600 })
  }

  /** Parse browser SSH fields without trusting a host key.
   * @param value - browser JSON object.
   * @returns validated configuration with an unapproved placeholder fingerprint.
   */
  parseInspectionConfig(value: unknown): RemoteSshConfig {
    return parseSsh(value, false)
  }

  /** Parse SSH fields after explicit fingerprint approval.
   * @param value - browser JSON object.
   * @returns validated approved configuration.
   */
  parseApprovedConfig(value: unknown): RemoteSshConfig {
    return parseSsh(value, true)
  }

  /** Scan and fingerprint the current SSH host key.
   * @param config - target connection fields.
   * @returns algorithm and SHA256 fingerprint for user approval.
   */
  async inspect(config: RemoteSshConfig): Promise<RemoteSshInspection> {
    const [scan] = await this.scan(config)
    if (scan === undefined) throw new Error('unable to scan the SSH host key')
    return { target: scan.target, hostKeyFingerprint: scan.hostKeyFingerprint, algorithm: scan.algorithm }
  }

  /** Verify the approved key, deploy hostd as a user service, and open a tunnel.
   * @param config - approved SSH configuration.
   * @returns local loopback endpoint for the catalog.
   */
  async deploy(config: RemoteSshConfig, onProgress: (progress: SshDeploymentProgress) => void = () => undefined): Promise<string> {
    onProgress({ phase: 'connecting', detail: '正在验证 SSH 主机身份和连接。' })
    const scans = await this.scan(config)
    const scan = scans.find(candidate => candidate.hostKeyFingerprint === config.hostKeyFingerprint)
    if (scan === undefined) throw new Error('SSH host key changed or does not match the approved fingerprint')
    this.persistKnownHost(config, scan.knownHostLine)
    const probe = await run('ssh', [
      ...this.sshArgs(config), this.destination(config),
      [
        'set -eu',
        'node_path="$(command -v node 2>/dev/null || true)"',
        'if [ -z "$node_path" ] && [ -x /opt/homebrew/bin/node ]; then node_path=/opt/homebrew/bin/node; fi',
        'if [ -z "$node_path" ] && [ -x /usr/local/bin/node ]; then node_path=/usr/local/bin/node; fi',
        'if [ -z "$node_path" ] && [ -x "$HOME/.local/bin/node" ]; then node_path="$HOME/.local/bin/node"; fi',
        'test -n "$node_path"',
        '"$node_path" -e \'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)\'',
        'printf \'%s\\n\' "$node_path"',
      ].join('; '),
    ], this.options.connectTimeoutMs)
    if (probe.code === 255) {
      throw new Error(`unable to connect to the remote host with the configured SSH credentials: ${probe.stderr.trim() || 'ssh exited with status 255'}`)
    }
    if (probe.code !== 0) throw new Error('remote host needs Node.js 22 or newer before ThreadHarbor hostd can be deployed')
    const nodePath = probe.stdout.trim().split(/\r?\n/).at(-1)
    if (nodePath === undefined || !nodePath.startsWith('/') || /[\r\n\0]/.test(nodePath)) {
      throw new Error('remote host returned an invalid Node.js executable path')
    }
    const port = String(this.options.hostdRemotePort)
    const channel = this.options.deploymentChannel
    onProgress({ phase: 'preparing', detail: '正在准备远端 ThreadHarbor 目录。' })
    const prepare = await run('ssh', [
      ...this.sshArgs(config), this.destination(config),
      `set -eu; channel=${shellQuote(channel)}; release="$HOME/.local/share/threadharbor/$channel/current"; state="$HOME/.local/state/threadharbor/$channel"; mkdir -p "$release" "$state" "$HOME/.config/systemd/user"`,
    ], this.options.connectTimeoutMs)
    if (prepare.code !== 0) throw new Error('unable to prepare the remote ThreadHarbor user directories')
    const hostdFiles = ['bin.js', 'hold-worker.js'] as const
    for (const [index, file] of hostdFiles.entries()) {
      onProgress({ phase: 'uploading-hostd', detail: `正在上传 hostd 文件 ${index + 1}/${hostdFiles.length}。`, current: index + 1, total: hostdFiles.length })
      const artifact = join(this.options.hostdArtifactDirectory, file)
      if (!existsSync(artifact)) throw new Error(`installed hostd artifact is missing ${file}; rebuild the ThreadHarbor packages`)
      const upload = await run('ssh', [
        ...this.sshArgs(config), this.destination(config),
        `umask 077; release="$HOME/.local/share/threadharbor/${channel}/current"; cat > "$release/${file}"; chmod 700 "$release/${file}"`,
      ], this.options.installTimeoutMs, readFileSync(artifact, 'utf8'))
      if (upload.code !== 0) throw new Error(`unable to upload the hostd ${file} artifact`)
    }
    const script = [
      'set -eu',
      `channel=${shellQuote(channel)}`,
      'release="$HOME/.local/share/threadharbor/$channel/current"',
      'state="$HOME/.local/state/threadharbor/$channel"',
      'bin="$release/bin.js"',
      `node=${shellQuote(nodePath)}`,
      'node_dir="$(dirname "$node")"',
      'common_path="$node_dir:$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"',
      'test -x "$bin" && test -x "$release/hold-worker.js"',
      'envfile="$state/hostd.env"',
      ': > "$envfile"',
      "if command -v zsh >/dev/null 2>&1; then zsh -lic 'export -p' 2>/dev/null | awk '/^export (http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|all_proxy|ALL_PROXY|no_proxy|NO_PROXY|DSH_CORDIS_CONFIG)=/{sub(/^export /,\"\"); gsub(/\\047/,\"\"); print}' >> \"$envfile\" || true; elif command -v bash >/dev/null 2>&1; then bash -lc 'export -p' 2>/dev/null | awk '/^export (http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|all_proxy|ALL_PROXY|no_proxy|NO_PROXY|DSH_CORDIS_CONFIG)=/{sub(/^export /,\"\"); gsub(/\\047/,\"\"); print}' >> \"$envfile\" || true; fi",
      'chmod 600 "$envfile"',
      'service_name="threadharbor-hostd-$channel.service"',
      'service="$HOME/.config/systemd/user/$service_name"',
      'args="--port ' + port + ' --data-dir $state/hostd"',
      "printf '%s\\n' '[Unit]' \"Description=ThreadHarbor host daemon ($channel)\" 'After=network-online.target' '' '[Service]' 'Type=simple' \"EnvironmentFile=-$state/hostd.env\" \"Environment=PATH=$common_path\" \"ExecStart=$node $bin $args\" 'Restart=on-failure' 'RestartSec=2' '' '[Install]' 'WantedBy=default.target' > \"$service\"",
      'if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload && systemctl --user enable --now "$service_name" && systemctl --user restart "$service_name"',
      'else pid_file="$state/hostd.pid"',
      // 1) kill whatever pid the previous run left in $state/hostd.pid (if any)
      'if [ -f "$pid_file" ]; then old_pid="$(cat "$pid_file")"; case "$old_pid" in (*[!0-9]*|"") ;; (*) kill "$old_pid" 2>/dev/null || true ;; esac; fi',
      // 2) on macOS / non-systemd hosts the previous hostd may have been started
      //    outside this script (manual launch, older deploy, lost pid file).
      //    Reclaim the port by killing whatever still listens on it, then wait
      //    up to 5s for the kernel to release it before nohup spawns the new one.
      'if command -v lsof >/dev/null 2>&1; then port_pid="$(lsof -nP -iTCP:' + port + ' -sTCP:LISTEN -t 2>/dev/null | head -n 1 | xargs)"; case "$port_pid" in (*[!0-9]*|"") ;; *) kill "$port_pid" 2>/dev/null || true ;; esac; for _ in 1 2 3 4 5 6 7 8 9 10; do lsof -nP -iTCP:' + port + ' -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done; fi',
      'set -a; [ -f "$envfile" ] && . "$envfile"; set +a',
      'PATH="$common_path" nohup "$node" "$bin" --port ' + port + ' --data-dir "$state/hostd" >>"$state/hostd.log" 2>&1 </dev/null & printf \'%s\\n\' "$!" > "$pid_file"',
      'fi',
    ].join('; ')
    onProgress({ phase: 'starting-hostd', detail: '正在安装并启动远端 hostd 服务。' })
    const deploy = await run('ssh', [...this.sshArgs(config), this.destination(config), script], this.options.installTimeoutMs)
    if (deploy.code !== 0) throw new Error(`hostd deployment failed: ${deploy.stderr.trim() || `status ${deploy.code}`}`)
    onProgress({ phase: 'opening-tunnel', detail: '正在建立本机安全隧道。' })
    const localPort = await freePort()
    await this.startTunnel(config, localPort)
    return `http://127.0.0.1:${localPort}`
  }

  /** Ensure a previously catalogued host still has an owned SSH tunnel.
   * @param config - persisted SSH configuration.
   * @param endpoint - persisted loopback endpoint.
   */
  async ensureTunnel(config: RemoteSshConfig): Promise<string> {
    const existing = this.tunnels.get(alias(config))
    if (existing !== undefined && existing.child.exitCode === null) return `http://127.0.0.1:${existing.localPort}`
    const localPort = await freePort()
    await this.startTunnel(config, localPort)
    return `http://127.0.0.1:${localPort}`
  }

  /** Stop the tunnel owned for one no-longer-catalogued SSH connection. */
  releaseTunnel(config: RemoteSshConfig): void {
    const key = alias(config)
    this.tunnels.get(key)?.child.kill('SIGTERM')
    this.tunnels.delete(key)
  }

  /** Stop gateway-owned tunnels without touching remote hostd or agent workers. */
  close(): void {
    for (const tunnel of this.tunnels.values()) tunnel.child.kill('SIGTERM')
    this.tunnels.clear()
  }

  private async scan(config: RemoteSshConfig): Promise<readonly ScanResult[]> {
    const port = String(config.port ?? 22)
    const scan = await run('ssh-keyscan', ['-T', String(Math.ceil(this.options.connectTimeoutMs / 1000)), '-p', port, config.target], this.options.connectTimeoutMs)
    const lines = scan.stdout.split('\n').filter(candidate => candidate !== '' && !candidate.startsWith('#'))
    if (scan.code !== 0 || lines.length === 0) throw new Error('unable to scan the SSH host key')
    const results: ScanResult[] = []
    for (const line of lines) {
      const fields = line.trim().split(/\s+/)
      const algorithm = fields[1]
      if (algorithm === undefined) continue
      const fingerprint = await run('ssh-keygen', ['-lf', '-', '-E', 'sha256'], this.options.connectTimeoutMs, `${line}\n`)
      const value = fingerprint.stdout.match(/\b(SHA256:[A-Za-z0-9+/=]+)\b/)?.[1]
      if (fingerprint.code === 0 && value !== undefined) {
        results.push({ target: config.target, hostKeyFingerprint: value, algorithm, knownHostLine: line })
      }
    }
    if (results.length === 0) throw new Error('unable to fingerprint the SSH host key')
    return results
  }

  private persistKnownHost(config: RemoteSshConfig, scannedLine: string): void {
    const fields = scannedLine.trim().split(/\s+/)
    const key = fields.slice(1).join(' ')
    const hostAlias = alias(config)
    const entry = `${hostAlias} ${key}`
    const existing = readFileSync(this.options.knownHostsPath, 'utf8').split('\n').filter(line => line !== '' && !line.startsWith(`${hostAlias} `))
    writeFileSync(this.options.knownHostsPath, `${[...existing, entry].join('\n')}\n`, { mode: 0o600 })
  }

  private sshArgs(config: RemoteSshConfig): string[] {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${this.options.knownHostsPath}`,
      '-o', `HostKeyAlias=${alias(config)}`,
      '-o', `ConnectTimeout=${Math.ceil(this.options.connectTimeoutMs / 1000)}`,
      ...(config.port === undefined ? [] : ['-p', String(config.port)]),
      ...(config.identityFile === undefined ? [] : ['-i', config.identityFile, '-o', 'IdentitiesOnly=yes']),
      ...(config.proxyJump === undefined ? [] : ['-J', config.proxyJump]),
    ]
  }

  private destination(config: RemoteSshConfig): string {
    return config.user === undefined ? config.target : `${config.user}@${config.target}`
  }

  private async startTunnel(config: RemoteSshConfig, localPort: number): Promise<void> {
    const key = alias(config)
    const current = this.tunnels.get(key)
    if (current !== undefined && current.child.exitCode === null) current.child.kill('SIGTERM')
    const args = [
      ...this.sshArgs(config), '-N', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.options.hostdRemotePort}`,
      this.destination(config),
    ]
    const tunnel = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.tunnels.set(key, { child: tunnel, localPort })
    await new Promise<void>((resolveTunnel, rejectTunnel) => {
      let error = ''
      tunnel.stderr?.on('data', (chunk: Buffer) => { error = `${error}${chunk.toString('utf8')}`.slice(-4096) })
      const timer = setTimeout(() => resolveTunnel(), 350)
      tunnel.once('error', (cause) => { clearTimeout(timer); rejectTunnel(cause) })
      tunnel.once('exit', (code) => { clearTimeout(timer); rejectTunnel(new Error(`SSH tunnel exited with status ${code ?? 1}: ${error.trim()}`)) })
    })
  }
}
