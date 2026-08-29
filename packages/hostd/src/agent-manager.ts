/** Agent installation, inventory, and detached authentication workers. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  RemoteAuthFlowId,
  type JsonValue,
  type RemoteAgentConfigBackend,
  type RemoteAgentConfigDocument,
  type RemoteAuthChallenge,
  type RemoteAgentBackend,
  type RemoteBackendInventory,
  type RemoteInstallPlan,
} from '@threadharbor/protocol'
import { AgentConfigManager } from './agent-config.ts'

const CODEX_PACKAGES = ['@openai/codex@latest', '@agentclientprotocol/codex-acp@latest'] as const
const GROK_PACKAGES = ['@xai-official/grok@latest'] as const
const CLAUDE_PACKAGES = ['@anthropic-ai/claude-code@latest'] as const

/** Resolved commands and bounded operation timings for agent management. */
export interface AgentManagerOptions {
  readonly installPrefix: string
  readonly installTimeoutMs: number
  readonly authTimeoutMs: number
  readonly agentConfigHome: string
  readonly maxAgentConfigBytes: number
  readonly codexCliCommand: string
  readonly codexAcpCommand: string
  readonly claudeCommand: string
  readonly grokCommand: string
  readonly dshCommand: string
}

interface AuthFlow {
  challenge: RemoteAuthChallenge
  readonly child: ChildProcessWithoutNullStreams
  readonly timer: ReturnType<typeof setTimeout>
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
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
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

function planStep(title: string, command: string): { readonly title: string; readonly command: string } {
  return { title, command }
}

function quoteDisplay(value: string): string {
  return /^[a-zA-Z0-9_@./:+~-]+$/.test(value) ? value : JSON.stringify(value)
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

/** Owns safe, predeclared installers and authentication subprocesses. */
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
    const claudeInstalled = commandExists(this.options.claudeCommand)
    const dshInstalled = commandExists(this.options.dshCommand)
    const [codexAuth, grokAuth, claudeAuth] = await Promise.all([
      codexInstalled ? this.check(this.options.codexCliCommand, ['login', 'status']) : Promise.resolve(false),
      grokInstalled ? this.check(this.options.grokCommand, ['models']) : Promise.resolve(false),
      claudeInstalled ? this.check(this.options.claudeCommand, ['auth', 'status', '--json']) : Promise.resolve(false),
    ])
    return [
      { backend: 'grok', installed: grokInstalled, authenticated: grokAuth, running: running.has('grok'), sessionCapable: true },
      { backend: 'codex', installed: codexInstalled, authenticated: codexAuth, running: running.has('codex'), sessionCapable: true },
      {
        backend: 'claude', installed: claudeInstalled, authenticated: claudeAuth,
        running: false, sessionCapable: false,
        detail: 'Claude Code installation and login are supported; a native session adapter is not configured yet.',
      },
      {
        backend: 'dsh', installed: dshInstalled,
        authenticated: dshInstalled && (process.env['DEEPSEEK_API_KEY'] ?? '') !== '',
        running: running.has('dsh'), sessionCapable: true,
      },
    ]
  }

  /** Return the exact administrator-owned install recipe before mutation.
   * @param backend - requested agent.
   * @returns a reviewable plan.
   */
  installPlan(backend: RemoteAgentBackend): RemoteInstallPlan {
    const npm = 'npm'
    switch (backend) {
      case 'codex': {
        const packages = CODEX_PACKAGES
        return {
          component: backend,
          version: packages.join(' + '),
          alreadyInstalled: commandExists(this.options.codexCliCommand) && commandExists(this.options.codexAcpCommand),
          requiresConfirmation: true,
          steps: [planStep('Install Codex CLI and its ACP adapter into the user prefix',
            [npm, 'install', '--global', '--prefix', this.options.installPrefix, ...packages].map(quoteDisplay).join(' '))],
        }
      }
      case 'claude':
        return {
          component: backend,
          version: CLAUDE_PACKAGES.join(' + '),
          alreadyInstalled: commandExists(this.options.claudeCommand),
          requiresConfirmation: true,
          steps: [planStep('Install Claude Code into the user prefix',
            [npm, 'install', '--global', '--prefix', this.options.installPrefix, ...CLAUDE_PACKAGES].map(quoteDisplay).join(' '))],
        }
      case 'grok':
        return {
          component: backend,
          version: GROK_PACKAGES.join(' + '),
          alreadyInstalled: commandExists(this.options.grokCommand),
          requiresConfirmation: true,
          steps: [planStep('Install the official Grok Build CLI into the user prefix',
            [npm, 'install', '--global', '--prefix', this.options.installPrefix, ...GROK_PACKAGES].map(quoteDisplay).join(' '))],
        }
      case 'dsh':
        return {
          component: backend,
          version: 'managed by the DeepSeek Harness installation',
          alreadyInstalled: commandExists(this.options.dshCommand),
          requiresConfirmation: true,
          steps: [],
          unavailableReason: 'Install or update DeepSeek Harness from its own distribution.',
        }
    }
  }

  /** Execute a previously reviewable built-in recipe.
   * @param backend - requested agent.
   * @returns the completed plan.
   */
  async install(backend: RemoteAgentBackend): Promise<RemoteInstallPlan> {
    const plan = this.installPlan(backend)
    if (plan.unavailableReason !== undefined) throw new Error(plan.unavailableReason)
    if (plan.alreadyInstalled) return plan
    const packages = backend === 'codex'
      ? CODEX_PACKAGES
      : backend === 'grok'
        ? GROK_PACKAGES
        : backend === 'claude'
          ? CLAUDE_PACKAGES
          : undefined
    const recipe = packages === undefined
      ? undefined
      : ['npm', 'install', '--global', '--prefix', this.options.installPrefix, ...packages] as const
    if (recipe === undefined) throw new Error('no installer is configured')
    const [command, ...args] = recipe
    const result = await run(command, args, this.options.installTimeoutMs)
    if (result.code !== 0) throw new Error(`installer exited with status ${result.code}`)
    return this.installPlan(backend)
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
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const challenge: RemoteAuthChallenge = {
      flowId, backend, status: 'starting', message: 'Waiting for the agent to provide an authorization link.', expiresAt,
    }
    const timer = setTimeout(() => {
      const flow = this.flows.get(flowId)
      if (flow === undefined) return
      flow.challenge = { ...flow.challenge, status: 'expired', message: 'Authorization expired. Start a new login.' }
      flow.child.kill('SIGTERM')
    }, this.options.authTimeoutMs)
    const flow: AuthFlow = { challenge, child, timer, output: '' }
    this.flows.set(flowId, flow)
    const append = (chunk: unknown): void => this.acceptAuthOutput(flowId, chunkText(chunk))
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', () => {
      const current = this.flows.get(flowId)
      if (current !== undefined) current.challenge = { ...current.challenge, status: 'failed', message: 'Unable to start the authentication command.' }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
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
    flow.challenge = { ...flow.challenge, status: 'cancelled', message: 'Authentication was cancelled.' }
    flow.child.kill('SIGTERM')
  }

  private async check(command: string, args: readonly string[]): Promise<boolean> {
    try {
      return (await run(command, args, Math.min(this.options.installTimeoutMs, 10_000))).code === 0
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
    const verificationUri = safeUrl(flow.output)
    const userCode = deviceCode(flow.output)
    if (verificationUri === undefined && userCode === undefined) return
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

/** Require a boolean confirmation at a wire boundary.
 * @param value - JSON request field.
 */
export function requireInstallConfirmation(value: JsonValue | undefined): void {
  if (value !== true) throw new Error('installation requires confirm: true')
}
