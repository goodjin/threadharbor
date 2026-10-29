/**
 * Turning configuration into the preset table the dispatcher consults.
 *
 * Only ACP presets belong in this table, and a native preset must be **absent**
 * rather than present-and-skipped: absence is what lets the dispatcher leave
 * those sessions completely alone, with nothing left to forget.
 */

import type { AcpDialect, SessionStatusSnapshot } from '@threadharbor/dsh-acp-agent'
import type { ProgressReading } from './agent-progress.ts'
import type { AcpPresetBinding } from './dispatch.ts'
import type { RunnerOptions } from './runner.ts'

/** One configured external agent. */
export type AcpPresetConfig = {
  /** Which agent this is; picks the frame dialect. */
  readonly agent?: string
  /** WebSocket URL, for agents that expose one. */
  readonly url?: string
  /** Command to spawn, for agents that run as a child process. */
  readonly command?: string
  /**
   * Arguments that command is spawned with, when the defaults are not what this
   * deployment needs.
   *
   * Absent means the factory's per-agent default (see `stdioArgsFor`) — which is
   * what makes an agent that needs a subcommand speak ACP without every preset
   * repeating it. Set it to take the whole command line over: an endpoint, a key
   * or a different auth path changes the arguments the agent expects, and an
   * operator who names them knows better than a table.
   */
  readonly args?: readonly string[]
  readonly model?: string
  readonly mode?: string
  /**
   * Accepted so an old config still loads. Never used as a workspace.
   *
   * An external conversation opens only in the DSH session's own workspace.
   * A directory pinned here used to send every project into one folder, and
   * this process's directory is not a workspace either.
   */
  readonly cwd?: string
  /**
   * Watchdog limits for an in-place answer on this preset, in milliseconds.
   *
   * `stallMs` ends a turn whose agent sent no FRAME for that long — stderr
   * warnings do not count, because a backend wedged in its own retry loop
   * keeps printing them (2026-10-16 codex: "tls handshake eof" for ten
   * minutes while every stop press vanished into it). `totalMs` ends any
   * answer that runs past it however chatty it is. `warnMs` writes one
   * status note when frame silence crosses it. `graceMs` is how long a user
   * stop waits for the agent to settle before the process is killed.
   *
   * Absent fields fall back to the gateway's defaults; `0` disables that one
   * behavior (`totalMs` 0 = unlimited).
   */
  readonly stallMs?: number
  readonly totalMs?: number
  readonly warnMs?: number
  readonly graceMs?: number
  /**
   * Deprecated alias for `stallMs` — both are frame-silence deadlines. Kept
   * so existing preset rows keep their meaning; new rows use `stallMs`.
   */
  readonly answerTimeoutMs?: number
  /**
   * The models this agent serves, as offered in the model picker.
   *
   * Declared rather than probed: probing needs the agent to be running, and the
   * picker has to render before anyone has opened a session. An absent list
   * means the agent offers nothing here yet. `contextWindow`, when declared,
   * is the only number a switch may refuse on — a window nobody declared never
   * refuses a handover.
   */
  readonly models?: readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly contextWindow?: number
  }[]
  /**
   * Hosts this preset is offered on.
   *
   * Absent means everywhere — adding a constraint is opt-in. An empty list is
   * a deliberate "off", which is how a preset gets disabled without deleting it.
   */
  readonly hosts?: readonly string[]
  /**
   * Whether the catalog may collapse same-base `[effort]` model ids into one
   * row plus a reasoning axis.
   *
   * True (the default) for codex/claude, whose `base[effort]` ids are genuinely
   * one model at different efforts. False for cursor, whose `modelId` carries a
   * config suffix (`grok-4.7[context=256k,reasoning_effort=high,fast=true]`)
   * that is a distinct configuration, not an effort axis — collapsing would
   * merge different configs into one row.
   */
  readonly collapseEfforts?: boolean
}

export type PresetConfig = { readonly presets: Readonly<Record<string, AcpPresetConfig>> }

/** What one session needs from an opened agent. */
export type AcpSession = {
  run: AcpPresetBinding['run']
  /**
   * 按段驱动一个外部回合，可选。
   *
   * 接管路径一段一次调用：first=true 的调用承担回合级职责（开外部会话、组装
   * 发送 prompt），返回 null 表示回合未完、原生循环会补上下一步边界再调；末段
   * 才返回真实结束原因。缺省（自备工厂、旧测试桩）时 binding 回落单发 run，
   * 把其结束原因当末段返回——对外表现与单步一致。
   */
  runSteps?: AcpPresetBinding['runSteps']
  /**
   * Drop this external conversation.
   *
   * Needed because restarting has to actually let go: a cached client keeps
   * the old connection, and the next turn would reuse the agent that is hung.
   */
  close(): void
  /**
   * Learn that the connection died under this session.
   *
   * The frame stream has nothing to say when a socket or child process goes
   * away — the transport's death callback is the one event that names it. The
   * registry listens so it can drop the cached session itself: a cached dead
   * connection would otherwise be handed back on every later turn, and fixing
   * that used to require a restart command that reached the host from the
   * browser — a command that could never be delivered.
   */
  onDead(handler: (reason: string) => void): void
  /**
   * The agent's liveness signals, read live: frame progress apart from stderr
   * diagnostics. A stall watchdog resets on frames only — a retry loop that
   * keeps logging warnings is silent by this measure, and that is the point.
   */
  diagnostics(): AcpSessionDiagnostics
}

/** What `AcpSession.diagnostics()` returns, straight from the transport. */
export type AcpSessionDiagnostics = {
  /** Epoch ms of the last frame the agent sent — the progress stamp. */
  readonly lastFrameAt: number
  /** Epoch ms of the last stderr line — diagnostics, never progress. */
  readonly lastDiagnosticAt: number
  /** The agent's last stderr lines, oldest first. */
  readonly stderrTail: readonly string[]
  /**
   * 外部 agent 自己的委托运行（子代理 / 后台任务）当前还开着几个。
   *
   * 缺席按 0 读：一个没有这条的宿主只会失去「等子代理时让总上限让路」这一条，
   * 不会失去别的（0 与「没有子代理」同义）。
   */
  readonly liveDelegatedRuns?: number
  /**
   * 外部 agent 最后上报的状态（active/idle、压缩上下文、模式切换……）。
   *
   * 看门狗只用它把话说清楚：停的时候它在干什么。缺席按 undefined 读——没有
   * 状态信号只失去一句解释，不失去看门狗本身。
   */
  readonly lastStatus?: SessionStatusSnapshot
  /**
   * 日志层的增量进度：帧静默时（codex 压缩上下文）仍能看见它在推进。
   *
   * 每次调用推进内部游标；没有新进展返回 undefined。有读数时调用方应重计
   * 静默期限——这就是「没帧也算活着」的那条信号。缺席表示该 agent 没有这层
   * 信号（目前只有 codex 有）。
   */
  readonly progress?: () => ProgressReading | undefined
}

/**
 * A shared agent process: one transport + client, serving multiple DSH sessions
 * each with their own ACP session.
 *
 * Created once per preset (on first use), reused by all DSH sessions on that
 * preset. Each DSH session opens its own `session/new` (or `session/resume`)
 * on the shared connection, keeping conversation histories isolated.
 */
export type SharedAgent = {
  /**
   * Open a new ACP session on this shared agent for one DSH session.
   *
   * Each call creates a new runner that will `session/new` or `session/resume`
   * on the shared client. The returned `AcpSession` is scoped to one DSH
   * session but rides the shared transport.
   */
  openSession(options: OpenSessionOptions): Promise<AcpSession>
  /**
   * Kill the transport and mark this agent as dead.
   *
   * The next call to `openSession` (or `revive`) will spawn a fresh process
   * and resume all cached sessions via `session/resume`.
   */
  kill(reason: string): void
  /**
   * Whether this shared agent's transport is still alive.
   */
  readonly alive: boolean
  /**
   * Drop one DSH session's runner from the shared agent (e.g. on session
   * archive). The transport stays alive for other sessions.
   */
  dropSession(dshSessionId: string): void
  /**
   * All DSH session ids currently holding a runner on this shared agent.
   */
  sessionIds(): readonly string[]
}

/** Options for opening a session on a shared agent. */
export type OpenSessionOptions = {
  /** The DSH session id this external conversation belongs to. */
  readonly dshSessionId: string
  /** The project directory for this session's workspace. */
  readonly cwd: string
  /** Applied once, before the first turn; claude needs `default` to ask at all. */
  readonly modeId?: string
  readonly modelId?: string
  /** How long to wait for the agent to open a session before giving up. */
  readonly openTimeoutMs?: number
  readonly dialect: AcpDialect
  /** Conversation handed over from another session by a switch. */
  readonly primer?: {
    take(sessionId: string): string | undefined
    restore(sessionId: string, text: string): void
  }
  /** This session's earlier conversation, read from the host's own transcript. */
  readonly replay?: {
    take(sessionId: string): string | undefined
  }
  /**
   * A journaled external session id to reattach to (`session/resume`, or
   * `session/load` for a dialect that only implements loading).
   * When present and the dialect supports it, the runner reattaches instead
   * of opening fresh.
   */
  readonly resumeOf?: (dshSessionId: string) => string | undefined
  /** Whether the agent can be stopped at all (capability table). */
  readonly stopsTurns?: boolean
  /** A getter the runner consults per turn for the stop signal. */
  readonly abort?: () => AbortSignal | undefined
  /** Called when the agent reports its model list after opening. */
  readonly onModels?: (models: readonly { id: string; name: string; description?: string }[]) => void
  /** Subagent session host, when composed. */
  readonly subagents?: import('./subagent-sessions.ts').SubagentSessionHost
}

/** How an agent is reached; separate so tests can stand in for spawning. */
export type AcpSessionFactory = {
  /**
   * The frame dialect for one preset, or `undefined` for an agent this plugin
   * does not handle.
   *
   * The check is on the **agent**, not on the preset being configured. A native
   * preset listed here would otherwise be taken over by accident, and native
   * sessions are the one thing that must never change.
   */
  dialectFor(presetId: string, config: AcpPresetConfig): AcpDialect | undefined
  /**
   * Open a shared agent process for one preset: spawn the transport, perform
   * the ACP handshake (`initialize` + `initialized` + optional `authenticate`),
   * and return a handle that can serve multiple DSH sessions.
   *
   * Called once per preset (on first use), reused by all sessions on that preset.
   */
  openShared(presetId: string): Promise<SharedAgent>
  /** Open the agent for one DSH session. Called once per session. */
  open(presetId: string, options: RunnerOptions): Promise<AcpSession>
}

/**
 * Build the preset table.
 *
 * One agent is opened per session on first use and reused after — opening is
 * the expensive part, and a DSH session runs many turns.
 */
export type SessionRegistry = Map<string, Map<string, AcpSession>>

/** A fresh place to keep open conversations, for restart to clear. */
export function sessionsRegistry(): SessionRegistry {
  return new Map<string, Map<string, AcpSession>>()
}

/** What the caller wants said when a dead connection is dropped. */
export type SessionDropEvent = {
  readonly presetId: string
  /** The DSH session whose external connection died. */
  readonly sessionId: string
  readonly reason: string
}

export type PresetTableOptions = {
  /**
   * Said when a connection death drops a cached session.
   *
   * Optional because the drop is correct whether or not anyone is listening;
   * a caller that can log passes a sink here so a self-heal stays visible.
   */
  readonly onDropped?: (event: SessionDropEvent) => void
  /**
   * Handed-over conversations keyed by session, consumed by a new session's
   * first model request.
   *
   * Optional so a table can be built without one (standalone attaches); the
   * mounted rows pass the shared switch fabric, because a switch started by
   * one row continues in a session another row drives.
   */
  readonly primer?: {
    take(sessionId: string): string | undefined
    restore(sessionId: string, text: string): void
  }
  /**
   * Session transcripts keyed by session, read for a fresh external
   * conversation's first request.
   *
   * Where the primer carries a conversation handed over by a switch, this one
   * re-reads what the session itself still holds — the history an external
   * conversation lost when its connection went away. Optional like the primer:
   * a table built without one opens sessions that start from the question
   * alone, exactly as before.
   */
  readonly replay?: {
    take(sessionId: string): string | undefined
  }
  /**
   * A journaled external session id to reattach to, per DSH session.
   *
   * When present and the dialect supports `session/resume` or
   * `session/load`, the runner reattaches to the server-side conversation
   * instead of opening fresh.
   */
  readonly resumeOf?: (dshSessionId: string) => string | undefined
  /**
   * The project directory of one DSH session, when the host can name it.
   *
   * A new external conversation opens there and nowhere else. No directory
   * means this session has no workspace, and the open is refused.
   */
  readonly cwdOfSession?: (sessionId: string) => string | undefined
}

/**
 * The workspace a new external conversation may open in.
 *
 * Only the session's own directory counts. A preset directory and this
 * process's directory are not workspaces, so a session that names neither
 * is refused instead of being parked in one of them.
 */
export function cwdForOpen(sessionCwd: string | undefined): string {
  if (typeof sessionCwd === 'string' && sessionCwd !== '') return sessionCwd
  throw new Error('这个会话没有工作区，外部会话不会在预设目录或宿主进程目录里开工')
}

/**
 * Build the preset table.
 *
 * One agent process is shared per preset on first use and reused by all DSH
 * sessions on that preset. Each DSH session opens its own ACP session
 * (`session/new` or `session/resume`) on the shared connection, keeping
 * conversation histories isolated. When a connection dies, the shared agent
 * is revived on next use: a fresh process spawns and all cached sessions
 * reattach via `session/resume` (or fall back to text replay).
 */
export function buildPresetTable(
  config: PresetConfig,
  factory: AcpSessionFactory,
  sessions: SessionRegistry,
  options: PresetTableOptions = {},
): Map<string, AcpPresetBinding> {
  const table = new Map<string, AcpPresetBinding>()
  for (const [presetId, preset] of Object.entries(config.presets)) {
    if (preset.agent === undefined) continue
    const dialect = factory.dialectFor(presetId, preset)
    // Not an agent we drive: leave whatever that preset is entirely alone.
    if (dialect === undefined) continue
    // The capability table decides whether this agent can be stopped at all:
    // a dialect that does not declare `cancelsTurns` gets no cancel notice,
    // keeping the table the single source of truth for what an agent can do.
    const stopsTurns = dialect.capabilities?.cancelsTurns === true
    // One shared agent process per preset, serving all DSH sessions on it.
    //
    // Each DSH session gets its own ACP session (session/new, or the journaled
    // one via session/resume or session/load) on the shared connection, so
    // conversation histories stay isolated. When the process dies, the shared
    // agent is revived on next use: a fresh process spawns and all journaled
    // sessions reattach.
    const opened = new Map<string, AcpSession>()
    sessions.set(presetId, opened)
    let sharedAgent: SharedAgent | undefined
    const sessionFor = async (sessionId: string, abort: (() => AbortSignal | undefined) | undefined): Promise<AcpSession> => {
      let session = opened.get(sessionId)
      if (session === undefined) {
        // Lazily create the shared agent on first session open
        if (sharedAgent === undefined || !sharedAgent.alive) {
          if (sharedAgent !== undefined) {
            // Previous agent died; revive it
            options.onDropped?.({ presetId, sessionId, reason: 'shared agent died — reviving' })
          }
          sharedAgent = await factory.openShared(presetId)
        }
        session = await sharedAgent.openSession({
          dshSessionId: sessionId,
          cwd: cwdForOpen(options.cwdOfSession?.(sessionId)),
          ...(preset.model === undefined ? {} : { modelId: preset.model }),
          ...(preset.mode === undefined ? {} : { modeId: preset.mode }),
          ...(options.primer === undefined ? {} : { primer: options.primer }),
          ...(options.replay === undefined ? {} : { replay: options.replay }),
          ...(stopsTurns && abort !== undefined ? { abort } : {}),
          dialect,
          ...(options.resumeOf === undefined ? {} : { resumeOf: options.resumeOf }),
        })
        session.onDead(reason => {
          // Drop only this session's entry from the cache. The shared agent
          // may still be alive for other sessions; if it died too, the next
          // sessionFor call will revive it.
          if (opened.get(sessionId) === session) opened.delete(sessionId)
          options.onDropped?.({ presetId, sessionId, reason })
        })
        opened.set(sessionId, session)
      }
      return session
    }
    table.set(presetId, {
      dialect,
      run: async (decision, turn) => (await sessionFor(turn.sessionId, turn.abort)).run(decision, turn),
      runSteps: async (decision, turn, at) => {
        const session = await sessionFor(turn.sessionId, turn.abort)
        // 会话对象没带 runSteps（自备工厂、旧测试桩）：回落单发 run——一次调用
        // 跑完整个回合，其结束原因就是末段的结束原因。
        return session.runSteps !== undefined
          ? session.runSteps(decision, turn, at)
          : (await session.run(decision, turn)).end
      },
      restart: async () => {
        // Kill the shared agent and drop all cached sessions. The next turn
        // for any session on this preset will spawn a fresh process and
        // reattach via session/resume or session/load (or fall back to text
        // replay).
        if (sharedAgent !== undefined && sharedAgent.alive) {
          sharedAgent.kill('manual restart')
        }
        opened.clear()
        sharedAgent = undefined
        options.onDropped?.({ presetId, sessionId: '*', reason: 'manual restart' })
      },
    })
  }
  return table
}

/** The open conversations per preset, so a teardown can find and drop them. */
export function openSessionsOf(
  sessions: ReadonlyMap<string, Map<string, AcpSession>>,
  presetId: string,
): ReadonlyMap<string, AcpSession> {
  return sessions.get(presetId) ?? new Map<string, AcpSession>()
}