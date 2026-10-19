/**
 * The plugin that actually runs inside a preset.
 *
 * An agent preset is a composition: selecting one mounts its rows. So an
 * external agent's behaviour has to come from a row inside that composition —
 * which is what this entry is. One row per agent, configured with that agent's
 * transport and dialect.
 *
 * The scope is the filter. A row only sees the agents mounted alongside it, so
 * a session on some other preset is never seen here and keeps its own behaviour
 * with nothing to undo.
 *
 * No imports from the DSH runtime packages, for the reason the rest of this
 * package avoids them: the published versions lag far behind what runs, and the
 * classes involved cannot be imported at all. So this states the one event it
 * listens for and the shape it needs, and the caller adapts.
 */

import { holdsAcpDispatch, presetIdOf } from './dispatch.ts'
import type { AgentLike, PresetResolver, StepPosition } from './dispatch.ts'
import type {
  AskQuestionAnswer,
  AskQuestionRequest,
  PermissionDecision,
  PermissionRequest,
} from '@threadharbor/dsh-acp-agent'
import { projectStepContent } from '@threadharbor/dsh-acp-agent'
import { buildPresetTable, cwdForOpen, openSessionsOf, sessionsRegistry } from './registry.ts'
import type { AcpPresetConfig, PresetConfig } from './registry.ts'
import { makeSessionFactory } from './factory.ts'
import { forgetSession, stepPositionOfSession } from './step-position.ts'
import { modelsOfPreset, registerCatalog, runtimeModels } from './catalog-registration.ts'
import { cwdOfSession, servicesOf } from './switch-mount.ts'
import { GatewayConversations } from './gateway.ts'
import type { GatewaySessionAppend } from './gateway.ts'
import { followModelSelection, followPresetSelection } from './follow.ts'
import { switchShared } from './switch-shared.ts'
import { selectionOf } from './selection.ts'
import type { CatalogDeps } from './catalog.ts'
import { zcodeModelStream } from './zcode-model.ts'
import type { AcpPresetBinding } from './dispatch.ts'
import type { AcpDialect, AcpTransport } from '@threadharbor/dsh-acp-agent'

/** The part of a Cordis context this entry touches. */
export type AcpPluginContext = {
  on(event: 'agent/created', handler: (payload: { agent: unknown }) => void): unknown
  /**
   * The session event stream. A preset chosen after the agent exists — the
   * interface's preset selector on a blank session — only rebinds the agent's
   * scope and appends `agent-preset/selected`; `agent/created` never fires
   * again, so this event is the only signal a takeover can pick up.
   */
  on(event: 'session/event', handler: (
    session: unknown,
    event: { readonly type: unknown; readonly data: unknown },
  ) => void): unknown
  /**
   * The Workspace registry's stop request for one session's work — dispatched
   * when a session is archived with its activity still running, among other
   * callers. The row listens so the external connection does not outlive the
   * session that stopped.
   */
  on(event: 'workspace/session-stop', handler: (payload: { sessionId: unknown }) => void): unknown
  /**
   * Read a host service by name; how this row reaches the model registry and
   * the switch services. Optional: a host offering neither still mounts, and
   * the pieces that need them say so loudly when they are asked.
   */
  get?(key: string): unknown
}

/** What the caller supplies, since the DSH-facing pieces stay behind ports. */
export type AcpPluginDeps = {
  /**
   * Take the session over: patch its step so the external agent drives it.
   *
   * Handed the dialect that was resolved, so the caller need not re-derive it.
   */
  install(agent: AgentLike, presetId: string, dialect: AcpDialect, table: ReadonlyMap<string, AcpPresetBinding>): void
  /**
   * Ask the host whether an action is allowed.
   *
   * Omitted when the host has nowhere to ask, in which case every request is
   * refused.
   */
  answerPermission?(request: PermissionRequest): Promise<PermissionDecision>
  /**
   * Put the agent's question in front of a human.
   *
   * Omitted when the host has no question service, in which case the agent's
   * question keeps its benign auto-answer.
   */
  answerAskQuestion?(request: AskQuestionRequest): Promise<AskQuestionAnswer>
  /**
   * Say what went wrong on a session this row claimed.
   *
   * Optional because most callers only care that a session was or was not taken
   * over — but a row that cannot report is a row that fails quietly.
   */
  report?(message: string): void
  /**
   * 外部子代理的影子子会话端口（宿主有会话存储与子代理能力包时提供）。
   *
   * 缺席时只留父会话卡片，泵内不写任何子会话事件。
   */
  subagents?: import('./subagent-sessions.ts').SubagentSessionHost
  /**
   * Read a DSH session's open turn and step straight from its session log.
   *
   * The row's context is scoped to the agents mounted with it, so sessions the
   * in-place gateway answers for never deliver their `agent/pre-step` notice
   * here; this seam reads the boundaries from the store instead. Optional: a
   * host with no session store keeps answering, only without tool cards.
   */
  sessionPositionOf?(sessionId: string): StepPosition | undefined
  /**
   * Register the exit cleaner that closes every external conversation when
   * this process ends.
   *
   * Optional seam: the default hooks Node's `exit` event. A normal shutdown —
   * including a default-handled SIGTERM — then kills the spawned children
   * instead of leaking them (2026-10-16: a restart left a grok child retrying
   * on its own for 12 minutes). SIGKILL outruns any in-process hook; that
   * case belongs to the supervisor, not this row.
   */
  onExit?(clean: () => void): void
  /**
   * Which preset a session is on right now.
   *
   * The header records the preset a session was *created* with, so reading it
   * can take over a session that has since moved on, or run a native session
   * as though it were ours. DSH reads the projection; supply that when it is
   * available and the header only as a fallback.
   */
  presetOf?: PresetResolver | undefined
  /**
   * The session log writer for a DSH session, for the in-place answer path.
   *
   * An external agent's tool events are log-only and carry no chunk the native
   * loop could assemble from, so on the in-place path this is the only thing
   * that can record them. Optional: a host without a session store still gets
   * answers, just with no tool cards.
   */
  sessionAppend?: GatewaySessionAppend | undefined
  /**
   * Build the transport a preset connects over.
   *
   * Optional and aimed at tests: the default is the preset's own URL or
   * command, which is what every real deployment wants.
   */
  transport?(preset: { url?: string; command?: string }): AcpTransport
}

/**
 * The project directory of one live session, or undefined when this host
 * cannot name it.
 *
 * A store that throws on an unknown id is the same as a missing session.
 * Either way the open is refused: there is no other directory to use.
 */
function projectDirectory(ctx: object, sessionId: string): string | undefined {
  const read = servicesOf(ctx).sessions
  if (read === undefined) return undefined
  try {
    return cwdOfSession(read(sessionId))
  } catch {
    return undefined
  }
}

/**
 * Take over ACP-backed sessions in this plugin's scope.
 *
 * One session failing must not take the rest with it: `agent/created` is awaited
 * before the agent reaches the loop, so a throw here would strand that one
 * session with no step at all.
 */
export function applyAcpPlugin(
  ctx: AcpPluginContext,
  presetId: string,
  config: AcpPresetConfig,
  deps: AcpPluginDeps,
): void {
  // Old rows still name a cwd. Say so once and then ignore it: using it
  // would put every project's new conversation in that one folder.
  if (config.cwd !== undefined) {
    deps.report?.(`acp ${presetId}: 配置里的 cwd 已忽略，外部会话只用会话自己的工作区`)
  }
  const presets: PresetConfig = { presets: { [presetId]: config } }
  // The ledger the factory feeds and the catalog reads, created BEFORE the
  // factory so the wiring below can hand both ends the same object. Created
  // here rather than left to the standalone entry because this is the function
  // the loaded entry actually calls — a report recorded anywhere else is the
  // catalogue bug again: the runner would drop every `session/new` model list
  // and `listModels` would silently degrade to the configured list forever.
  const runtimeModelReports = runtimeModels()
  const factory = makeSessionFactory(presets, {
    // Refusing without asking is the safe default and the honest one when there
    // is nowhere to ask. Where there IS a host that answers, use it — a row
    // that decides every permission for itself makes a capable agent look
    // untrustworthy, and leaves nothing on screen to explain why.
    answerPermission: request => (deps.answerPermission === undefined
      ? Promise.resolve({ outcome: 'reject' })
      : deps.answerPermission(request)),
    ...(deps.answerAskQuestion === undefined ? {} : { answerAskQuestion: deps.answerAskQuestion }),
    ...(deps.transport === undefined ? {} : { transport: deps.transport }),
    onRuntimeModels: (reportedPresetId, models) => { runtimeModelReports.record(reportedPresetId, models) },
    ...(deps.subagents === undefined ? {} : { subagents: deps.subagents }),
  })
  const dialect = factory.dialectFor(presetId, config)
  // zcode is a model inside the native loop: it still registers, and it does
  // not take the step over. An unknown agent is a configuration mistake, and
  // taking those sessions over would hand them to a dialect that does not
  // exist; better to leave them on the native agent, where they still work.
  const modelBacked = config.agent === 'zcode'
  if (dialect === undefined && !modelBacked) return
  // The models this preset offers the picker — the same list the host's model
  // selector reads, and the list the preset→model follow selects from.
  const pickerModels = modelsOfPreset(presets, factory, presetId)
  // Shared switch fabric: this row's presence and its models go in, so a
  // switch started by ANY row can plan against what this host actually
  // mounts, and its primer goes out, so this row's sessions consume the
  // conversation a switch from another row handed them. The session-liveness
  // reader is wired from the same services the switch chain itself uses.
  switchShared.registerPreset(presetId, config, pickerModels.map(model => ({
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  })))
  switchShared.wireSessions(sessionId => {
    const read = servicesOf(ctx).sessions
    return read === undefined ? undefined : read(sessionId)
  })
  const sessions = sessionsRegistry()
  const table = buildPresetTable(presets, factory, sessions, {
    // A connection death dropping its cached session is the host healing on
    // its own; said here so a self-heal is visible in the row's report instead
    // of being indistinguishable from nothing having happened.
    onDropped: ({ sessionId, reason }) => {
      deps.report?.(`acp ${presetId}: session ${sessionId}'s connection died (${reason}) — dropped; the next turn opens a fresh one`)
    },
    // Handed-over conversations from switches other rows made into this
    // preset: consumed by the new session's first model request. The shared
    // fabric speaks the fuller switch vocabulary; the table needs only the
    // primer half.
    primer: {
      take: sessionId => switchShared.takeHandover(sessionId),
      restore: (sessionId, text) => switchShared.restoreHandover(sessionId, text),
    },
    // The session's own transcript, for a first request whose external
    // conversation starts empty — a host restart lost the connection but not
    // the log. Read through the same shared fabric that wired the session
    // reader; a host without it replays nothing and the turn runs as before.
    replay: {
      take: sessionId => switchShared.replayPrimer(sessionId),
    },
    // The session's project directory, not the directory this process was
    // started in and not a directory pinned on the preset.
    cwdOfSession: sessionId => projectDirectory(ctx, sessionId),
  })
  // What makes the external agent's models appear in the host's own model
  // picker: the catalog is global to this Host generation and already read by
  // it. Mounted here rather than left to the standalone entry, because this is
  // the function the loaded entry actually calls — a registration anywhere
  // else is the catalogue bug again. Silent when the host has no registry; the
  // picker then simply shows nothing of ours.
  //
  // The picker's list reads the agent's own `session/new` report once a
  // session has opened (the runner feeds the ledger above through the
  // factory); until then it degrades to the configured list, so a working
  // agent never shows an empty group just because nobody has asked it a
  // question yet.
  const catalogDeps: CatalogDeps = {
    modelsOf: presetId => modelsOfPreset(presets, factory, presetId),
    runtimeModelsOf: presetId => runtimeModelReports.modelsOf(presetId),
    dialectOf: presetId => table.get(presetId)?.dialect,
    modelStream: zcodeModelStream(presets),
  }
  // A model request landing on one of these routes for a session this row does
  // not drive is answered in place: the gateway borrows the agent as a model,
  // keeps one external conversation per session, and its answer arrives as
  // this model's own chunk stream. The conversation never moves.
  const gateway = new GatewayConversations(
    async (presetId, options) => await factory.open(presetId, {
      cwd: cwdForOpen(projectDirectory(ctx, options.dshSessionId)),
      dshSessionId: options.dshSessionId,
      primer: options.primer,
      ...(presets.presets[presetId]?.model === undefined ? {} : { modelId: presets.presets[presetId]?.model }),
      ...(presets.presets[presetId]?.mode === undefined ? {} : { modeId: presets.presets[presetId]?.mode }),
    }),
    message => { deps.report?.(message) },
    deps.sessionAppend,
    // The open turn and step, as the loop announced them. The gateway writes
    // tool events outside a replaced step, so it has nowhere else to learn them:
    // without a real pair the session log records a number that fails to match
    // the open turn when the session is next opened.
    sessionId => {
      // The announced position first (takeover sessions deliver their
      // pre-step notice); the session log answers for everyone else — the
      // row's scoped context never sees foreign sessions' notices.
      return stepPositionOfSession(sessionId) ?? deps.sessionPositionOf?.(sessionId)
    },
    // Watchdog limits per preset. answerTimeoutMs stays as a deprecated
    // alias for stallMs — both are frame-silence deadlines, so an existing
    // 600000 keeps its meaning instead of silently becoming 120000.
    presetId => {
      const preset = presets.presets[presetId]
      if (preset === undefined) return {}
      return {
        ...(preset.stallMs === undefined && preset.answerTimeoutMs === undefined
          ? {}
          : { stallMs: preset.stallMs ?? preset.answerTimeoutMs }),
        ...(preset.totalMs === undefined ? {} : { totalMs: preset.totalMs }),
        ...(preset.warnMs === undefined ? {} : { warnMs: preset.warnMs }),
        ...(preset.graceMs === undefined ? {} : { graceMs: preset.graceMs }),
      }
    },
    // The turn-end projection, so a tool's RESULT reaches the session log:
    // live cards carry only the call, and an unresolved call makes the whole
    // session unloadable (2026-10-17 session 423817a9).
    presetId => {
      const dialect = table.get(presetId)?.dialect
      if (dialect === undefined) return undefined
      return (result, at) => projectStepContent(result.frames, {
        turn: at.turn,
        step: at.step,
        dialect,
        ...(result.stream === undefined ? {} : { stream: result.stream }),
      })
    },
  )
  catalogDeps.gateway = gateway
  // The exit cleaner is registered the moment the gateway exists — the row is
  // mounted once per process, so exactly one cleaner owns every conversation.
  const registerExit = deps.onExit ?? ((clean: () => void) => { process.once('exit', clean) })
  registerExit(() => gateway.closeAll())
  registerCatalog(ctx, presets, catalogDeps)
  // A session whose work was stopped — archived with its turn running, most
  // visibly — must not leave its external connection open behind it. The stop
  // request ends the session's work; this closes the socket or child process
  // that work was running on, and the dropped cache entry means the session's
  // next turn, if it ever has one, opens fresh. This is also what keeps the
  // probe's small sessions from leaking one connection per probe: the probe
  // archives its session when it is done, and the archive is the stop.
  ctx.on('workspace/session-stop', payload => {
    const sessionId = payload.sessionId
    if (typeof sessionId !== 'string') return
    gateway.close(sessionId)
    // The open turn/step of a session that stopped is stale by definition, and
    // keeping it would let a later answer write content under numbers that no
    // longer match anything the log has open.
    forgetSession(sessionId)
    const opened = sessions.get(presetId)
    const entry = openSessionsOf(sessions, presetId).get(sessionId)
    if (opened === undefined || entry === undefined) return
    opened.delete(sessionId)
    entry.close()
    deps.report?.(`acp ${presetId}: session ${sessionId} was stopped — its external connection was closed`)
  })

  ctx.on('agent/created', payload => {
    try {
      const agent = payload.agent as AgentLike
      if (presetIdOf(agent, deps.presetOf) !== presetId) return
      if (modelBacked) {
        void followPresetSelection(servicesOf(ctx), presetId, pickerModels, agentIdentifier(agent) ?? '?', agent, reportOf(deps))
        return
      }
      if (dialect === undefined) return
      const binding = table.get(presetId)
      if (binding === undefined) return
      if (holdsAcpDispatch(agent, binding)) return
      deps.install(agent, presetId, dialect, table)
      void followPresetSelection(servicesOf(ctx), presetId, pickerModels, agentIdentifier(agent) ?? '?', agent, reportOf(deps))
    } catch (error) {
      // Left alone: whatever this session is, it keeps a working step. Said out
      // loud, though — a takeover that loads, matches, announces itself and then
      // throws here is indistinguishable from working, from the outside.
      deps.report?.(`acp takeover failed: ${String(error)}`)
    }
  })

  // A preset chosen after the agent exists never fires `agent/created` again:
  // the interface's selector rebinds the agent's scope to the new composition
  // and appends `agent-preset/selected`, and the turn sent right after that
  // would otherwise run the native agent with no error anywhere. The scope
  // filter delivers exactly the sessions this preset now drives, so the event
  // is both the signal and the filter.
  //
  // The same stream carries `model/selection` — the model picker's pick — for
  // every session this preset currently drives. That is the other half of the
  // linkage: a pick of another preset's model moves the session to that preset
  // when it still can (`follow.ts`); a started session cannot move in place
  // (its preset is locked, and a fork replays the lock), so the pick is
  // carried out as the §9.2 switch at the turn that would have run the wrong
  // agent — new session, whole conversation, question included.
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'model/selection') {
        const selection = selectionOf(event.data)
        const sessionId = sessionIdentifier(session)
        if (selection === undefined || sessionId === undefined) return
        const agentLike: AgentLike = { session: session as { header?: { agentPreset?: string } } }
        void followModelSelection(
          servicesOf(ctx),
          presetId,
          selection,
          sessionId,
          agentLike,
          reportOf(deps),
        )
        return
      }
      if (event.type !== 'agent-preset/selected') return
      const data = event.data
      if (typeof data !== 'object' || data === null || !('agentPreset' in data)) return
      if ((data as { agentPreset: unknown }).agentPreset !== presetId) return
      const binding = table.get(presetId)
      const sessionId = sessionIdentifier(session)
      if (sessionId === undefined) return
      if (!modelBacked && binding === undefined) return
      const registry = ctx.get?.('agents')
      if (typeof registry !== 'object' || registry === null
        || typeof (registry as { get?: unknown }).get !== 'function') {
        // `select` resolves the agent before it can append the event, so a host
        // that could select at all always has the registry here. Silence would
        // make a takeover that never happens look exactly like one that did.
        // A model plugin has no process to take over; it only aligns the picker.
        if (!modelBacked) {
          deps.report?.(`acp ${presetId}: preset selected for session ${sessionId} but this host exposes no agents registry — the takeover cannot reach the live agent`)
        }
        return
      }
      const agent = liveAgentOf(registry, sessionId)
      // A cold session has no live agent, which is normal.
      if (agent === undefined) return
      if (modelBacked) {
        void followPresetSelection(servicesOf(ctx), presetId, pickerModels, sessionId, agent, reportOf(deps))
        return
      }
      if (dialect === undefined || binding === undefined) return
      if (holdsAcpDispatch(agent, binding)) return
      deps.install(agent, presetId, dialect, table)
      void followPresetSelection(servicesOf(ctx), presetId, pickerModels, sessionId, agent, reportOf(deps))
    } catch (error) {
      // Same contract as the `agent/created` path: this session keeps its
      // working step, and what happened is said out loud instead.
      deps.report?.(`acp takeover failed: ${String(error)}`)
    }
  })
}

/** The report port, defaulting to nowhere. */
function reportOf(deps: AcpPluginDeps): (message: string) => void {
  return message => { deps.report?.(message) }
}

/** The session id off the event's session argument, if it carries one. */
function sessionIdentifier(session: unknown): string | undefined {
  if (typeof session !== 'object' || session === null) return undefined
  const id = (session as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The session id off the agent, from its session's id. */
function agentIdentifier(agent: AgentLike): string | undefined {
  return sessionIdentifier(agent.session)
}

/**
 * The live agent for a session, through the registry the host exposes by name.
 *
 * The caller has already checked the registry's structure; a missing entry is a
 * cold session, which is a normal state and stays quiet.
 */
function liveAgentOf(registry: object, sessionId: string): AgentLike | undefined {
  const get = (registry as { get?: unknown }).get
  if (typeof get !== 'function') return undefined
  const found = (get as (candidate: string) => unknown).call(registry, sessionId)
  // The registry answers whatever it answers; anything object-shaped is an
  // agent this module can read (`AgentLike` takes everything optionally).
  if (typeof found !== 'object' || found === null) return undefined
  return found as AgentLike
}