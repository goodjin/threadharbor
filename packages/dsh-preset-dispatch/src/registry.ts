/**
 * Turning configuration into the preset table the dispatcher consults.
 *
 * Only ACP presets belong in this table, and a native preset must be **absent**
 * rather than present-and-skipped: absence is what lets the dispatcher leave
 * those sessions completely alone, with nothing left to forget.
 */

import type { AcpDialect } from '@threadharbor/dsh-acp-agent'
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
 * One agent is opened per session on first use and reused after — opening is
 * the expensive part, and a DSH session runs many turns. When a connection
 * dies, its cached session is dropped here and the next turn opens a fresh
 * one: the host heals on its own, with no instruction from the page.
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
    // One external conversation per DSH session, not per preset.
    //
    // Sharing one across sessions is the original bug: two conversations in
    // the same preset land in the same external session, so each one's answer
    // shows up in the other's history. The keys are session ids, and a session
    // whose connection dies drops its entry with it (see the onDead hookup).
    // Open-and-cache is shared by `run` and `runSteps` on purpose: the takeover
    // path iterates one external turn across several calls, and a reopen
    // between segments would scatter the conversation's context.
    const opened = new Map<string, AcpSession>()
    sessions.set(presetId, opened)
    const sessionFor = async (sessionId: string, abort: (() => AbortSignal | undefined) | undefined): Promise<AcpSession> => {
      let session = opened.get(sessionId)
      if (session === undefined) {
        session = await factory.open(presetId, {
          cwd: cwdForOpen(options.cwdOfSession?.(sessionId)),
          // Named so the opened client can put the host session on any
          // question it asks the human — the session host services resolve
          // an agent by.
          dshSessionId: sessionId,
          ...(preset.model === undefined ? {} : { modelId: preset.model }),
          ...(preset.mode === undefined ? {} : { modeId: preset.mode }),
          ...(options.primer === undefined ? {} : { primer: options.primer }),
          ...(options.replay === undefined ? {} : { replay: options.replay }),
          // The turn's stop signal, as a getter the runner consults per turn,
          // and only when the dialect claims the capability. The getter
          // closes over the agent, not over this turn, so the one entry
          // stored here at open stays correct for every later turn of the
          // session — each turn's signal is read live, when the turn runs.
          ...(stopsTurns && abort !== undefined ? { abort } : {}),
        })
        session.onDead(reason => {
          // Drop only this session's entry: another session's connection is
          // a different socket and stays exactly as alive as it is.
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