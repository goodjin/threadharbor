/**
 * The row that DSH actually loads.
 *
 * A preset is a composition, so an external agent's behaviour has to come from a
 * row inside that composition — this is it. One row per agent, configured with
 * that agent's transport and dialect.
 *
 * The scope is the filter. A row only sees the agents mounted alongside it, so
 * a session on another preset is never seen here and keeps its own behaviour
 * with nothing to undo.
 *
 * Two constraints from the preset registry shape this entry:
 *
 * - `presetId` has to be written out. The registry knows which preset it is
 *   mounting but does not put that on the context, so a row cannot discover it.
 * - A row must not leak services. The registry audits mounted rows and fails the
 *   whole preset if one does (`mountPreset`, the `leakedServices` check). Event
 *   listeners are not services, so listening is fine; providing one is not.
 *
 * No imports from the DSH runtime packages: the published versions lag far
 * behind what runs, and the classes involved cannot be imported at all. So the
 * shapes this needs are structural, and the caller adapts.
 */

import Schema from '@deepseek-ai/schemastery'
import { hostname } from 'node:os'
import { applyAcpPlugin } from './plugin.ts'
import { installAcpDispatch, presetOfState } from './dispatch.ts'
import type { AgentLike, AcpPresetBinding, ContentEvent, StepPosition, TurnModelDecision, TurnStreamHandle } from './dispatch.ts'
import { positionOfSessionEvents, rememberPreStepPayload, stepPositionOf } from './step-position.ts'
import { makeApprovalBridge } from './approval-bridge.ts'
import { makeQuestionBridge } from './question-bridge.ts'
import { presetsForHost } from './host-filter.ts'
import { markRosterHidden } from './roster-marks.ts'
import { makeContentWriter } from './content-writer.ts'
import type { SessionAppend } from './content-writer.ts'
import type { GatewaySessionAppend } from './gateway.ts'
import { decideSelection, pendingSelectionOf, selectionOf } from './selection.ts'
import type { SelectionSource } from './selection.ts'
import { switchDrivenSession } from './switch-mount.ts'
import { switchShared } from './switch-shared.ts'
import type { AcpPresetConfig } from './registry.ts'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'
import { projectStepContent } from '@threadharbor/dsh-acp-agent'
import { AcpAssistantStream } from './stream.ts'

export const name = 'threadharbor-acp'

/** One model an agent serves, as offered in the picker. */
const Model = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().required(),
  description: Schema.string(),
  /**
   * The model's context window in tokens, when the operator declares it.
   *
   * The only number a mid-conversation switch may refuse on: the handover
   * compares the conversation's size against the target's window, and a
   * window nobody declared never refuses — the planner refuses only on a
   * number the target actually claims.
   */
  contextWindow: Schema.number(),
})

export const Config: Schema<Config> = Schema.object({
  /**
   * The preset this row belongs to.
   *
   * Required: the registry does not put the preset on the context, so without
   * it the row cannot tell whether a session is actually one of its own — and
   * would take over every session it can see.
   */
  presetId: Schema.string().required(),
  /** Which agent this is; picks the frame dialect. */
  agent: Schema.string().required(),
  url: Schema.string(),
  command: Schema.string(),
  /**
   * Replaces the spawn arguments the factory would default to. Omitted keeps
   * the default that makes this agent speak ACP at all.
   */
  args: Schema.array(Schema.string()),
  model: Schema.string(),
  mode: Schema.string(),
  cwd: Schema.string(),
  models: Schema.array(Model),
  /**
   * Which hosts offer this preset. Empty or omitted means every host.
   *
   * Not configurable to mean "off here": an omitted field and an explicitly
   * empty one cannot be told apart once the configuration has been normalised,
   * and guessing "off" took the whole plugin down on every machine.
   */
  hosts: Schema.array(Schema.string()),
  /**
   * Keep this preset out of the preset picker.
   *
   * The models still register and model-list switching still works. A new
   * agent sets this flag; the roster filter does not keep a name list.
   */
  hideFromRoster: Schema.boolean(),
  /**
   * Which host this row is on, as named by the `hosts` filter.
   *
   * A row can only evaluate its own `hosts` list against an identity, and the
   * host has no built-in notion of "this machine" — so the operator names it
   * here. Absent, the machine's hostname stands in; set it explicitly when the
   * `hosts` lists use another convention.
   */
  hostId: Schema.string(),
})

export type Config = {
  presetId: string
  agent: string
  url?: string
  command?: string
  /**
   * Replaces the factory's per-agent spawn arguments for this row. Absent keeps
   * the default that makes the agent speak ACP in the first place.
   */
  args?: string[]
  model?: string
  mode?: string
  cwd?: string
  models?: { id: string; name: string; description?: string; contextWindow?: number }[]
  hosts?: string[]
  hostId?: string
  /** When true, the roster filter omits this preset id from the picker. */
  hideFromRoster?: boolean
}

/**
 * Take over ACP-backed sessions in this row's scope.
 *
 * `write` and `askApproval` are the two ports back into the host. They are
 * resolved lazily on first use, so this row can be loaded before the services it
 * depends on are up — a preset is mounted during registry activation, which can
 * run before the rest of the host has settled.
 */
export function apply(ctx: unknown, config: Config): void {
  if (config.hideFromRoster === true) markRosterHidden(config.presetId)
  const host = ctx as {
    on(event: 'agent/created', handler: (payload: { agent: unknown }) => void): unknown
    /**
     * Same bus, different event: the row also hears archive-time stop requests.
     */
    on(event: 'workspace/session-stop', handler: (payload: { sessionId: unknown }) => void): unknown
    /**
     * The loop's per-step notice, fired before the boundaries are appended. Its
     * payload carries the turn and step numbers the loop is about to use — the
     * only source the replaced step has for placing its content.
     */
    on(event: 'agent/pre-step', handler: (
      payload: { agent: unknown; turn: unknown; step: unknown },
      next: () => Promise<unknown>,
    ) => Promise<unknown>): unknown
    /**
     * Same bus: the interface's preset selector lands here, never in
     * `agent/created` — the agent already exists when a blank session picks a
     * preset, so this is how the takeover reaches it.
     */
    on(event: 'session/event', handler: (
      session: unknown,
      event: { readonly type: unknown; readonly data: unknown },
    ) => void): unknown
    /**
     * Optional: injected services would refuse to mount without them.
     *
     * Any service name: `approval` and `sessionProjections` here, and the
     * switch services (`sessions`, `agents`, `sessionController`,
     * `agentPresets`) through the mounted plugin.
     */
    get?(key: string): unknown
    logger?: { info(message: string): void; warn(message: string): void }
  }

  const preset: AcpPresetConfig = {
    agent: config.agent,
    ...(config.url === undefined ? {} : { url: config.url }),
    ...(config.command === undefined ? {} : { command: config.command }),
    ...(config.args === undefined ? {} : { args: config.args }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.mode === undefined ? {} : { mode: config.mode }),
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.models === undefined ? {} : { models: config.models }),
    ...(config.hosts === undefined ? {} : { hosts: config.hosts }),
  }

  // The hosts filter decides whether this row is offered here at all. It runs
  // before anything mounts — a preset reachable only from one machine must not
  // appear in the picker, answer approvals, or take sessions on any other.
  // Absent `hosts` means everywhere, so this changes nothing until configured.
  const hostId = config.hostId === undefined || config.hostId.trim() === ''
    ? hostname()
    : config.hostId.trim()
  if (Object.keys(presetsForHost({ presets: { [config.presetId]: preset } }, hostId).presets).length === 0) {
    const line = `acp row not mounted: preset=${config.presetId} is offered on `
      + `[${(config.hosts ?? []).join(', ')}] but this host is ${hostId} — staying off this machine`
    host.logger?.warn(line)
    process.stderr.write(`[threadharbor] ${line}\n`)
    return
  }

  // Say so at mount. This row is invisible by design — it only ever speaks
  // through the sessions it takes over — so without this a preset that loaded
  // the row but never matched a session would look exactly like a plugin that
  // was never installed.
  const foundQuestions = host.get?.('userQuestions')
  const questions = (foundQuestions === null || typeof foundQuestions !== 'object'
    ? undefined
    : foundQuestions as { ask(request: unknown): Promise<unknown> })
  const transport = config.agent === 'zcode'
    ? 'model'
    : config.url === undefined ? 'process' : 'websocket'
  const summary = `acp row mounted: preset=${config.presetId} agent=${config.agent} `
    + `transport=${transport} `
    + `host=${hostId} `
    + `preset-reading=${readProjection(host) === undefined ? 'header-only' : 'projection'} `
    + `approvals=${host.get?.('approval') === undefined ? 'refuse-all' : 'host'} `
    + `questions=${questions === undefined ? 'auto-answer' : 'host'}`
  host.logger?.info(summary)
  // Also to stderr: this row is silent by design, and whether it mounted at all
  // is the first question anyone asks when no session is taken over. The host's
  // log level is not ours to raise.
  process.stderr.write(`[threadharbor] ${summary}\n`)

  // Listen for the loop's step notice from the day this row mounts: the numbers
  // must already be in hand when the first replaced step runs, not registered by
  // an install that only happens later. Registered here rather than per agent
  // for the same reason the takeover is announced at mount — a listener that
  // only exists after some agent has already stepped misses every earlier turn.
  host.on('agent/pre-step', (payload, next) => {
    rememberPreStepPayload(payload as { agent?: unknown; turn?: unknown; step?: unknown })
    return next()
  })

  // The session's own model choice, read from the projection the picker writes.
  // Resolved per turn: a selection made mid-conversation applies from the next
  // turn on, the same as it would for a native session. The readers are called
  // through their owners on purpose — both are service methods that read the
  // owner's own state, and calling either detached fails inside the service.
  const projections = host.get?.('sessionProjections') as
    | { stateOf?(this: unknown, session: unknown, key: string): unknown }
    | undefined
  const defaultModel = host.get?.('agentDefaultModel') as
    | { currentSelection?(this: unknown): unknown }
    | undefined
  const turnModel = async (
    agent: AgentLike,
    decision: { readonly messages: readonly unknown[] },
  ): Promise<TurnModelDecision> => {
    const session = agent.session
    // The picker's explicit pick for this session comes first.
    const stateOf = projections?.stateOf
    let selection: ReturnType<typeof selectionOf>
    let source: SelectionSource = 'picker'
    if (projections !== undefined && stateOf !== undefined && session !== undefined) {
      selection = pendingSelectionOf(stateOf.call(projections, session, 'modelSelection'))
    }
    // Otherwise the model a native request would use — the host default. This
    // is the case a fresh session shows in its composer without any pick ever
    // having been made.
    if (selection === undefined && defaultModel?.currentSelection !== undefined) {
      selection = selectionOf(defaultModel.currentSelection.call(defaultModel))
      source = 'host-default'
    }
    if (selection === undefined) return { kind: 'none' }
    const decided = decideSelection({ presetId: config.presetId, models: config.models ?? [] }, selection, source)
    if (decided.kind !== 'refuse') return decided
    // A pick this preset cannot serve. When it names ANOTHER preset's model,
    // and that preset is mounted on this host, this is the §9.2 switch: it is
    // carried out here, before this turn runs anything, as a new session with
    // the whole conversation and this question. Picks of native models are not
    // a preset switch — the refusal already says what to do about those.
    if (!selection.provider.startsWith('acp:')) return decided
    const target = selection.provider.slice('acp:'.length)
    if (target === config.presetId) return decided
    if (switchShared.modelsOf(target).length === 0) return decided
    return switchDrivenSession({
      ctx: host as object,
      shared: switchShared,
      presetId: config.presetId,
      target,
      selection,
      agent,
      decision,
      report: message => {
        host.logger?.warn(message)
        process.stderr.write(`[threadharbor] ${message}\n`)
      },
    })
  }

  // Where a permission request goes. The row must not answer these itself:
  // deciding on the agent's behalf is how an external agent ends up able to do
  // nothing, with nothing on screen to say why.
  //
  // The one shared bridge does the translating (`approval-bridge.ts`: only
  // `allowed-once` grants, and a thrown request — the host has no open turn to
  // attach it to — refuses rather than hangs). This row only says who is
  // asking: the agent is looked up by session rather than captured, because
  // several sessions can be live at once and a permission request names the
  // session it belongs to.
  const agents = new Map<string, unknown>()
  // Opportunistic, like the native tool layer: injecting it would mean the row
  // refuses to mount on a host that has no approval service, and taking every
  // session with it.
  const found = host.get?.('approval')
  const approval = (found === null || typeof found !== 'object'
    ? undefined
    : found as { request(request: unknown): Promise<unknown> })
  const ask = approval === undefined ? undefined : makeApprovalBridge(
    request => approval.request(request),
    request => {
      const sessionId = sessionIdOfRequest(request)
      return sessionId === undefined ? undefined : agents.get(sessionId)
    },
    describeRequest,
  )

  // Where an agent's own question goes — the same opportunistic reach, for the
  // host's user-questions service (`questions`, read up at the mount summary).
  // When the host has one, cursor's blocking `cursor/ask_question` shows the
  // native question card and the answer returns to the agent; when it has
  // none, the question keeps its benign auto-answer. The agent is resolved per
  // request from the session the question names, for the same reason the
  // approval bridge does it that way.
  const questionBridge = questions === undefined ? undefined : makeQuestionBridge(
    request => questions.ask(request),
    sessionId => sessionId === undefined ? undefined : agents.get(sessionId),
  )
  // The writer the in-place answer path records tool cards through; a host with
  // no session store leaves the cards unwritten rather than the answer lost.
  const sessionAppend = readSessionAppend(host)
  // The open turn and step read straight from the session log: the row's
  // scoped context never sees the pre-step notices of sessions it answers
  // in place for, and the gateway needs a position to write tool cards.
  const sessionPositionOf = readSessionPosition(host)

  applyAcpPlugin(host, config.presetId, preset, {
    ...(readProjection(host) === undefined ? {} : { presetOf: readProjection(host) }),
    ...(sessionAppend === undefined ? {} : { sessionAppend }),
    ...(sessionPositionOf === undefined ? {} : { sessionPositionOf }),
    ...(ask === undefined ? {} : { answerPermission: ask }),
    ...(questionBridge === undefined ? {} : { answerAskQuestion: questionBridge }),
    report: message => {
      host.logger?.warn(message)
      process.stderr.write(`[threadharbor] ${message}\n`)
    },
    install: (agent, presetId, dialect, table) => {
      const line = `acp takeover: session=${String(sessionIdOf(agent) ?? '?')} preset=${presetId} dialect=${dialect.id}`
      const sessionId = sessionIdOf(agent)
      if (sessionId !== undefined) agents.set(sessionId, agent)
      host.logger?.info(line)
      process.stderr.write(`[threadharbor] ${line}\n`)

      // Replace the session's step so the external agent drives the turn. This is
      // the whole point of the row: reporting a takeover without doing it leaves
      // a session that loads, matches, announces itself, and then answers with
      // nothing — the quietest failure there is.
      const append = appendOf(agent)
      if (append === undefined) {
        host.logger?.warn(`acp takeover: ${line} has no session log to write to; leaving it native`)
        return
      }
      const write = makeContentWriter((type, payload, intent) => append(type, payload, intent))
      const projection = readProjection(host)
      const installed = installAcpDispatch(agent as AgentLike & object, table, {
        ...(projection === undefined ? {} : { presetOf: projection }),
        // The loop announces the real turn and step on its pre-step waterfall
        // (captured at mount); the conversation view groups content under the
        // step that declared it, so anything numbered differently is dropped.
        positionOf: candidate => stepPositionOf(candidate),
        produce: (result, position) =>
          projectStepContent(result.frames, {
            turn: position.turn,
            step: position.step,
            dialect,
            ...(result.stream === undefined ? {} : { stream: result.stream }),
          }),
        write,
        turnModel,
        openStream: (candidate, position) => () =>
          openAssistantStream(candidate, position, dialect.id, message => host.logger?.warn(message)),
      })
      if (!installed) host.logger?.warn(`acp takeover: ${line} could not be installed`)
    },
  })
}

/**
 * Read a session's current preset from the projection.
 *
 * The header records the preset a session was *created* with, and a blank
 * session can change afterwards, so the header alone would take over a session
 * that has since moved on — or run a native session as though it were ours.
 * DSH reads the projection for exactly this reason.
 */
/** The session id, from wherever this agent shape happens to carry it. */
/** The session log's append, if this agent has one. */
function appendOf(agent: { readonly session?: unknown }): ((type: string, payload: unknown, intent?: unknown) => { seq: number }) | undefined {
  const session = agent.session as { append?: unknown } | undefined
  if (typeof session?.append !== 'function') return undefined
  return session.append.bind(session)
}

/**
 * The session log writer for a DSH session, from the host's session store.
 *
 * The in-place answer path has no agent of its own to take a writer from — the
 * session it answers for is a native one that never installed this row — so it
 * resolves the session by id. Opportunistic like the approval and question
 * bridges: a host that composes no session store still gets answers, only
 * without tool cards.
 *
 * @param host - the plugin context, to read the store from.
 * @returns a resolver, or undefined when the host has no session store.
 */
function readSessionAppend(host: { get?(key: string): unknown }): GatewaySessionAppend | undefined {
  const store = sessionStoreOf(host)
  if (store === undefined) return undefined
  return sessionId => {
    const session = sessionOf(store, sessionId)
    const append = session?.append
    return typeof append === 'function' ? (append.bind(session) as SessionAppend) : undefined
  }
}

/** The host's session store, when it composes one. */
function sessionStoreOf(host: { get?(key: string): unknown }): { get(id: string): unknown } | undefined {
  const found = host.get?.('sessions')
  if (found === undefined || found === null || typeof found !== 'object') return undefined
  return found as { get(id: string): unknown }
}

/** One live session from the store; a refusing store reads as "no such session". */
function sessionOf(store: { get(id: string): unknown }, sessionId: string): { append?: unknown; ownEvents?: unknown } | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    return store.get(sessionId) as { append?: unknown; ownEvents?: unknown } | undefined
  } catch {
    // A store that refuses the lookup is a store with no such live session.
    return undefined
  }
}

/**
 * The open turn and step of a DSH session, derived from its own event log.
 *
 * The in-place gateway answers for sessions this row never mounted, and a
 * row's context only sees the agents mounted with it — so those sessions'
 * `agent/pre-step` notices never arrive here (verified live 2026-10-16: five
 * gateway position asks, zero event feeds). The session log's tail carries
 * the same boundaries the loop announced, so the position is read from the
 * store instead.
 */
function readSessionPosition(host: { get?(key: string): unknown }): ((sessionId: string) => StepPosition | undefined) | undefined {
  const store = sessionStoreOf(host)
  if (store === undefined) return undefined
  return sessionId => {
    const session = sessionOf(store, sessionId)
    const ownEvents = session?.ownEvents
    if (typeof ownEvents !== 'function') return undefined
    return positionOfSessionEvents(ownEvents.call(session) as readonly unknown[])
  }
}

function sessionIdOf(agent: { readonly id?: unknown; readonly session?: unknown }): string | undefined {
  if (typeof agent.id === 'string') return agent.id
  const session = agent.session as { readonly id?: unknown } | undefined
  return typeof session?.id === 'string' ? session.id : undefined
}

/**
 * The session projection service, if this host composes one.
 *
 * Read through `get` rather than by property access: on a cordis context an
 * uninjected property throws on read, so reaching for it directly turns "this
 * host has no projections" into "this row refuses to load". Absent is a normal
 * composition, not a failure.
 */
function readProjection(host: { get?(key: 'sessionProjections'): unknown }): ((agent: { session?: unknown }) => string | undefined) | undefined {
  const found = host.get?.('sessionProjections')
  if (found === undefined || found === null || typeof found !== 'object') return undefined
  const projections = found as { stateOf(session: unknown, key: string): unknown }
  return (agent: { session?: unknown }) => presetOfState(projections.stateOf(agent.session, 'agentPreset'))
}

/** Kept so the dialect type stays referenced from the entry. */
export type { AcpDialect }

function sessionIdOfRequest(request: unknown): string | undefined {
  const sessionId = (request as { sessionId?: unknown } | undefined)?.sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * What the host needs to describe a permission prompt.
 *
 * A prompt that says only "allow?" tells the operator nothing about what they
 * are agreeing to, so the tool's own name and arguments travel with it.
 */
function describeRequest(request: unknown): { toolName: string; callId?: string; reason?: string } {
  const raw = (request ?? {}) as { toolName?: unknown; title?: unknown; rawInput?: unknown; reason?: unknown; callId?: unknown }
  const toolName = typeof raw.title === 'string' && raw.title !== ''
    ? raw.title
    : typeof raw.toolName === 'string' && raw.toolName !== '' ? raw.toolName : 'unknown'
  const callId = typeof raw.callId === 'string' ? raw.callId : undefined
  const reason = typeof raw.reason === 'string' ? raw.reason
    : raw.rawInput === undefined ? undefined : JSON.stringify(raw.rawInput).slice(0, 200)
  return { toolName, ...(callId === undefined ? {} : { callId }), ...(reason === undefined ? {} : { reason }) }
}

/**
 * Per-agent counters for the live stream.
 *
 * Held per agent rather than per preset because the two numbers must keep
 * climbing for the whole life of one conversation: the UI uses them to order
 * frames and to discard anything stale, so two sessions sharing a counter is
 * one session's text appearing in the other's window.
 */
const streamCounters = new WeakMap<object, { attempt: number; revision: number }>()

function countersFor(agent: object): { attempt: number; revision: number } {
  const found = streamCounters.get(agent)
  if (found !== undefined) return found
  const fresh = { attempt: 0, revision: 0 }
  streamCounters.set(agent, fresh)
  return fresh
}

/**
 * Open a turn's live stream on the live agent, if it can emit one.
 *
 * The native loop does the same thing: it reaches its own dispatcher and emits
 * `agent/assistant-stream` (see the reference loop's own `ReactLoopAgent`). If
 * that seam is not reachable, the turn still runs and still writes its message —
 * it just does not stream — and it says so, because a stream that silently
 * never appears looks identical to an agent that never answered.
 */
function openAssistantStream(
  agent: AgentLike,
  position: StepPosition,
  dialectId: string,
  warn: (message: string) => void,
): TurnStreamHandle | undefined {
  const holder = agent as unknown as {
    dispatch?: { emit?: (event: string, payload: unknown) => unknown }
    id?: unknown
  }
  const emit = holder.dispatch?.emit?.bind(holder.dispatch)
  const sessionId = sessionIdOf(agent)
  if (emit === undefined || sessionId === undefined) {
    warn(`acp ${dialectId}: this agent has no stream channel; the answer will appear all at once`)
    return undefined
  }
  const counters = countersFor(agent as unknown as object)
  return new AcpAssistantStream({
    sessionId,
    attempt: ++counters.attempt,
    nextRevision: () => ++counters.revision,
    turn: position.turn,
    step: position.step,
    emit: frame => { emit('agent/assistant-stream', { frame }) },
  })
}

/**
 * Where the loop numbers the step it is about to run, per agent.
 *
 * The loop states it on its `agent/pre-step` waterfall — the official notice of
 * "this turn, this step, about to run", carrying the same numbers it appends the
 * boundaries with. The store lives in step-position.ts (fed by the same
 * listener this file registers); both readers — the gateway by session id,
 * the replaced step by agent — resolve against that one store.
 */
