/**
 * Reaching a configured external agent: process or socket, per preset.
 *
 * DSH's own approval service is not reachable from here, so permission
 * answering arrives as a port. Keeping it injected rather than importing the
 * runtime package is deliberate — see the service entry for why.
 */

import {
  AcpClient,
  GrokServeTransport,
  StdioAcpTransport,
  TerminalService,
  WebSocketAcpTransport,
  claudeDialect,
  codexDialect,
  cursorDialect,
  grokDialect,
  stdioArgsFor as acpStdioArgsFor,
} from '@threadharbor/dsh-acp-agent'
import type {
  AcpDialect,
  AcpTransport,
  AskQuestionAnswer,
  AskQuestionRequest,
  PermissionDecision,
  PermissionRequest,
} from '@threadharbor/dsh-acp-agent'
import { cwdForOpen } from './registry.ts'
import type { AcpPresetConfig, AcpSession, AcpSessionFactory, PresetConfig } from './registry.ts'
import { AcpTurnRunner } from './runner.ts'
import type { AcpClientPort } from './runner.ts'
import type { SubagentSessionHost } from './subagent-sessions.ts'

export type FactoryDeps = {
  /** Answer an agent-initiated permission request. */
  answerPermission(request: PermissionRequest): Promise<PermissionDecision>
  /**
   * Put the agent's question in front of a human and return the answer.
   *
   * Supplied when the host has a question service to ask through; omitted
   * means cursor's question keeps its benign auto-answer.
   */
  answerAskQuestion?(request: AskQuestionRequest): Promise<AskQuestionAnswer>
  /**
   * Build the transport a preset connects over.
   *
   * Supplied by tests so the client this factory builds can actually be driven —
   * permission handling is decided inside a client the factory otherwise keeps
   * to itself, which leaves nothing to assert against.
   */
  transport?(preset: { url?: string; command?: string }): AcpTransport
  /**
   * Receive the model list the agent reported when a session of this preset
   * opened.
   *
   * The factory is the seam that knows which preset opened, so it keys the
   * report; the catalog adapter serves the latest report per preset. Optional:
   * a caller without a catalog to feed skips the wiring and nothing changes.
   */
  onRuntimeModels?(presetId: string, models: readonly { id: string; name: string; description?: string }[]): void
  /**
   * 外部子代理的影子子会话端口。
   *
   * 缺席（或 `available:false`）时泵内子会话动作归零：只留父会话卡片。
   */
  subagents?: SubagentSessionHost
}

/** Which frame dialect an agent speaks. Unknown agents are not ours. */
const DIALECTS: Readonly<Record<string, AcpDialect>> = {
  grok: grokDialect,
  claude: claudeDialect,
  codex: codexDialect,
  cursor: cursorDialect,
}

/**
 * The argv one stdio preset is spawned with.
 *
 * The preset's own `args` wins outright: it names a command line the deployment
 * chose, and half-appending a default to it would produce an invocation nobody
 * asked for. Everything else falls back to what the agent needs to speak ACP at
 * all — see `stdioArgsFor` for why cursor is not simply spawned bare.
 * @param preset - the configured preset about to be spawned.
 * @returns the arguments, empty when the binary is the service itself.
 */
export function stdioArgsFor(preset: AcpPresetConfig): readonly string[] {
  return preset.args ?? acpStdioArgsFor(preset.agent)
}

/**
 * A transport whose death reaches every listener, not only the last one.
 *
 * The real transports hold a single death slot: each `onDeath` registration
 * replaces the previous handler. The AcpClient owns that slot the moment it is
 * constructed, so a second listener registered afterwards would silently steal
 * the client's — in-flight turns would then wait forever on a dead connection
 * while only the registry heard about the death. Fanning out from one
 * underlying registration is what keeps both listeners live.
 */
class DeathFanoutTransport implements AcpTransport {
  private readonly inner: AcpTransport
  private readonly listeners = new Set<(reason: string) => void>()
  private wired = false

  constructor(inner: AcpTransport) {
    this.inner = inner
  }

  send(line: string): void { this.inner.send(line) }

  onLine(handler: (line: string) => void): void { this.inner.onLine(handler) }

  onDeath(handler: (reason: string) => void): void {
    this.listeners.add(handler)
    if (this.wired) return
    this.wired = true
    // Copied before iterating: a listener that registers another one during
    // death must not be half-covered by this loop.
    this.inner.onDeath(reason => {
      for (const listener of [...this.listeners]) listener(reason)
    })
  }

  close(): void { this.inner.close() }

  lastFrameAt(): number { return this.inner.lastFrameAt() }

  lastDiagnosticAt(): number { return this.inner.lastDiagnosticAt() }

  stderrTail(): readonly string[] { return this.inner.stderrTail() }
}

export function makeSessionFactory(config: PresetConfig, deps: FactoryDeps): AcpSessionFactory {
  return {
    dialectFor: (_presetId, preset) => DIALECTS[preset.agent ?? ''],

    open: async (presetId, options): Promise<AcpSession> => {
      const preset = config.presets[presetId]
      if (preset === undefined) throw new Error(`acp dispatch: no preset named ${presetId}`)
      if (preset.agent === 'zcode') {
        throw new Error('zcode answers as a model inside the native loop; it is not opened as an ACP session')
      }
      // Refuse before any child starts. An omitted directory would otherwise
      // inherit this process's directory, which is not the session's workspace.
      const cwd = cwdForOpen(options.cwd)

      // grok is reached over a `grok agent serve` WebSocket this transport starts
      // and owns (random port + secret, ready-wait, kill on close) — unlike the
      // stdio agents, whose command spawns itself. A preset that names a static
      // url keeps the plain WebSocket path; tests inject their own transport.
      const raw = deps.transport?.(preset) ?? (preset.url !== undefined
        ? new WebSocketAcpTransport({ url: preset.url })
        : preset.agent === 'grok'
          ? await GrokServeTransport.create({
              command: preset.command ?? 'grok',
              cwd,
            })
          : new StdioAcpTransport({
              command: preset.command ?? '',
              args: stdioArgsFor(preset),
              cwd,
            }))
      // The client and the registry's death watcher both listen; the fanout is
      // what lets them without one stealing the other's slot.
      const transport = new DeathFanoutTransport(raw)

      const dialect = DIALECTS[preset.agent ?? ''] ?? grokDialect
      const client = new AcpClient(transport, dialect)
      // grok delegates shell execution to the client. Without this the agent
      // waits for a terminal that never appears, and the turn hangs silently.
      client.terminals = new TerminalService()
      client.onPermissionRequest = async request => await deps.answerPermission(request)
      // Cursor sends two blocking custom methods that stall the turn if left
      // unanswered. Answer them with a benign outcome so the agent proceeds;
      // any other unknown method still falls through to the default error.
      // The ask hook sits in front of that auto-answer when the host can put
      // the question to a human — the client hands the question over and the
      // user's answer returns in cursor's answered envelope. The request names
      // this opener's DSH session when the frame itself does not, because the
      // host resolves the live agent — and with it the conversation the
      // question card belongs to — by session.
      if (preset.agent === 'cursor') {
        if (deps.answerAskQuestion !== undefined) {
          client.onAskQuestion = async request => await deps.answerAskQuestion!(
            request.sessionId === undefined && options.dshSessionId !== undefined
              ? { ...request, sessionId: options.dshSessionId }
              : request,
          )
        }
        client.onExtensionRequest = frame => {
          if (typeof frame.id !== 'number') return false
          if (frame.method === 'cursor/ask_question') { client.reply(frame.id, { outcome: { outcome: 'skipped' } }); return true }
          if (frame.method === 'cursor/create_plan') { client.reply(frame.id, { outcome: { outcome: 'cancelled' } }); return true }
          return false
        }
      }

      // The dialect lets the runner write each tool card as its first frame
      // arrives; without it the runner would keep writing everything at turn
      // end. The same dialect reads the reply's model list, which rides to the
      // catalog keyed by the preset that opened.
      const runner = new AcpTurnRunner(adaptClient(client, dialect), {
        ...options,
        cwd,
        dialect,
        ...(deps.onRuntimeModels === undefined ? {} : { onModels: models => { deps.onRuntimeModels!(presetId, models) } }),
        ...(deps.subagents === undefined ? {} : { subagents: deps.subagents }),
      })
      return {
        run: async (decision, turn) => await runner.run(decision, turn),
        // The segmented path, passed through with its `first` marker untouched:
        // the registry's binding hands it to the dispatch, which iterates one
        // external turn across several step calls.
        runSteps: (decision, turn, at) => runner.runSteps(decision, turn, at),
        // Drops the connection itself, not just the runner's bookkeeping: a
        // runner that forgets its session id would otherwise hand back the
        // same conversation.
        close: () => { client.close() },
        onDead: handler => { transport.onDeath(handler) },
        diagnostics: () => ({
          lastFrameAt: transport.lastFrameAt(),
          lastDiagnosticAt: transport.lastDiagnosticAt(),
          stderrTail: transport.stderrTail(),
        }),
      }
    },
  }
}

/**
 * Present the ACP client as the incremental frame port the runner expects.
 *
 * The runner installs one handler at construction; every inbound frame then
 * reaches it as it lands, which is what lets text reach the UI while the agent
 * is still working.
 */
export function adaptClient(client: AcpClient, dialect: AcpDialect): AcpClientPort {
  return {
    request: (method, params) => client.request(method, params),
    notify: (method, params) => { client.notify(method, params) },
    onFrame: handler => { client.onFrame(frame => { handler(frame) }) },
    // Cursor must authenticate (after an interactive `agent login`) before
    // session/new; the runner calls this between initialize and session/new.
    ...(dialect.authenticateMethodId === undefined
      ? {}
      : { authenticate: () => client.request('authenticate', { methodId: dialect.authenticateMethodId }) }),
  }
}
