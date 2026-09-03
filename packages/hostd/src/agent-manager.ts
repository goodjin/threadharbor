/** Agent discovery, inventory, configuration, and detached authentication workers. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import {
  RemoteAuthFlowId,
  type RemoteAgentConfigBackend,
  type RemoteAgentConfigDocument,
  type RemoteAuthChallenge,
  type RemoteAgentBackend,
  type RemoteBackendInventory,
} from '@threadharbor/protocol'
import { AgentConfigManager } from './agent-config.ts'

/** Resolved commands and bounded operation timings for agent management. */
export interface AgentManagerOptions {
  readonly authTimeoutMs: number
  readonly agentConfigHome: string
  readonly maxAgentConfigBytes: number
  readonly codexCliCommand: string
  readonly codexAcpCommand: string
  readonly claudeCommand: string
  readonly claudeAcpCommand: string
  readonly grokCommand: string
  readonly dshCommand: string
}

interface AuthFlow {
  challenge: RemoteAuthChallenge
  readonly child: ChildProcessWithoutNullStreams
  readonly timer: ReturnType<typeof setTimeout>
  readonly linkHintTimer: ReturnType<typeof setTimeout>
  output: string
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8')
  return String(chunk)
}

function commandExists(command: string): boolean {
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      try {
        accessSync(join(directory, `${command}${extension}`), constants.X_OK)
        return true
      } catch {
        // Try the next PATH candidate.
      }
    }
  }
  return false
}

async function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly code: number; readonly output: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    let output = ''
    const append = (chunk: unknown): void => {
      output = `${output}${chunkText(chunk)}`.slice(-16_384)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
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
      resolveRun({ code: code ?? 1, output })
    })
  })
}

function childEnv(): NodeJS.ProcessEnv {
  const nodeDir = dirname(process.execPath)
  const path = process.env['PATH'] ?? ''
  return { ...process.env, PATH: path === '' ? nodeDir : `${nodeDir}${delimiter}${path}` }
}

function safeUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/[^\s<>"']+/)
  if (match === null) return undefined
  try {
    const url = new URL(match[0])
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function deviceCode(text: string): string | undefined {
  const patterns = [
    /(?:code|confirmation code|确认码)\s*[:：]?\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})?)/i,
    /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/,
  ]
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]
    if (value !== undefined) return value
  }
  return undefined
}

/** Discovers administrator-installed Agents and owns authentication subprocesses. */
export class AgentManager {
  private readonly flows = new Map<string, AuthFlow>()
  private readonly configs: AgentConfigManager

  /** @param options - administrator-resolved commands and timings. */
  constructor(private readonly options: AgentManagerOptions) {
    this.configs = new AgentConfigManager({
      homeDir: options.agentConfigHome,
      maxBytes: options.maxAgentConfigBytes,
    })
  }

  /** Detect all supported agents and authentication state.
   * @param running - agents with a live native session transport.
   * @returns the current inventory.
   */
  async inventory(running: ReadonlySet<RemoteAgentBackend>): Promise<readonly RemoteBackendInventory[]> {
    const codexInstalled = commandExists(this.options.codexCliCommand) && commandExists(this.options.codexAcpCommand)
    const grokInstalled = commandExists(this.options.grokCommand)
    const claudeAcpInstalled = commandExists(this.options.claudeAcpCommand)
    const claudeInstalled = commandExists(this.options.claudeCommand) && claudeAcpInstalled
    const dshInstalled = commandExists(this.options.dshCommand)
    const [codexAuth, grokAuth] = await Promise.all([
      codexInstalled ? this.check(this.options.codexCliCommand, ['login', 'status']) : Promise.resolve(false),
      grokInstalled ? this.check(this.options.grokCommand, ['models']) : Promise.resolve(false),
    ])
    return [
      { backend: 'grok', installed: grokInstalled, authenticated: grokAuth, running: running.has('grok'), sessionCapable: true },
      { backend: 'codex', installed: codexInstalled, authenticated: codexAuth, running: running.has('codex'), sessionCapable: true },
      {
        backend: 'claude', installed: claudeInstalled, authenticated: claudeInstalled,
        running: running.has('claude'), sessionCapable: claudeAcpInstalled,
        ...(!claudeAcpInstalled && commandExists(this.options.claudeCommand)
          ? { detail: 'Claude Code is installed but claude-agent-acp is missing.' } : {}),
      },
      {
        backend: 'dsh', installed: dshInstalled,
        authenticated: dshInstalled && this.dshApiKey() !== undefined,
        running: running.has('dsh'), sessionCapable: true,
      },
    ]
  }

  /** Read one fixed-path Agent user configuration document.
   * @param backend - backend with a configuration adapter.
   * @returns current validated configuration content and revision.
   */
  readConfig(backend: RemoteAgentConfigBackend): RemoteAgentConfigDocument {
    return this.configs.read(backend)
  }

  /** Validate and save one fixed-path Agent user configuration document.
   * @param backend - backend with a configuration adapter.
   * @param content - complete JSON or TOML document.
   * @param expectedRevision - revision returned when the document was opened.
   * @returns the saved document.
   */
  writeConfig(
    backend: RemoteAgentConfigBackend,
    content: string,
    expectedRevision: string,
  ): RemoteAgentConfigDocument {
    return this.configs.write(backend, content, expectedRevision)
  }

  /** Start a detached browser/device authorization flow.
   * @param backend - agent to authenticate.
   * @returns browser-safe challenge metadata.
   */
  startAuth(backend: RemoteAgentBackend): RemoteAuthChallenge {
    const [command, args] = this.authCommand(backend)
    if (!commandExists(command)) throw new Error(`${backend} is not installed`)
    const flowId = RemoteAuthFlowId(randomUUID())
    const expiresAt = new Date(Date.now() + this.options.authTimeoutMs).toISOString()
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
    const challenge: RemoteAuthChallenge = {
      flowId, backend, status: 'starting', message: 'Waiting for the agent to provide an authorization link.', expiresAt,
    }
    const timer = setTimeout(() => {
      const flow = this.flows.get(flowId)
      if (flow === undefined) return
      clearTimeout(flow.linkHintTimer)
      flow.challenge = { ...flow.challenge, status: 'expired', message: 'Authorization expired. Start a new login.' }
      flow.child.kill('SIGTERM')
    }, this.options.authTimeoutMs)
    const linkHintTimer = setTimeout(() => {
      const current = this.flows.get(flowId)
      if (current === undefined || current.challenge.status !== 'starting') return
      current.challenge = {
        ...current.challenge,
        message: '仍在等待授权链接。Grok/Codex 需要访问 auth.x.ai；若这台主机上网需要代理，请确认 hostd 已继承 https_proxy 后重试。',
      }
    }, 8_000)
    const flow: AuthFlow = { challenge, child, timer, linkHintTimer, output: '' }
    this.flows.set(flowId, flow)
    const append = (chunk: unknown): void => this.acceptAuthOutput(flowId, chunkText(chunk))
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', () => {
      const current = this.flows.get(flowId)
      if (current === undefined) return
      clearTimeout(current.timer)
      clearTimeout(current.linkHintTimer)
      current.challenge = { ...current.challenge, status: 'failed', message: 'Unable to start the authentication command.' }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      clearTimeout(linkHintTimer)
      const current = this.flows.get(flowId)
      if (current === undefined || current.challenge.status === 'cancelled' || current.challenge.status === 'expired') return
      current.challenge = code === 0
        ? { ...current.challenge, status: 'succeeded', message: 'Authentication completed on the remote host.' }
        : { ...current.challenge, status: 'failed', message: `Authentication command exited with status ${code ?? 1}.` }
    })
    return challenge
  }

  /** Return current metadata for one flow.
   * @param flowId - hostd-owned flow id.
   * @returns current browser-safe challenge.
   */
  authStatus(flowId: string): RemoteAuthChallenge {
    const flow = this.flows.get(flowId)
    if (flow === undefined) throw new Error('authentication flow not found')
    return flow.challenge
  }

  /** Supply a one-time response requested by a CLI such as Claude Code.
   * @param flowId - hostd-owned flow id.
   * @param response - single-line authorization response.
   */
  respondAuth(flowId: string, response: string): void {
    const flow = this.flows.get(flowId)
    if (flow === undefined) throw new Error('authentication flow not found')
    if (!['starting', 'waiting-user'].includes(flow.challenge.status)) throw new Error('authentication flow is not waiting for input')
    if (response.length < 1 || response.length > 2048 || /[\r\n]/.test(response)) throw new Error('authentication response must be one bounded line')
    flow.child.stdin.write(`${response}\n`)
  }

  /** Cancel an authentication process without affecting agent sessions.
   * @param flowId - hostd-owned flow id.
   */
  cancelAuth(flowId: string): void {
    const flow = this.flows.get(flowId)
    if (flow === undefined) throw new Error('authentication flow not found')
    clearTimeout(flow.timer)
    clearTimeout(flow.linkHintTimer)
    flow.challenge = { ...flow.challenge, status: 'cancelled', message: 'Authentication was cancelled.' }
    flow.child.kill('SIGTERM')
  }

  /** Path of the owner-only DSH API key file. */
  dshCredentialPath(): string {
    return join(this.options.agentConfigHome, 'threadharbor', 'dsh-api-key')
  }

  /** Return the configured DSH API key from the environment or the private file. */
  dshApiKey(): string | undefined {
    const fromEnv = process.env['DEEPSEEK_API_KEY']
    if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
    const path = this.dshCredentialPath()
    if (!existsSync(path)) return undefined
    const value = readFileSync(path, 'utf8').trim()
    return value === '' ? undefined : value
  }

  /** Report whether a DSH API key is configured without returning the secret. */
  dshCredentialStatus(): { readonly configured: boolean } {
    return { configured: this.dshApiKey() !== undefined }
  }

  /** Persist a DSH API key with owner-only permissions. Never read back into responses. */
  setDshApiKey(apiKey: string): { readonly configured: true } {
    const value = apiKey.trim()
    if (value === '') throw new Error('apiKey must be a non-empty string')
    const path = this.dshCredentialPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${value}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    return { configured: true }
  }

  private async check(command: string, args: readonly string[]): Promise<boolean> {
    try {
      return (await run(command, args, 10_000)).code === 0
    } catch {
      return false
    }
  }

  private authCommand(backend: RemoteAgentBackend): readonly [string, readonly string[]] {
    switch (backend) {
      case 'codex': return [this.options.codexCliCommand, ['login', '--device-auth']]
      case 'grok': return [this.options.grokCommand, ['login', '--device-auth']]
      case 'claude': return [this.options.claudeCommand, ['auth', 'login']]
      case 'dsh': throw new Error('DeepSeek Harness uses configured credentials and has no interactive login adapter')
    }
  }

  private acceptAuthOutput(flowId: string, chunk: string): void {
    const flow = this.flows.get(flowId)
    if (flow === undefined) return
    flow.output = `${flow.output}${chunk}`.slice(-16_384)
    const text = flow.output.replaceAll(/\x1b\[[0-9;]*m/g, '')
    const verificationUri = safeUrl(text)
    const userCode = deviceCode(text)
    if (verificationUri === undefined && userCode === undefined) return
    clearTimeout(flow.linkHintTimer)
    flow.challenge = {
      ...flow.challenge,
      status: 'waiting-user',
      message: userCode === undefined
        ? 'Open the authorization link. If the CLI asks for a returned code, paste it below.'
        : 'Open the authorization link and enter the displayed one-time code.',
      ...(verificationUri === undefined ? {} : { verificationUri }),
      ...(userCode === undefined ? {} : { userCode }),
    }
  }
}
