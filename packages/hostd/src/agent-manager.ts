/** Agent discovery, inventory, configuration, and detached authentication workers. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
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

/** Resolved commands and bounded operation timings for agent management. */
export interface AgentManagerOptions {
  readonly installTimeoutMs: number
  readonly authTimeoutMs: number
  readonly agentConfigHome: string
  readonly maxAgentConfigBytes: number
  readonly codexCliCommand: string
  readonly codexAcpCommand: string
  readonly claudeCommand: string
  readonly claudeAcpCommand: string
  readonly grokCommand: string
  readonly dshCommand: string
  /** Test seam; production resolves npm next to the hostd Node executable. */
  readonly npmCommand?: readonly [command: string, ...args: string[]]
  /** Test seam; production uses python3, then python. */
  readonly pythonCommand?: string
}

const CODEX_PACKAGES = ['@openai/codex@0.150.1', '@agentclientprotocol/codex-acp@1.6.2'] as const
const GROK_PACKAGES = ['@xai-official/grok@1.0.5'] as const
const CLAUDE_PACKAGES = ['@anthropic-ai/claude-code@2.1.251', '@agentclientprotocol/claude-agent-acp@0.69.0'] as const
const DSH_PIP_SPEC = 'deepseek-harness-runtime-bin==0.1.1rc1'
/** Homebrew/PEP 668 blocks bare `pip install --user`; `--break-system-packages` still writes the user scripts dir. */
const DSH_PIP_ARGS = ['-m', 'pip', 'install', '--user', '--upgrade', '--break-system-packages', DSH_PIP_SPEC] as const
/** Official locator: the wheel ships `dsh-jsonrpc-agent-pkg-<platform>-<arch>`, not a PATH entry. */
const DSH_RESOLVE_SCRIPT = 'from deepseek_harness_runtime import bundled_runtime_path, bundled_default_config_path; print(bundled_runtime_path()); print(bundled_default_config_path())'

interface DshLaunch {
  readonly command: string
  readonly configPath?: string
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

function resolveCommandPath(command: string, extraBins: readonly string[] = []): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command, constants.X_OK)
      return command
    } catch {
      return undefined
    }
  }
  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  const directories = [...extraBins, dirname(process.execPath), ...(process.env['PATH'] ?? '').split(delimiter)]
  for (const directory of directories) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Try the next PATH candidate.
      }
    }
  }
  return undefined
}

function commandExists(command: string, extraBins: readonly string[] = []): boolean {
  return resolveCommandPath(command, extraBins) !== undefined
}

function quoteDisplay(value: string): string {
  if (/^[A-Za-z0-9_@./:=+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function planStep(title: string, command: string): { readonly title: string; readonly command: string } {
  return { title, command }
}

function resolveNpm(): { readonly command: string; readonly args: readonly string[] } {
  const npm = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  if (commandExists(npm)) {
    return process.platform === 'win32'
      ? { command: npm, args: [] }
      : { command: process.execPath, args: [npm] }
  }
  return { command: 'npm', args: [] }
}

function resolvePython(): string | undefined {
  if (commandExists('python3')) return 'python3'
  if (commandExists('python')) return 'python'
  return undefined
}

function npmPackages(backend: RemoteAgentBackend): readonly string[] | undefined {
  if (backend === 'codex') return CODEX_PACKAGES
  if (backend === 'grok') return GROK_PACKAGES
  if (backend === 'claude') return CLAUDE_PACKAGES
  return undefined
}

async function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  extraBins: readonly string[] = [],
): Promise<{ readonly code: number; readonly output: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(extraBins) })
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

function childEnv(extraBins: readonly string[] = []): NodeJS.ProcessEnv {
  const prefix = [...extraBins, dirname(process.execPath)].filter(directory => directory !== '').join(delimiter)
  const path = process.env['PATH'] ?? ''
  return { ...process.env, PATH: path === '' ? prefix : `${prefix}${delimiter}${path}` }
}

function envNonEmpty(name: string): boolean {
  const value = process.env[name]
  return value !== undefined && value.trim() !== ''
}

function environmentRoot(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? fallback : resolve(value)
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** True when Codex has a ChatGPT session or API key on this host. Never launches the CLI. */
function hasCodexCredentials(homeDir: string): boolean {
  if (envNonEmpty('CODEX_API_KEY') || envNonEmpty('OPENAI_API_KEY')) return true
  const auth = readJsonObject(join(environmentRoot('CODEX_HOME', join(homeDir, '.codex')), 'auth.json'))
  if (auth === undefined) return false
  if (nonEmptyString(auth['OPENAI_API_KEY'])) return true
  const tokens = auth['tokens']
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return false
  const record = tokens as Record<string, unknown>
  return nonEmptyString(record['access_token']) || nonEmptyString(record['refresh_token'])
}

/** True when Grok has a device/OIDC session on this host. Never launches the CLI. */
function hasGrokCredentials(homeDir: string): boolean {
  const auth = readJsonObject(join(environmentRoot('GROK_HOME', join(homeDir, '.grok')), 'auth.json'))
  if (auth === undefined) return false
  return Object.values(auth).some((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
    const record = entry as Record<string, unknown>
    return nonEmptyString(record['refresh_token']) || nonEmptyString(record['key'])
  })
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
  private extraBinDirs: readonly string[] = []
  private dshLaunch: DshLaunch | undefined

  /** @param options - administrator-resolved commands and timings. */
  constructor(private readonly options: AgentManagerOptions) {
    this.configs = new AgentConfigManager({
      homeDir: options.agentConfigHome,
      maxBytes: options.maxAgentConfigBytes,
    })
  }

  private hasCommand(command: string): boolean {
    return commandExists(command, this.extraBinDirs)
  }

  /** Detect all supported agents and authentication state.
   * @param running - agents with a live native session transport.
   * @returns the current inventory.
   */
  async inventory(running: ReadonlySet<RemoteAgentBackend>): Promise<readonly RemoteBackendInventory[]> {
    await this.refreshExtraBins()
    await this.refreshDshLaunch()
    const codexInstalled = this.hasCommand(this.options.codexCliCommand) && this.hasCommand(this.options.codexAcpCommand)
    const grokInstalled = this.hasCommand(this.options.grokCommand)
    const claudeAcpInstalled = this.hasCommand(this.options.claudeAcpCommand)
    const claudeInstalled = this.hasCommand(this.options.claudeCommand) && claudeAcpInstalled
    const dshInstalled = this.dshInstalled()
    return [
      {
        backend: 'grok', installed: grokInstalled,
        authenticated: grokInstalled && hasGrokCredentials(this.options.agentConfigHome),
        running: running.has('grok'), sessionCapable: true,
      },
      {
        backend: 'codex', installed: codexInstalled,
        authenticated: codexInstalled && hasCodexCredentials(this.options.agentConfigHome),
        running: running.has('codex'), sessionCapable: true,
      },
      {
        backend: 'claude', installed: claudeInstalled, authenticated: claudeInstalled,
        running: running.has('claude'), sessionCapable: claudeAcpInstalled,
        ...(!claudeAcpInstalled && this.hasCommand(this.options.claudeCommand)
          ? { detail: 'Claude Code is installed but claude-agent-acp is missing.' } : {}),
      },
      {
        backend: 'dsh', installed: dshInstalled,
        authenticated: dshInstalled && this.dshApiKey() !== undefined,
        running: running.has('dsh'), sessionCapable: true,
      },
    ]
  }

  /** Return the exact host-owned install recipe before mutation.
   * @param backend - requested agent.
   * @returns a reviewable plan.
   */
  installPlan(backend: RemoteAgentBackend): RemoteInstallPlan {
    const alreadyInstalled = this.backendInstalled(backend)
    if (backend === 'dsh') {
      const python = this.options.pythonCommand ?? resolvePython()
      if (python === undefined) {
        return {
          component: backend,
          version: DSH_PIP_SPEC,
          alreadyInstalled,
          requiresConfirmation: true,
          steps: [],
          unavailableReason: 'This host needs python3 to install DeepSeek Harness JSON-RPC runtime from PyPI.',
        }
      }
      return {
        component: backend,
        version: DSH_PIP_SPEC,
        alreadyInstalled,
        requiresConfirmation: true,
        steps: [planStep(
          'Install the official DeepSeek Harness JSON-RPC runtime from PyPI',
          [python, ...DSH_PIP_ARGS].map(quoteDisplay).join(' '),
        )],
      }
    }
    const packages = npmPackages(backend)
    const npm = this.npmInstaller()
    if (packages === undefined) {
      return {
        component: backend,
        version: backend,
        alreadyInstalled,
        requiresConfirmation: true,
        steps: [],
        unavailableReason: 'no installer is configured',
      }
    }
    const title = backend === 'codex'
      ? 'Install Codex CLI and its ACP adapter from npm'
      : backend === 'claude'
        ? 'Install Claude Code and its ACP adapter from npm'
        : 'Install the official Grok Build CLI from npm'
    return {
      component: backend,
      version: packages.join(' + '),
      alreadyInstalled,
      requiresConfirmation: true,
      steps: [planStep(title, ['npm', 'install', '-g', ...packages].map(quoteDisplay).join(' '))],
    }
  }

  /** Execute a previously reviewable built-in recipe on this host.
   * @param backend - requested agent.
   * @returns the completed plan.
   */
  async install(backend: RemoteAgentBackend): Promise<RemoteInstallPlan> {
    const plan = this.installPlan(backend)
    if (plan.unavailableReason !== undefined) throw new Error(plan.unavailableReason)
    if (plan.alreadyInstalled) return plan
    if (backend === 'dsh') {
      await this.installDshRuntime()
    } else {
      const packages = npmPackages(backend)
      if (packages === undefined) throw new Error('no installer is configured')
      const npm = this.npmInstaller()
      const result = await run(
        npm.command,
        [...npm.args, 'install', '-g', ...packages],
        this.options.installTimeoutMs,
        this.extraBinDirs,
      )
      if (result.code !== 0) {
        throw new Error(`installer exited with status ${result.code}: ${result.output.trim().slice(-2000) || 'no output'}`)
      }
    }
    await this.refreshExtraBins(true)
    if (backend === 'dsh') await this.refreshDshLaunch(true)
    const installed = this.installPlan(backend)
    if (!installed.alreadyInstalled) {
      throw new Error(backend === 'dsh'
        ? 'pip installed deepseek-harness-runtime-bin but bundled_runtime_path() did not resolve a runtime executable'
        : `${backend} installer finished but the command is not on PATH or in the official npm/pip location`)
    }
    return installed
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
    if (!this.hasCommand(command)) throw new Error(`${backend} is not installed`)
    const flowId = RemoteAuthFlowId(randomUUID())
    const expiresAt = new Date(Date.now() + this.options.authTimeoutMs).toISOString()
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(this.extraBinDirs) })
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

  private backendInstalled(backend: RemoteAgentBackend): boolean {
    if (backend === 'codex') return this.hasCommand(this.options.codexCliCommand) && this.hasCommand(this.options.codexAcpCommand)
    if (backend === 'claude') return this.hasCommand(this.options.claudeCommand) && this.hasCommand(this.options.claudeAcpCommand)
    if (backend === 'grok') return this.hasCommand(this.options.grokCommand)
    return this.dshInstalled()
  }

  private dshInstalled(): boolean {
    return this.resolveDshFromPath() !== undefined || this.dshLaunch?.command !== undefined
  }

  private resolveDshFromPath(): string | undefined {
    return resolveCommandPath(this.options.dshCommand, this.extraBinDirs)
  }

  /** Absolute DSH runtime command and bundled config, if the official wheel is present.
   * @returns launch paths for hold-worker stdio.
   */
  async resolvedDshLaunch(): Promise<DshLaunch | undefined> {
    await this.refreshExtraBins()
    await this.refreshDshLaunch()
    if (this.dshLaunch !== undefined) return this.dshLaunch
    const command = this.resolveDshFromPath()
    return command === undefined ? undefined : { command }
  }

  private async refreshDshLaunch(force = false): Promise<void> {
    if (!force && this.dshLaunch !== undefined) return
    const fromPath = this.resolveDshFromPath()
    if (fromPath !== undefined) {
      this.dshLaunch = { command: fromPath }
      return
    }
    const python = this.options.pythonCommand ?? resolvePython()
    if (python === undefined) {
      this.dshLaunch = undefined
      return
    }
    try {
      const result = await run(python, ['-c', DSH_RESOLVE_SCRIPT], 5_000, this.extraBinDirs)
      const paths = result.output.trim().split(/\r?\n/).map(line => line.trim()).filter(line => line.includes('/') || line.includes('\\'))
      const command = paths.length >= 2 ? paths[paths.length - 2] : paths[0]
      const configPath = paths.length >= 2 ? paths[paths.length - 1] : undefined
      if (result.code !== 0 || command === undefined) {
        this.dshLaunch = undefined
        return
      }
      try {
        accessSync(command, constants.X_OK)
        if (!statSync(command).isFile()) {
          this.dshLaunch = undefined
          return
        }
      } catch {
        this.dshLaunch = undefined
        return
      }
      this.dshLaunch = {
        command,
        ...(configPath !== undefined && existsSync(configPath) ? { configPath } : {}),
      }
    } catch {
      this.dshLaunch = undefined
    }
  }

  private npmInstaller(): { readonly command: string; readonly args: readonly string[] } {
    const override = this.options.npmCommand
    if (override !== undefined) return { command: override[0], args: override.slice(1) }
    return resolveNpm()
  }

  private async refreshExtraBins(force = false): Promise<void> {
    if (!force && this.extraBinDirs.length > 0) return
    const dirs: string[] = []
    const npm = this.npmInstaller()
    try {
      const prefix = await run(npm.command, [...npm.args, 'prefix', '-g'], 5_000, this.extraBinDirs)
      const value = prefix.output.trim().split(/\r?\n/).at(-1)?.trim()
      if (prefix.code === 0 && value !== undefined && value !== '') {
        dirs.push(process.platform === 'win32' ? value : join(value, 'bin'))
      }
    } catch {
      // npm may be missing; PATH and the hostd Node directory remain.
    }
    const python = this.options.pythonCommand ?? resolvePython()
    if (python !== undefined) {
      try {
        const scripts = await run(
          python,
          ['-c', "import os,sysconfig; print(sysconfig.get_path('scripts', 'nt_user' if os.name=='nt' else 'posix_user'))"],
          5_000,
          this.extraBinDirs,
        )
        const value = scripts.output.trim().split(/\r?\n/).at(-1)?.trim()
        if (scripts.code === 0 && value !== undefined && value !== '') dirs.push(value)
      } catch {
        // python/pip may be missing; DSH install will fail with a clear reason.
      }
    }
    this.extraBinDirs = [...new Set(dirs.filter(directory => directory !== ''))]
  }

  private async installDshRuntime(): Promise<void> {
    const python = this.options.pythonCommand ?? resolvePython()
    if (python === undefined) throw new Error('python3 is not available on this host')
    const result = await run(
      python,
      [...DSH_PIP_ARGS],
      this.options.installTimeoutMs,
      this.extraBinDirs,
    )
    if (result.code !== 0) {
      throw new Error(`DSH installer exited with status ${result.code}: ${result.output.trim().slice(-2000) || 'no output'}`)
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

/** Reject browser install requests that omitted the required confirmation flag. */
export function requireInstallConfirmation(value: JsonValue | undefined): void {
  if (value !== true) throw new Error('installation requires confirm: true')
}
