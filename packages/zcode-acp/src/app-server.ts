/**
 * The ZCode Protocol half of the adapter: spawn and drive one app-server.
 *
 * Everything here is measured, not guessed (live captures 2026-10-13; the
 * facts also live in docs/agent-acp/zcode.md):
 *
 * - ndjson both ways, and **never** a `jsonrpc` key — the server's zod strict
 *   schemas reject one with -32600, the exact opposite of the ACP side.
 * - The server sends **reverse requests** that must be answered within 15 s;
 *   a missed answer fails the whole pending call with -32022. The reader
 *   therefore stays free: every reverse request is answered from its own
 *   async task, never awaited inline.
 * - `interaction/requestProviderRuntimeHeaders` arrives before **every** model
 *   request and is where the decrypted api key is injected.
 * - `provider/updateAccountConfig` must echo the builtin revision the server
 *   actually loaded, parsed out of the jsonl log this process newly writes.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { loadApiKey } from './credential.ts'
import type { ZcodePaths } from './paths.ts'

export const PROVIDER = 'account:bigmodel-individual-coding-plan'

/** The builtin model ids the account config declares entitlement for. */
export const BUILTIN_MODELS = ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2'] as const

/** One reverse `interaction/requestPermission`, flattened for the ACP side. */
export type ZcodePermissionRequest = {
  readonly sessionId?: string
  readonly toolCallId?: string
  readonly toolName?: string
  readonly riskLevel?: string
  readonly reason?: string
  readonly input?: unknown
  /** ZCode's own options, each carrying the `response` template to echo back. */
  readonly options: readonly {
    readonly optionId: string
    readonly name: string
    readonly kind: string
    readonly response: Record<string, unknown>
  }[]
}

export type ZcodeEvent = { readonly method: string; readonly params: Record<string, unknown> }

export type AppServerOptions = {
  readonly cwd: string
  readonly paths: ZcodePaths
  /** Startup settle time before the log is read for the registry revision. */
  readonly startupWaitMs?: number
  /** Decides a forwarded permission; resolves with the ZCode response object. */
  readonly onPermission: (request: ZcodePermissionRequest) => Promise<Record<string, unknown>>
  /** Every server notification, routed by the ACP layer. */
  readonly onEvent: (event: ZcodeEvent) => void
  /** The death of the child, so a hung turn can be failed instead of waited out. */
  readonly onDeath?: (reason: string) => void
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export class ZcodeAppServer {
  private readonly child: ChildProcess
  private readonly options: AppServerOptions
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly apiKey: Promise<string>
  private readonly logFile: string
  private logOffset = 0
  private closed = false

  constructor(options: AppServerOptions) {
    this.options = options
    this.apiKey = loadApiKey(options.paths.credentialsFile)
    this.logFile = `${options.paths.logDir}/zcode-${new Date().toISOString().slice(0, 10)}.jsonl`
    try {
      this.logOffset = statSync(this.logFile).size
    } catch {
      // No log yet today: everything the child writes is new.
    }

    const env = { ...process.env } as Record<string, string>
    env['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'] = newestBuiltin(options.paths.builtinBase)
    env['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'] = options.paths.personalConfig

    this.child = spawn(options.paths.nodeBin, [options.paths.serverScript, 'app-server'], {
      cwd: options.cwd,
      env,
      // stderr passes through to ours: DSH's transport keeps a stderr tail as
      // the agent's last words when the child dies, and a swallowed crash is
      // exactly the silent failure this adapter must not have.
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    const stdin = this.child.stdin
    const stdout = this.child.stdout
    if (stdin === null || stdout === null) {
      throw new Error('zcode app-server did not start with pipes')
    }
    stdout.setEncoding('utf8')
    createInterface({ input: stdout }).on('line', line => this.receive(line))
    this.child.on('error', error => {
      this.closed = true
      const reason = `zcode app-server failed to start: ${error instanceof Error ? error.message : String(error)}`
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(reason))
      }
      this.pending.clear()
      options.onDeath?.(reason)
    })
    this.child.on('exit', (code, signal) => {
      if (this.closed) return
      this.closed = true
      const reason = `zcode app-server exited (${signal ?? `code ${String(code)}`})`
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error(reason))
      }
      this.pending.clear()
      options.onDeath?.(reason)
    })
  }

  /** The one-time account handshake; must precede any session work. */
  async ensureAccount(): Promise<void> {
    await delay(this.options.startupWaitMs ?? 1500)
    const revision = await this.registryRevision()
    const reply = await this.request('provider/updateAccountConfig', {
      revision: `acp-bridge-${String(Math.floor(Date.now() / 1000))}`,
      basedOnZCodeBuiltinRevision: revision,
      providers: {
        [PROVIDER]: {
          builtinModelIds: [...BUILTIN_MODELS],
          access: { type: 'zhipu-account', entitled: true },
        },
      },
      states: {
        [PROVIDER]: { availability: 'available', entitled: true, current: true },
      },
    }, 20_000)
    if ((reply as { providerCount?: unknown } | null)?.providerCount === 0) {
      throw new Error('zcode account provider did not register')
    }
  }

  async createSession(mode: string): Promise<string> {
    const cwd = this.options.cwd
    const reply = await this.request('session/create', {
      workspace: { workspacePath: cwd, workspaceKey: cwd },
      persistence: 'immediate',
      mode,
      titleGenerationEnabled: false,
    }, 60_000) as { session?: { sessionId?: unknown } } | { code?: unknown } | null
    if (reply === null || typeof reply !== 'object') throw new Error('session/create failed')
    if ('code' in reply) throw new Error(`session/create failed: ${JSON.stringify(reply).slice(0, 200)}`)
    const sessionId = (reply as { session?: { sessionId?: unknown } }).session?.sessionId
    if (typeof sessionId !== 'string') throw new Error('session/create returned no sessionId')
    return sessionId
  }

  async resumeSession(sessionId: string): Promise<string> {
    const cwd = this.options.cwd
    await this.request('session/resume', { sessionId, workspace: { workspacePath: cwd, workspaceKey: cwd } }, 30_000)
    return sessionId
  }

  async subscribe(sessionId: string): Promise<void> {
    await this.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: false }, 30_000)
  }

  async sendTurn(sessionId: string, content: string, modelId: string, reasoningLevel: string): Promise<void> {
    const reply = await this.request('session/send', {
      sessionId,
      content,
      modelSelection: {
        providerId: PROVIDER,
        modelId,
        options: { reasoningLevel },
      },
    }, 30_000)
    if ((reply as { accepted?: unknown } | null)?.accepted !== true) {
      throw new Error(`session/send was not accepted: ${JSON.stringify(reply).slice(0, 200)}`)
    }
  }

  async stopTurn(sessionId: string): Promise<void> {
    try {
      await this.request('session/stop', { sessionId }, 10_000)
    } catch {
      // Stopping a turn that already ended is not fatal for the adapter.
    }
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    await this.request('session/setMode', { sessionId, mode }, 15_000)
  }

  /** The last assistant text, the fallback when the event stream carried none. */
  async lastAssistantText(sessionId: string): Promise<string | undefined> {
    const reply = await this.request('session/messages', { sessionId }, 30_000) as
      | { messages?: { info?: { role?: unknown }; parts?: { type?: unknown; text?: unknown }[] }[] }
      | null
    let last: { parts?: { type?: unknown; text?: unknown }[] } | undefined
    for (const message of reply?.messages ?? []) {
      if (message?.info?.role === 'assistant') last = message
    }
    if (last === undefined) return undefined
    const parts = (last.parts ?? [])
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text as string)
    const text = parts.join('\n').trim()
    return text === '' ? undefined : text
  }

  close(): void {
    this.closed = true
    this.child.kill()
  }

  private send(frame: Record<string, unknown>): void {
    const stdin = this.child.stdin
    if (stdin === null || this.closed) return
    stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`zcode ${method} timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ id, method, params })
    })
  }

  private receive(line: string): void {
    if (line.trim() === '') return
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return // diagnostics on stdout; the protocol lines are all JSON
    }
    // The real app-server addresses its reverse requests by STRING ids (the
    // 15 s deadline fired before this was widened — measured 2026-10-13);
    // only our own outbound ids are numeric.
    if (frame['id'] !== undefined && typeof frame['method'] === 'string') {
      // A reverse request: answered from its own task so the reader keeps
      // draining — one slow answer must not stall the 15 s clock of the next.
      void this.answerReverse(frame['id'] as number | string, frame['method'], (frame['params'] ?? {}) as Record<string, unknown>)
      return
    }
    if (typeof frame['id'] === 'number') {
      const entry = this.pending.get(frame['id'])
      if (entry === undefined) return
      this.pending.delete(frame['id'])
      clearTimeout(entry.timer)
      if (frame['error'] !== undefined) entry.reject(new Error(`zcode error: ${JSON.stringify(frame['error']).slice(0, 300)}`))
      else entry.resolve(frame['result'])
      return
    }
    if (typeof frame['method'] === 'string') {
      this.options.onEvent({ method: frame['method'], params: (frame['params'] ?? {}) as Record<string, unknown> })
    }
  }

  private async answerReverse(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'session/requestRuntimePreferences') {
      // No subagentRuntimeConfigEnabled: omitting it avoids one extra request.
      this.send({ id, result: { nativeSearchEnhancementsEnabled: true, memoryEnabled: true } })
      return
    }
    if (method === 'subagents/readRuntimeConfig') {
      this.send({ id, result: { kind: 'built-in-fallback' } })
      return
    }
    if (method === 'interaction/requestProviderRuntimeHeaders') {
      try {
        this.send({ id, result: { headersApplied: true, requestAuth: { apiKey: await this.apiKey } } })
      } catch (error) {
        this.send({ id, error: { code: -32001, message: error instanceof Error ? error.message : 'credential unavailable' } })
      }
      return
    }
    if (method === 'interaction/requestPermission') {
      try {
        const response = await this.options.onPermission(parsePermission(params))
        this.send({ id, result: response })
      } catch (error) {
        this.send({ id, error: { code: -32001, message: error instanceof Error ? error.message : 'permission failed' } })
      }
      return
    }
    // Anything else — requestUserInput, official MCP auth, the unknown — gets
    // an error so the call cannot hang; session creation is unaffected.
    this.send({ id, error: { code: -32001, message: `zcode-acp does not serve ${method}` } })
  }

  /**
   * The builtin revision this process loaded, out of the log lines it wrote
   * after spawn. `basedOnZCodeBuiltinRevision` is checked against it, so a
   * stale value is a rejected handshake — this parse is what self-heals over
   * app upgrades.
   */
  private async registryRevision(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const chunk = readFileSync(this.logFile, { encoding: 'utf8', flag: 'r' }).slice(this.logOffset)
        for (const line of chunk.split('\n')) {
          if (line.trim() === '') continue
          try {
            const entry = JSON.parse(line) as { event?: unknown; context?: { configRevision?: unknown } }
            if (entry.event !== 'zcode_protocol.provider_registry.ready') continue
            let revision = entry.context?.configRevision
            if (typeof revision === 'string') revision = JSON.parse(revision)
            if (Array.isArray(revision) && typeof revision[0] === 'string') return revision[0]
          } catch {
            // a partial or non-JSON line; the next attempt reads more
          }
        }
      } catch {
        // log not written yet — retry below
      }
      await delay(1000)
    }
    throw new Error('could not read the zcode provider registry revision from the log')
  }
}

/** Flatten one reverse permission request; keep ZCode's response templates. */
function parsePermission(params: Record<string, unknown>): ZcodePermissionRequest {
  const options = Array.isArray(params['options']) ? params['options'] : []
  return {
    ...(typeof params['sessionId'] === 'string' ? { sessionId: params['sessionId'] } : {}),
    ...(typeof params['toolCallId'] === 'string' ? { toolCallId: params['toolCallId'] } : {}),
    ...(typeof params['toolName'] === 'string' ? { toolName: params['toolName'] } : {}),
    ...(typeof params['riskLevel'] === 'string' ? { riskLevel: params['riskLevel'] } : {}),
    ...(typeof params['reason'] === 'string' ? { reason: params['reason'] } : {}),
    ...(params['input'] === undefined ? {} : { input: params['input'] }),
    options: options.flatMap(option => {
      const entry = (option ?? {}) as Record<string, unknown>
      const optionId = entry['optionId']
      if (typeof optionId !== 'string') return []
      return [{
        optionId,
        name: typeof entry['name'] === 'string' ? entry['name'] : optionId,
        kind: typeof entry['kind'] === 'string' ? entry['kind'] : 'deny',
        response: (entry['response'] ?? {}) as Record<string, unknown>,
      }]
    }),
  }
}

/**
 * The newest `zcode-builtin.json` under the provider base.
 *
 * Version dirs sort numerically by component — a plain string sort would put
 * 3.9 above 3.14, and the account handshake would then echo a stale revision.
 */
function newestBuiltin(base: string): string {
  if (!existsSync(base)) {
    throw new Error(`zcode builtin provider base not found: ${base} (is the ZCode desktop app installed?)`)
  }
  const versions = readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+(\.\d+)*$/.test(entry.name))
    .sort((a, b) => compareVersions(a.name, b.name))
  for (let i = versions.length - 1; i >= 0; i--) {
    const dir = `${base}/${versions[i]!.name}`
    const endpoints = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('endpoint-'))
      : []
    for (const endpoint of endpoints) {
      const candidate = `${dir}/${endpoint.name}/zcode-builtin.json`
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(`no endpoint-*/zcode-builtin.json under ${base}`)
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}
