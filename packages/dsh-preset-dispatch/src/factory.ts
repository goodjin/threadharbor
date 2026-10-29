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
  qoderDialect,
  stdioArgsFor as acpStdioArgsFor,
  stdioEnvFor as acpStdioEnvFor,
} from '@threadharbor/dsh-acp-agent'
import type {
  AcpDialect,
  AcpFrame,
  AcpTransport,
  AskQuestionAnswer,
  AskQuestionRequest,
  PermissionDecision,
  PermissionRequest,
} from '@threadharbor/dsh-acp-agent'
import { cwdForOpen } from './registry.ts'
import type { AcpPresetConfig, AcpSession, AcpSessionFactory, PresetConfig } from './registry.ts'
import { codexProgressProbe, grokProgressProbe, qoderProgressProbe } from './agent-progress.ts'
import type { ProgressProbe } from './agent-progress.ts'
import type { SharedAgent, OpenSessionOptions } from './registry.ts'
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
   * The external session id a previous host generation journaled for one DSH
   * session of this preset, when one is remembered.
   *
   * Keyed by both because a session that switched presets must not resume into
   * the wrong agent's conversation. The runner turns the answer into one
   * `session/resume` attempt before any `session/new` (dialect-gated); a
   * caller without a journal — every deployment today — omits this and opens
   * exactly as before.
   */
  resumeOf?(presetId: string, dshSessionId: string): string | undefined
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
  qoder: qoderDialect,
}

/**
 * 外部 agent 在回合中途长时间不吐 ACP 帧时，读它自己的日志判断是否还在
 * 干活（2026-10-27 codex 压缩上下文；2026-10-28 qoder 长工具执行——模型
 * 请求期间思考帧照常流，不发帧的是工具在跑的那段；同一天 grok 自动压缩
 * 上下文——它把压缩事件包在方言不收的私有方法里，帧里看不见）。
 * 只给接了这种日志信号的 agent 接这层：codex 读 ~/.codex/logs_2.sqlite，
 * qoder 读 <config>/logs/sessions/.../segments/*.jsonl，grok 读
 * $GROK_HOME/sessions/<项目>/<sessionId>/updates.jsonl。别的 agent 没有
 * 这个库，接上也只会是空操作。
 *
 * 开连接的两条路径（独占与共享）都用这一处选型：共享连接上探针按会话 id
 * 读数，读者各记各的游标，不会互相串。
 */
function progressProbeFor(agent: string | undefined): ProgressProbe | undefined {
  switch (agent) {
    case 'codex': return codexProgressProbe()
    case 'qoder': return qoderProgressProbe()
    case 'grok': return grokProgressProbe()
    default: return undefined
  }
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
      if (preset.agent === 'minimaxi') {
        throw new Error('minimaxi answers as a model inside the native loop; it is not opened as an ACP session')
      }
      // Refuse before any child starts. An omitted directory would otherwise
      // inherit this process's directory, which is not the session's workspace.
      const cwd = cwdForOpen(options.cwd)

      // A host launched from the Qoder IDE exports SDK-entrypoint variables
      // that make the CLI refuse to start headless; the helper strips them for
      // that agent and returns undefined (inherit) for the rest.
      const childEnv = acpStdioEnvFor(preset.agent)
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
              ...(childEnv === undefined ? {} : { env: childEnv }),
            }))
      // The client and the registry's death watcher both listen; the fanout is
      // what lets them without one stealing the other's slot.
      const transport = new DeathFanoutTransport(raw)

      const dialect = DIALECTS[preset.agent ?? ''] ?? grokDialect
      const client = new AcpClient(transport, dialect)
      // grok delegates shell execution to the client. Without this the agent
      // waits for a terminal that never appears, and the turn hangs silently.
      const terminalService = new TerminalService()
      client.terminals = terminalService
      terminalService.onOutput = (terminalId, data) => {
        client.onTerminalOutput?.(terminalId, data)
      }
      terminalService.onExit = (info) => {
        client.onTerminalExit?.(info.terminalId, info.exitCode)
      }
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
      //
      // The documented notification methods (`cursor/update_todos`,
      // `cursor/task`, `cursor/generate_image`) arrive as JSON-RPC REQUESTS on
      // cursor 2026.10.01 (measured 2026-10-21: `cursor/task` carries an id and
      // blocks until answered). They are fire-and-forget by contract, so an
      // empty result acknowledges them without claiming an outcome; one that
      // really is a notification needs no reply and stays unreplied.
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
          if (frame.method === 'cursor/task'
            || frame.method === 'cursor/update_todos'
            || frame.method === 'cursor/generate_image') {
            client.reply(frame.id, {})
            return true
          }
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
        ...(deps.resumeOf === undefined ? {} : { resumeOf: dshSessionId => deps.resumeOf!(presetId, dshSessionId) }),
        ...(deps.subagents === undefined ? {} : { subagents: deps.subagents }),
      })
      // 外部 agent 自己的日志进度信号（选型见 progressProbeFor）。
      const progressProbe = progressProbeFor(preset.agent)
      return {
        run: async (decision, turn) => await runner.run(decision, turn),
        // The segmented path, passed through with its `first` marker untouched:
        // the registry's binding hands it to the dispatch, which iterates one
        // external turn across several step calls.
        runSteps: (decision, turn, at) => runner.runSteps(decision, turn, at),
        // Drops the connection itself, not just the runner's bookkeeping: a
        // runner that forgets its session id would otherwise hand back the
        // same conversation.
        close: () => {
          progressProbe?.close()
          client.close()
        },
        onDead: handler => { transport.onDeath(handler) },
        diagnostics: () => {
          const lastStatus = runner.lastStatusSnapshot()
          return {
            lastFrameAt: transport.lastFrameAt(),
            lastDiagnosticAt: transport.lastDiagnosticAt(),
            stderrTail: transport.stderrTail(),
            // 外部 agent 自己的子代理/后台任务还开着几个：网关的总上限据此让路。
            liveDelegatedRuns: runner.liveDelegatedRuns(),
            // 最后上报的状态与日志层进度：超时消息的解释与「没帧也算活着」的依据。
            ...(lastStatus === undefined ? {} : { lastStatus }),
            ...(progressProbe === undefined ? {} : {
              progress: () => {
                const external = runner.externalSessionId()
                return external === undefined ? undefined : progressProbe.read(external)
              },
            }),
          }
        },
      }
    },

    /**
     * Open a shared agent process: spawn transport, create client, and return
     * a handle that can serve multiple DSH sessions.
     *
     * The ACP handshake (initialize + initialized + optional authenticate) is
     * performed lazily on the first openSession call, so this method returns
     * immediately after spawning the transport.
     */
    openShared: async (presetId: string): Promise<SharedAgent> => {
      const preset = config.presets[presetId]
      if (preset === undefined) throw new Error(`acp dispatch: no preset named ${presetId}`)
      if (preset.agent === 'zcode') {
        throw new Error('zcode answers as a model inside the native loop; it is not opened as an ACP session')
      }
      if (preset.agent === 'minimaxi') {
        throw new Error('minimaxi answers as a model inside the native loop; it is not opened as an ACP session')
      }

      // Spawn transport using a neutral cwd (session-specific cwd is set per session/new)
      const childEnv = acpStdioEnvFor(preset.agent)
      const raw = deps.transport?.(preset) ?? (preset.url !== undefined
        ? new WebSocketAcpTransport({ url: preset.url })
        : preset.agent === 'grok'
          ? await GrokServeTransport.create({
              command: preset.command ?? 'grok',
              cwd: process.cwd(),
            })
          : new StdioAcpTransport({
              command: preset.command ?? '',
              args: stdioArgsFor(preset),
              cwd: process.cwd(),
              ...(childEnv === undefined ? {} : { env: childEnv }),
            }))
      const transport = new DeathFanoutTransport(raw)

      const dialect = DIALECTS[preset.agent ?? ''] ?? grokDialect
      const client = new AcpClient(transport, dialect)
      const terminalService = new TerminalService()
      client.terminals = terminalService
      client.onPermissionRequest = async request => await deps.answerPermission(request)
      if (preset.agent === 'cursor') {
        if (deps.answerAskQuestion !== undefined) {
          client.onAskQuestion = async request => await deps.answerAskQuestion!(request)
        }
        client.onExtensionRequest = frame => {
          if (typeof frame.id !== 'number') return false
          if (frame.method === 'cursor/ask_question') { client.reply(frame.id, { outcome: { outcome: 'skipped' } }); return true }
          if (frame.method === 'cursor/create_plan') { client.reply(frame.id, { outcome: { outcome: 'cancelled' } }); return true }
          if (frame.method === 'cursor/task'
            || frame.method === 'cursor/update_todos'
            || frame.method === 'cursor/generate_image') {
            client.reply(frame.id, {})
            return true
          }
          return false
        }
      }

      // ── 共享连接上的按会话分流 ──────────────────────────────────────────
      // 一条连接挂着许多 ACP 会话：帧、终端回调与看门狗信标都必须按会话 id
      // 归位。否则一个会话的正文会流进另一个会话，一个会话的动静会把另一个
      // 会话的静默期限重新点亮（120s/300s 的超时判断就再也不会响）。回执帧
      // 不带会话 id，只能靠请求 id 认领——谁发的请求，回执就只给谁。
      type SharedRoute = {
        /** 这条会话有权收到帧的 ACP 会话 id：它自己的，加上它子代理的。 */
        readonly claimed: Set<string>
        readonly deliver: Set<(frame: AcpFrame) => void>
        readonly terminalOutput: Set<(terminalId: string, data: string) => void>
        readonly terminalExit: Set<(terminalId: string, exitCode: number) => void>
        /** 在途请求的回执 id，关闭时一并退订。 */
        readonly pending: Set<number>
        /** 这条会话自己的进展信标；别的会话的帧不会动它。 */
        lastFrameAt: number
        /** 在途 session/new 的请求 id——它的回执带出这个会话的 id。 */
        openingId: number | undefined
      }
      const routes = new Set<SharedRoute>()
      const bySession = new Map<string, SharedRoute>()
      const replyOwner = new Map<number, SharedRoute>()
      /**
       * 尚未被认领的会话帧。子会话的首帧可能先于父会话处理出生帧到达（接管
       * 路径的泵是按段驱动的），先存着，认领时按序补投。每会话有界：一直无人
       * 认领的 id 不能把内存撑大。
       */
      const heldFrames = new Map<string, AcpFrame[]>()
      const HELD_FRAMES_LIMIT = 200

      const deliver = (route: SharedRoute, frame: AcpFrame, at: number, stamp = true): void => {
        if (stamp) route.lastFrameAt = at
        for (const handler of route.deliver) {
          try {
            handler(frame)
          } catch {
            // 一个观察者出事不能带走这条连接上的其他会话。
          }
        }
      }

      const claim = (route: SharedRoute, sessionId: string): void => {
        if (route.claimed.has(sessionId)) return
        route.claimed.add(sessionId)
        bySession.set(sessionId, route)
        const held = heldFrames.get(sessionId)
        if (held === undefined) return
        heldFrames.delete(sessionId)
        const at = Date.now()
        for (const frame of held) deliver(route, frame, at)
      }

      const disposeRoute = (route: SharedRoute): void => {
        routes.delete(route)
        for (const sessionId of route.claimed) {
          if (bySession.get(sessionId) === route) bySession.delete(sessionId)
        }
        for (const id of route.pending) {
          if (replyOwner.get(id) === route) replyOwner.delete(id)
        }
        route.claimed.clear()
        route.pending.clear()
        route.deliver.clear()
        route.terminalOutput.clear()
        route.terminalExit.clear()
      }

      // 帧归位：回执给请求者；带会话 id 的给该会话的所有者（没人认领就先存着
      // 等认领——子会话首帧可能先到）；不带会话 id 的通知是全局的，广播。
      client.onFrame(frame => {
        const at = Date.now()
        if (typeof frame.id === 'number' && frame.method === undefined) {
          const route = replyOwner.get(frame.id)
          if (route === undefined) return
          replyOwner.delete(frame.id)
          route.pending.delete(frame.id)
          if (route.openingId === frame.id) {
            route.openingId = undefined
            const sessionId = (frame.result as { sessionId?: unknown } | null | undefined)?.sessionId
            if (typeof sessionId === 'string') claim(route, sessionId)
          }
          deliver(route, frame, at)
          return
        }
        const params = (frame.params ?? {}) as { sessionId?: unknown }
        if (typeof params.sessionId !== 'string') {
          // 不带会话 id 的通知是全局的（握手、代理自己的信令），广播给每个
          // 会话，但不点亮它们的进展信标——谁在动，只有带 id 的帧说得清。
          for (const route of [...routes]) deliver(route, frame, at, false)
          return
        }
        const owner = bySession.get(params.sessionId)
        if (owner !== undefined) {
          deliver(owner, frame, at)
          return
        }
        const held = heldFrames.get(params.sessionId)
        if (held === undefined) heldFrames.set(params.sessionId, [frame])
        else {
          held.push(frame)
          if (held.length > HELD_FRAMES_LIMIT) held.shift()
        }
      })

      // 终端输出按 terminal/create 上写明的会话归位（配对表在 AcpClient 里）。
      // 代理没写会话、而连接上开着不止一个会话时宁可不投：猜错会把一段命令
      // 输出追加到另一个会话的工具卡上。代理自己的 tool_call_update 仍会把
      // 结果送到，丢的只是实时流。
      const terminalRoutes = (terminalId: string): readonly SharedRoute[] => {
        const owner = client.sessionOfTerminal(terminalId)
        if (owner !== undefined) {
          const route = bySession.get(owner)
          return route === undefined ? [] : [route]
        }
        return routes.size === 1 ? [...routes] : []
      }

      terminalService.onOutput = (terminalId, data) => {
        for (const route of terminalRoutes(terminalId)) {
          for (const handler of route.terminalOutput) {
            try {
              handler(terminalId, data)
            } catch {
              // 同上：一条输出投递失败不带走其他会话。
            }
          }
        }
      }
      terminalService.onExit = ({ terminalId, exitCode }) => {
        for (const route of terminalRoutes(terminalId)) {
          for (const handler of route.terminalExit) {
            try {
              handler(terminalId, exitCode)
            } catch {
              // 同上。
            }
          }
        }
      }

      // Track per-session death handlers so transport death propagates to all
      const sessionDeathHandlers = new Map<string, (reason: string) => void>()

      // Track per-session runners on this shared agent
      const sessionRunners = new Map<string, AcpSession>()
      /** DSH 会话 → 它在共享连接上的分流表。 */
      const routeByDsh = new Map<string, SharedRoute>()
      let alive = true
      // 日志层的进度信号：一条连接一个探针，按 ACP 会话 id 各读各的游标。
      const progressProbe = progressProbeFor(preset.agent)

      const sharedAgent: SharedAgent = {
        get alive() { return alive },

        openSession: async (opts: OpenSessionOptions): Promise<AcpSession> => {
          const route: SharedRoute = {
            claimed: new Set(),
            deliver: new Set(),
            terminalOutput: new Set(),
            terminalExit: new Set(),
            pending: new Set(),
            lastFrameAt: Date.now(),
            openingId: undefined,
          }
          routes.add(route)
          const port = adaptClient(client, dialect, {
            request: (method, params) => {
              // session/resume 的目标 id 发请求时就知道；先认领，回执之前到达的
              // 帧也不会被当成无人认领。
              if (method === 'session/resume') {
                const resumed = (params as { sessionId?: unknown } | null | undefined)?.sessionId
                if (typeof resumed === 'string') claim(route, resumed)
              }
              const { id, reply } = client.requestWithId(method, params)
              replyOwner.set(id, route)
              route.pending.add(id)
              if (method === 'session/new') route.openingId = id
              return reply
            },
            onFrame: handler => { route.deliver.add(handler) },
            onTerminalOutput: handler => { route.terminalOutput.add(handler) },
            onTerminalExit: handler => { route.terminalExit.add(handler) },
            claimSession: sessionId => { claim(route, sessionId) },
          })
          const runner = new AcpTurnRunner(port, {
            cwd: opts.cwd,
            dshSessionId: opts.dshSessionId,
            dialect: opts.dialect,
            ...(opts.modeId === undefined ? {} : { modeId: opts.modeId }),
            ...(opts.modelId === undefined ? {} : { modelId: opts.modelId }),
            ...(opts.openTimeoutMs === undefined ? {} : { openTimeoutMs: opts.openTimeoutMs }),
            ...(opts.primer === undefined ? {} : { primer: opts.primer }),
            ...(opts.replay === undefined ? {} : { replay: opts.replay }),
            ...(opts.resumeOf === undefined ? {} : { resumeOf: opts.resumeOf }),
            ...(deps.subagents === undefined ? {} : { subagents: deps.subagents }),
            ...(deps.onRuntimeModels === undefined ? {} : { onModels: (models: readonly { id: string; name: string; description?: string }[]) => { deps.onRuntimeModels!(presetId, models) } }),
            ...(opts.stopsTurns && opts.abort !== undefined ? { abort: opts.abort } : {}),
          })
          const acpSession: AcpSession = {
            run: async (decision, turn) => await runner.run(decision, turn),
            runSteps: (decision, turn, at) => runner.runSteps(decision, turn, at),
            close: () => {
              sessionRunners.delete(opts.dshSessionId)
              sessionDeathHandlers.delete(opts.dshSessionId)
              routeByDsh.delete(opts.dshSessionId)
              disposeRoute(route)
              // When the last session on this shared agent leaves, kill the
              // transport to avoid leaking a process for an idle preset.
              if (sessionRunners.size === 0 && alive) {
                alive = false
                progressProbe?.close()
                transport.close()
              }
            },
            onDead: handler => {
              sessionDeathHandlers.set(opts.dshSessionId, handler)
            },
            diagnostics: () => {
              const lastStatus = runner.lastStatusSnapshot()
              return {
                // 这条会话自己的信标：同一连接上别的会话有帧，不代表这条在动。
                lastFrameAt: route.lastFrameAt,
                lastDiagnosticAt: transport.lastDiagnosticAt(),
                stderrTail: transport.stderrTail(),
                liveDelegatedRuns: runner.liveDelegatedRuns(),
                ...(lastStatus === undefined ? {} : { lastStatus }),
                ...(progressProbe === undefined ? {} : {
                  progress: () => {
                    const external = runner.externalSessionId()
                    return external === undefined ? undefined : progressProbe.read(external)
                  },
                }),
              }
            },
          }
          sessionRunners.set(opts.dshSessionId, acpSession)
          routeByDsh.set(opts.dshSessionId, route)
          return acpSession
        },

        kill: (reason: string) => {
          if (!alive) return
          alive = false
          progressProbe?.close()
          transport.close()
          for (const route of [...routes]) disposeRoute(route)
          for (const handler of sessionDeathHandlers.values()) handler(reason)
          sessionDeathHandlers.clear()
          sessionRunners.clear()
          routeByDsh.clear()
        },

        dropSession: (dshSessionId: string) => {
          sessionRunners.delete(dshSessionId)
          sessionDeathHandlers.delete(dshSessionId)
          const route = routeByDsh.get(dshSessionId)
          if (route !== undefined) {
            routeByDsh.delete(dshSessionId)
            disposeRoute(route)
          }
        },

        sessionIds: () => Array.from(sessionRunners.keys()),
      }

      // Watch for transport death — propagate to all sessions with the actual reason
      transport.onDeath(reason => {
        if (!alive) return
        alive = false
        progressProbe?.close()
        for (const route of [...routes]) disposeRoute(route)
        for (const handler of sessionDeathHandlers.values()) handler(reason)
        sessionDeathHandlers.clear()
        sessionRunners.clear()
        routeByDsh.clear()
      })

      return sharedAgent
    },
  }
}

/**
 * The parts of the port a shared connection replaces.
 *
 * On a client serving one conversation the default wiring is right: every
 * frame and every terminal belongs to the one runner. A shared client needs
 * each of those seams pointed at the owning session instead.
 */
export type ClientPortOverrides = {
  request?(method: string, params: unknown): Promise<unknown>
  onFrame?(handler: (frame: AcpFrame) => void): void
  onTerminalOutput?(handler: (terminalId: string, data: string) => void): void
  onTerminalExit?(handler: (terminalId: string, exitCode: number) => void): void
  claimSession?(sessionId: string): void
}

/**
 * Present the ACP client as the incremental frame port the runner expects.
 *
 * The runner installs one handler at construction; every inbound frame then
 * reaches it as it lands, which is what lets text reach the UI while the agent
 * is still working.
 */
export function adaptClient(client: AcpClient, dialect: AcpDialect, overrides?: ClientPortOverrides): AcpClientPort {
  const request = overrides?.request ?? ((method: string, params: unknown) => client.request(method, params))
  return {
    request,
    notify: (method, params) => { client.notify(method, params) },
    onFrame: overrides?.onFrame ?? (handler => { client.onFrame(frame => { handler(frame) }) }),
    onTerminalOutput: overrides?.onTerminalOutput ?? (handler => { client.onTerminalOutput = handler }),
    onTerminalExit: overrides?.onTerminalExit ?? (handler => { client.onTerminalExit = handler }),
    ...(overrides?.claimSession === undefined ? {} : { claimSession: overrides.claimSession }),
    // Cursor must authenticate (after an interactive `agent login`) before
    // session/new; qoder derives its own method id (CN and international builds
    // differ) from the initialize reply and authenticates only when
    // session/new refuses. The runner owns WHEN; this owns WHAT to send.
    ...(dialect.authenticateMethodId === undefined && dialect.authenticateMethodIdFrom === undefined
      ? {}
      : {
          authenticate: (initializeResult: unknown) => {
            const methodId = dialect.authenticateMethodId ?? dialect.authenticateMethodIdFrom?.(initializeResult)
            return methodId === undefined
              ? Promise.resolve(undefined)
              : request('authenticate', { methodId })
          },
        }),
  }
}
