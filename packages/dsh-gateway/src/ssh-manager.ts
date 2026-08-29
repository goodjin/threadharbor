/** OpenSSH host trust, hostd deployment, and loopback tunnel ownership. */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import {
  type RemoteSshConfig,
  type RemoteSshInspection,
} from '@threadharbor/protocol'

/** Administrator-resolved SSH and hostd deployment settings. */
export interface SshManagerOptions {
  readonly knownHostsPath: string
  readonly connectTimeoutMs: number
  readonly installTimeoutMs: number
  readonly hostdRemotePort: number
  readonly hostdArtifactDirectory: string
}

interface ScanResult extends RemoteSshInspection {
  readonly knownHostLine: string
}

interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
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

function run(command: string, args: readonly string[], timeoutMs: number, stdin?: string): Promise<RunResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-65_536) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-65_536) })
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      rejectRun(error)
    }
    child.once('error', (error) => { fail(error) })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      fail(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolveRun({ code: code ?? 1, stdout, stderr })
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

function alias(config: RemoteSshConfig): string {
  return `threadharbor-${createHash('sha256').update(`${config.target}\0${config.port ?? 22}`).digest('hex').slice(0, 24)}`
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
  private readonly tunnels = new Map<string, ChildProcess>()

  /** @param options - deployment settings controlled by the DSH profile. */
  constructor(private readonly options: SshManagerOptions) {
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
    const scan = await this.scan(config)
    return { target: scan.target, hostKeyFingerprint: scan.hostKeyFingerprint, algorithm: scan.algorithm }
  }

  /** Verify the approved key, deploy hostd as a user service, and open a tunnel.
   * @param config - approved SSH configuration.
   * @returns local loopback endpoint for the catalog.
   */
  async deploy(config: RemoteSshConfig): Promise<string> {
    const scan = await this.scan(config)
    if (scan.hostKeyFingerprint !== config.hostKeyFingerprint) throw new Error('SSH host key changed or does not match the approved fingerprint')
    this.persistKnownHost(config, scan.knownHostLine)
    const probe = await run('ssh', [
      ...this.sshArgs(config), this.destination(config),
      "node -e 'const major=Number(process.versions.node.split(\".\")[0]); process.exit(major >= 22 ? 0 : 1)'",
    ], this.options.connectTimeoutMs)
    if (probe.code !== 0) throw new Error('remote host needs Node.js 22 or newer before ThreadHarbor hostd can be deployed')
    const port = String(this.options.hostdRemotePort)
    const prepare = await run('ssh', [
      ...this.sshArgs(config), this.destination(config),
      'set -eu; mkdir -p "$HOME/.local/share/threadharbor/current" "$HOME/.config/systemd/user" "$HOME/.local/state/threadharbor"',
    ], this.options.connectTimeoutMs)
    if (prepare.code !== 0) throw new Error('unable to prepare the remote ThreadHarbor user directories')
    for (const file of ['bin.js', 'hold-worker.js'] as const) {
      const artifact = join(this.options.hostdArtifactDirectory, file)
      if (!existsSync(artifact)) throw new Error(`installed hostd artifact is missing ${file}; rebuild the ThreadHarbor packages`)
      const upload = await run('ssh', [
        ...this.sshArgs(config), this.destination(config),
        `umask 077; cat > "$HOME/.local/share/threadharbor/current/${file}"; chmod 700 "$HOME/.local/share/threadharbor/current/${file}"`,
      ], this.options.installTimeoutMs, readFileSync(artifact, 'utf8'))
      if (upload.code !== 0) throw new Error(`unable to upload the hostd ${file} artifact`)
    }
    const script = [
      'set -eu',
      'release="$HOME/.local/share/threadharbor/current"',
      'bin="$release/bin.js"',
      'test -x "$bin" && test -x "$release/hold-worker.js"',
      'service="$HOME/.config/systemd/user/threadharbor-hostd.service"',
      "printf '%s\\n' '[Unit]' 'Description=ThreadHarbor host daemon' 'After=network-online.target' '' '[Service]' 'Type=simple' \"ExecStart=/usr/bin/env node $bin --port " + port + "\" 'Restart=on-failure' 'RestartSec=2' '' '[Install]' 'WantedBy=default.target' > \"$service\"",
      'if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload && systemctl --user enable --now threadharbor-hostd.service; else nohup node "$bin" --port ' + port + ' >>"$HOME/.local/state/threadharbor/hostd.log" 2>&1 </dev/null & fi',
    ].join('; ')
    const deploy = await run('ssh', [...this.sshArgs(config), this.destination(config), script], this.options.installTimeoutMs)
    if (deploy.code !== 0) throw new Error(`hostd deployment failed: ${deploy.stderr.trim() || `status ${deploy.code}`}`)
    const localPort = await freePort()
    await this.startTunnel(config, localPort)
    return `http://127.0.0.1:${localPort}`
  }

  /** Ensure a previously catalogued host still has an owned SSH tunnel.
   * @param config - persisted SSH configuration.
   * @param endpoint - persisted loopback endpoint.
   */
  async ensureTunnel(config: RemoteSshConfig, endpoint: string): Promise<void> {
    const port = Number(new URL(endpoint).port)
    if (!Number.isSafeInteger(port) || port < 1) throw new Error('invalid catalogued SSH tunnel endpoint')
    const existing = this.tunnels.get(alias(config))
    if (existing !== undefined && existing.exitCode === null) return
    await this.startTunnel(config, port)
  }

  /** Stop gateway-owned tunnels without touching remote hostd or agent workers. */
  close(): void {
    for (const tunnel of this.tunnels.values()) tunnel.kill('SIGTERM')
    this.tunnels.clear()
  }

  private async scan(config: RemoteSshConfig): Promise<ScanResult> {
    const port = String(config.port ?? 22)
    const scan = await run('ssh-keyscan', ['-T', String(Math.ceil(this.options.connectTimeoutMs / 1000)), '-p', port, config.target], this.options.connectTimeoutMs)
    const line = scan.stdout.split('\n').find(candidate => candidate !== '' && !candidate.startsWith('#'))
    if (scan.code !== 0 || line === undefined) throw new Error('unable to scan the SSH host key')
    const fields = line.trim().split(/\s+/)
    const algorithm = fields[1]
    if (algorithm === undefined) throw new Error('ssh-keyscan returned an invalid key')
    const fingerprint = await run('ssh-keygen', ['-lf', '-', '-E', 'sha256'], this.options.connectTimeoutMs, `${line}\n`)
    const value = fingerprint.stdout.match(/\b(SHA256:[A-Za-z0-9+/=]+)\b/)?.[1]
    if (fingerprint.code !== 0 || value === undefined) throw new Error('unable to fingerprint the SSH host key')
    return { target: config.target, hostKeyFingerprint: value, algorithm, knownHostLine: line }
  }

  private persistKnownHost(config: RemoteSshConfig, scannedLine: string): void {
    const fields = scannedLine.trim().split(/\s+/)
    const key = fields.slice(1).join(' ')
    const entry = `${alias(config)} ${key}`
    const existing = readFileSync(this.options.knownHostsPath, 'utf8').split('\n').filter(line => line !== '' && !line.startsWith(`${alias(config)} `))
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
    if (current !== undefined && current.exitCode === null) current.kill('SIGTERM')
    const args = [
      ...this.sshArgs(config), '-N', '-o', 'ExitOnForwardFailure=yes',
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.options.hostdRemotePort}`,
      this.destination(config),
    ]
    const tunnel = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.tunnels.set(key, tunnel)
    await new Promise<void>((resolveTunnel, rejectTunnel) => {
      let error = ''
      tunnel.stderr?.on('data', (chunk: Buffer) => { error = `${error}${chunk.toString('utf8')}`.slice(-4096) })
      const timer = setTimeout(() => resolveTunnel(), 350)
      tunnel.once('error', (cause) => { clearTimeout(timer); rejectTunnel(cause) })
      tunnel.once('exit', (code) => { clearTimeout(timer); rejectTunnel(new Error(`SSH tunnel exited with status ${code ?? 1}: ${error.trim()}`)) })
    })
  }
}
