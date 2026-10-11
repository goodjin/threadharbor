/**
 * A model request from a session this row does not drive, answered as a switch.
 *
 * The trigger is real, not invented: picking one of this row's models in the
 * host's own model selector routes the session's next model request to this
 * row's catalog adapter (`GenerateOptions.sessionId` is stamped by the loop for
 * request routing — verified against `reference/deepseek-harness` @ 5badb15009,
 * `packages/llm/llm/src/types.ts:546-550`). Reaching that adapter means the
 * session wanted this agent and did not get it — which is exactly a switch
 * request, so it is handled by the switch chain: judge, plan, hand over, apply.
 *
 * Two verified host facts shape the outcome (design doc §2.4, §9.2):
 *
 * - A session that has produced any turn is locked, and so is a fork of it:
 *   the fork copies the event prefix through the latest completed turn, whose
 *   `turn/start` events replay into the copy's `turnBoundary` projection, so
 *   `agent-preset/select` on the copy fails with `agent-preset/locked` too
 *   (verified in the reference source and on a real host). A started session
 *   therefore switches into a **blank** session created on the target preset —
 *   the host's own route for "new session with a preset" — with the
 *   conversation carried into its first model request.
 * - When the target cannot carry the conversation, the switch is refused by
 *   name. Trimming exists in the planner but is not offered here: the mounted
 *   path never asks for it, so the one outcome this can never produce is a
 *   silently truncated conversation.
 *
 * Every host service is read through the `get` seam and validated
 * structurally; a missing service is a loud refusal naming it, never a silent
 * no-op — a switch that quietly does nothing is the failure this chain exists
 * to prevent.
 */

import { applySwitchPlan } from './apply-plan.ts'
import type { SwitchPorts, ForkRequest } from './apply-plan.ts'
import { presetOfState } from './dispatch.ts'
import type { AgentLike, TurnModelDecision } from './dispatch.ts'
import { planSwitch } from './switch-plan.ts'
import { assembleHandover, messagesOf } from './handover.ts'
import type { HandoverMessage } from './handover.ts'
import type { SwitchShared } from './switch-shared.ts'
import type { CatalogDeps } from './catalog.ts'
import type { ForeignModelRequest } from './catalog.ts'
import type { PresetConfig } from './registry.ts'
import { promptText } from './runner.ts'

/** Space held back from the target's window so it has room to answer. */
const RESERVED_FOR_OUTPUT_TOKENS = 8_192

/**
 * What this row needs from the host context, by service name.
 *
 * Names verified against `reference/deepseek-harness` @ 5badb15009:
 * `sessions` (core/session/src/index.ts:949), `agents` (core/agent/src/index.ts:256,
 * `get(sessionId)`), `sessionController` with public `create(request)` /
 * `prompt(request)` remotes (api/session-controller/src/index.ts:279-281, and the
 * remotes table in that file), and `agentPresets` with `select(agent, presetId)`
 * (preset/agent-preset-registry/src/index.ts:59,347-362).
 */
export type HostServices = {
  readonly sessions?: ((id: string) => unknown) | undefined
  readonly projections?: ((session: unknown, key: string) => unknown) | undefined
  readonly createSession?: ((request: {
    agentPreset?: string
    cwd?: string
  }) => Promise<unknown>) | undefined
  readonly promptSession?: ((request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: readonly { type: 'text'; text: string }[]
  }, signal?: AbortSignal) => Promise<unknown>) | undefined
  readonly agents?: ((id: string) => unknown) | undefined
  readonly presets?: ((agent: unknown, presetId: string) => Promise<unknown>) | undefined
  /** The preset registry's own `list`, bound to the registry. */
  readonly presetList?: (() => Promise<unknown>) | undefined
}

/** The services a switch needs, read off the context and validated. */
export function servicesOf(ctx: object): HostServices {
  const get = (ctx as { get?: unknown }).get
  if (typeof get !== 'function') return {}
  const read = get as (this: object, key: string) => unknown
  // Read one service and take its one method, checking shape as it goes: "the
  // service is there but its method is not" is the same absence as a missing
  // service, and both surface in the missing list rather than as a TypeError.
  // The method is bound to its service on the way out — a method called
  // detached from its owner reads `this` as undefined and dies inside the
  // service, which would dress a working host up as a missing one.
  const method = (key: string, name: string): unknown => {
    const holder = read.call(ctx, key)
    if (typeof holder !== 'object' || holder === null) return undefined
    const value = (holder as Record<string, unknown>)[name]
    return typeof value === 'function' ? (value as (this: object) => unknown).bind(holder) : undefined
  }
  return {
    sessions: method('sessions', 'get') as ((id: string) => unknown) | undefined,
    projections: method('sessionProjections', 'stateOf') as ((session: unknown, key: string) => unknown) | undefined,
    createSession: method('sessionController', 'create') as HostServices['createSession'],
    promptSession: method('sessionController', 'prompt') as HostServices['promptSession'],
    agents: method('agents', 'get') as ((id: string) => unknown) | undefined,
    presets: method('agentPresets', 'select') as ((agent: unknown, presetId: string) => Promise<unknown>) | undefined,
    presetList: method('agentPresets', 'list') as (() => Promise<unknown>) | undefined,
  }
}

/** Narrow an optional service that the missing-service check has ruled on. */
function present<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`acp switch: this host stopped exposing ${name} mid-request`)
  return value
}

/** The cwd a session was opened in, read flat off its header. */
function cwdOf(session: unknown): string | undefined {
  const header = (typeof session === 'object' && session !== null ? session : {}) as {
    header?: { cwd?: unknown }
  }
  const cwd = header.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * The two moves a switch can make, wired to the host services and the shared
 * switch fabric.
 *
 * The fork port is where the switch's real work lives: it creates the blank
 * session on the target preset, records the model pick on it, primes its first
 * model request with the assembled conversation, and puts the pending question
 * to it — one act, so a failure part-way names the session it created rather
 * than leaving the user to find a stray half-made session.
 */
export function switchPortsOf(services: HostServices, shared: SwitchShared): SwitchPorts {
  const sessions = present(services.sessions, 'sessions')
  const create = present(services.createSession, 'sessionController.create')
  const prompt = present(services.promptSession, 'sessionController.prompt')
  const agents = present(services.agents, 'agents')
  const presets = present(services.presets, 'agentPresets')
  return {
    select: async (sessionId, presetId) => {
      if (presetId === undefined) {
        throw new Error('this row cannot hand a session back to the native agent: it does not know the native preset id')
      }
      const agent = agents(sessionId)
      if (typeof agent !== 'object' || agent === null) {
        throw new Error(`no live agent for session ${sessionId} is visible to this row, so preset ${presetId} cannot be selected on it`)
      }
      await presets(agent, presetId)
    },
    fork: async (request: ForkRequest) => {
      const source = sessions(request.sessionId)
      if (source === undefined) {
        throw new Error(`acp switch: session ${request.sessionId} is not on this host anymore; nothing to switch`)
      }
      const cwd = cwdOf(source)
      const presetPart = request.preset === undefined ? {} : { agentPreset: request.preset }
      const cwdPart = cwd === undefined ? {} : { cwd }
      const created = (await create({ ...presetPart, ...cwdPart })) as { sessionId?: unknown } | null
      if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
        throw new Error('the host accepted the switch but did not name the session it created')
      }
      const newSessionId = created.sessionId
      try {
        const newSession = sessions(newSessionId)
        if (newSession === undefined) {
          throw new Error(`the host created session ${newSessionId} but it cannot be reached to record the switch on`)
        }
        if (request.selection !== undefined) {
          const append = appendOf(newSession)
          if (append !== undefined) {
            append('model/selection', { provider: request.selection.provider, model: request.selection.model })
          }
        }
        // The conversation rides the new session's first model request; the
        // priming is consumed there, and until then it survives restarts of
        // nothing — a host restart loses it, which is why the switch also
        // leaves the source session untouched.
        shared.primeHandover(newSessionId, assembleHandover(request.history))
        shared.recordSwitch(request.sessionId, {
          target: request.preset ?? '',
          sessionId: newSessionId,
        })
        if (request.prompt !== '') {
          // The prompt remote takes a caller-cancellation signal as its second
          // argument; an in-process call has no RPC plumbing to supply one, so
          // hand it a live signal explicitly.
          await prompt({
            requestId: `acp-switch-${crypto.randomUUID()}`,
            sessionId: newSessionId,
            mode: 'queue',
            content: [{ type: 'text', text: request.prompt }],
          }, new AbortController().signal)
        }
      } catch (error) {
        throw new Error(
          `新会话 ${newSessionId} 已建好，但交接没有完成：${messageOf(error)} — `
          + `历史已带到该会话的下一步请求里，请到那个会话继续`,
        )
      }
      return { sessionId: newSessionId }
    },
  }
}

/** The session log's append, if this session has one. */
function appendOf(session: unknown): ((type: string, data: unknown) => { seq: number }) | undefined {
  const holder = session as { append?: unknown } | undefined
  if (typeof holder?.append !== 'function') return undefined
  return (type: string, data: unknown) => (holder.append as (t: string, d: unknown) => { seq: number }).call(holder, type, data)
}

/** Whether the session has produced any turn yet, per its own projection. */
export function startedOf(boundary: unknown): boolean {
  const record = (typeof boundary === 'object' && boundary !== null ? boundary : {}) as {
    openTurnStartSeq?: unknown
    lastTurn?: unknown
  }
  if (record['openTurnStartSeq'] !== undefined && record['openTurnStartSeq'] !== null) return true
  return typeof record['lastTurn'] === 'number' && record['lastTurn'] > 0
}

/**
 * A token estimate for the conversation a request would have carried.
 *
 * Deliberately crude (about four characters per token) and only ever compared
 * against a window the target actually reported; with no window reported the
 * estimate is unused, because refusing on a number nobody published would block
 * every target that simply does not advertise one.
 */
export function estimateTokens(messages: readonly unknown[] | undefined): number {
  if (messages === undefined) return 0
  let characters = 0
  for (const message of messages) characters += JSON.stringify(message ?? null).length
  return Math.ceil(characters / 4)
}

/** The context window the target's own configuration declares for one model, if any. */
export function declaredContextWindow(
  config: PresetConfig,
  provider: string,
  model: string,
): number | undefined {
  const presetId = provider.startsWith('acp:') ? provider.slice('acp:'.length) : undefined
  if (presetId === undefined) return undefined
  const preset = config.presets[presetId]
  const found = preset?.models?.find(entry => entry.id === model)
  const window = found?.contextWindow
  return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined
}

/**
 * Split the conversation into the history that travels and the question that
 * is asked.
 *
 * The trailing user messages are the question this turn is asking; everything
 * before them is the conversation they continue. Keeping the question out of
 * the carried history means the new conversation reads it once, as the live
 * prompt — carrying it twice would read the same words to the agent twice.
 */
export function splitQuestion(
  history: readonly HandoverMessage[],
): { readonly carried: readonly HandoverMessage[]; readonly question: string } {
  let cut = history.length
  while (cut > 0 && history[cut - 1]!.role === 'user') cut -= 1
  const question = history.slice(cut).map(message => message.text).join('\n')
  return { carried: history.slice(0, cut), question }
}

/**
 * The switch a driven session asks for by picking another preset's model.
 *
 * This is the mounted side of §9.2 for sessions this row drives: the takeover
 * owns their turns, so no model request ever reaches a catalog adapter and the
 * pick surfaces here instead — at the turn that would have run the wrong
 * agent. The conversation snapshot must be taken before the claimed messages
 * are written (the caller arranges that), so the question travels exactly
 * once: as the live prompt of the session this creates.
 *
 * Returns `redirected` when the switch was made — the turn then ends pointing
 * at the new session — and `refuse` with the reason when it was not. The
 * refusal covers every honest dead end: unreadable conversation (nothing may
 * be created), history larger than the target's declared window (sizes
 * reported, nothing created), or a target that is not mounted here.
 */
export async function switchDrivenSession(params: {
  readonly ctx: object
  readonly shared: SwitchShared
  /** The preset this row drives, which the session is currently on. */
  readonly presetId: string
  /** The preset the pick names. */
  readonly target: string
  /** The pick itself, as the picker recorded it. */
  readonly selection: { readonly provider: string; readonly model: string }
  /** The agent whose turn asked for the switch. */
  readonly agent: AgentLike
  /** The turn's claimed messages, before they are written anywhere. */
  readonly decision: { readonly messages: readonly unknown[] }
  readonly report: (message: string) => void
}): Promise<TurnModelDecision> {
  const services = servicesOf(params.ctx)
  const missing = [
    ...(services.sessions === undefined ? ['sessions'] : []),
    ...(services.projections === undefined ? ['sessionProjections'] : []),
    ...(services.createSession === undefined ? ['sessionController.create'] : []),
    ...(services.promptSession === undefined ? ['sessionController.prompt'] : []),
    ...(services.agents === undefined ? ['agents'] : []),
    ...(services.presets === undefined ? ['agentPresets'] : []),
  ]
  if (missing.length > 0) {
    return {
      kind: 'refuse',
      reason: `无法切换到 ${params.target}：本机没有暴露 ${missing.join(', ')}，切换无法执行。请新建会话时选择该预设。`,
    }
  }

  const sessionId = sessionIdOfAgent(params.agent)
  if (sessionId === undefined) {
    return { kind: 'refuse', reason: `无法切换到 ${params.target}：读不到这个会话的 id，切换无从下手。` }
  }

  const prior = params.shared.switchFor(sessionId)
  if (prior !== undefined && prior.target === params.target) {
    return {
      kind: 'redirected',
      reason: `这个会话此前已切到 ${params.target}：对话在新会话 ${prior.sessionId} 里，请到那个会话继续`,
    }
  }

  // The conversation the session carries, read off its own log. Anything
  // unshaped reads as absent, and an absent conversation refuses below rather
  // than creating a session that silently lost its history.
  const transcript = transcriptOf(params.agent)
  const whole = messagesOf(transcript)
  const { carried, question: transcriptQuestion } = splitQuestion(whole)
  // The claimed messages of THIS turn are the question; the transcript may not
  // include them yet (the caller snapshots before writing), so the question
  // comes from the claim itself.
  const question = promptText(params.decision.messages) !== '' ? promptText(params.decision.messages) : transcriptQuestion

  const plan = planSwitch(params.shared.config(), {
    modelsOf: presetId => params.shared.modelsOf(presetId),
    dialectOf: () => undefined,
  }, { provider: `acp:${params.target}`, model: params.selection.model }, {
    currentPreset: params.presetId,
    started: startedOf(stateOf(services, params.agent, 'turnBoundary')),
    historyTokens: estimateTokens(carried),
    targetContextWindow: params.shared.contextWindowOf(params.target, params.selection.model),
    reservedForOutput: RESERVED_FOR_OUTPUT_TOKENS,
  }, {})

  if (plan.kind === 'noop') {
    return {
      kind: 'refuse',
      reason: `无法切换到 ${params.target}：本机没有挂载这个预设，或它不提供所选的模型 ${params.selection.model}。`,
    }
  }

  const ports = switchPortsOf(services, params.shared)
  try {
    const result = await applySwitchPlan(plan, sessionId, ports, {
      history: carried,
      prompt: question,
      selection: params.selection,
    })
    if (result.kind === 'nothing') {
      return { kind: 'refuse', reason: `无法切换到 ${params.target}：没有可执行的切换。` }
    }
    const carriedNote = result.droppedTokens === undefined
      ? '整段对话已带过去'
      : `只带过去了最新的部分（丢弃约 ${String(result.droppedTokens)} tokens）`
    params.report(
      `acp ${params.presetId}: session ${sessionId} switched to ${params.target} as session ${result.sessionId}; ${carriedNote}; `
      + `the pick ${params.selection.provider}/${params.selection.model} rides the new session`,
    )
    return {
      kind: 'redirected',
      reason: `已按新会话切换到 ${params.selection.provider}/${params.selection.model}：新会话 ${result.sessionId} `
        + `已带上${result.droppedTokens === undefined ? '整段' : '部分'}对话历史`
        + `${question === '' ? '' : '，并已把这条消息提交给它'}。请到新会话继续。`,
    }
  } catch (error) {
    // The planner's refusals (unreadable conversation, oversized history) come
    // through here too, and their messages already say what was refused and
    // why — including that nothing was created.
    params.report(`acp ${params.presetId}: session ${sessionId} could not switch to ${params.target}: ${messageOf(error)}`)
    return { kind: 'refuse', reason: messageOf(error) }
  }
}

/** The conversation a session carries, via its own message derivation. */
function transcriptOf(agent: AgentLike): readonly unknown[] | undefined {
  const session = agent.session as { deriveMessages?: unknown } | undefined
  if (typeof session?.deriveMessages !== 'function') return undefined
  try {
    const derived = (session.deriveMessages as (this: unknown) => unknown).call(session)
    return Array.isArray(derived) ? derived : undefined
  } catch {
    return undefined
  }
}

/** One projection state, through the validated service. */
function stateOf(services: HostServices, agent: AgentLike, key: string): unknown {
  const read = services.projections
  if (read === undefined || agent.session === undefined) return undefined
  return read(agent.session, key)
}

/** The session id, from wherever this agent shape happens to carry it. */
function sessionIdOfAgent(agent: AgentLike): string | undefined {
  // AgentLike states only what the dispatch reads; the id rides the same
  // runtime shapes it always has (the agent itself, or its session), so this
  // reads those two places structurally, the way `dispatch.ts` does.
  const direct = (agent as { readonly id?: unknown }).id
  if (typeof direct === 'string' && direct !== '') return direct
  const id = (agent.session as { readonly id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Build the switch handler for one row's catalog routes.
 *
 * The handler always ends in a throw: the calling stream can never produce a
 * stream, and the throw is where the switch's outcome is said out loud —
 * including success, which names the session to continue in.
 */
export function mountSwitchOnForeignModelRequest(
  ctx: object,
  config: PresetConfig,
  deps: CatalogDeps,
  shared: SwitchShared,
  report: (message: string) => void,
): (request: ForeignModelRequest) => Promise<void> {
  return async request => {
    const services = servicesOf(ctx)
    const missing = [
      ...(services.sessions === undefined ? ['sessions'] : []),
      ...(services.projections === undefined ? ['sessionProjections'] : []),
      ...(services.createSession === undefined ? ['sessionController.create'] : []),
      ...(services.promptSession === undefined ? ['sessionController.prompt'] : []),
      ...(services.agents === undefined ? ['agents'] : []),
      ...(services.presets === undefined ? ['agentPresets'] : []),
    ]
    if (missing.length > 0) {
      throw new Error(
        `acp switch: cannot switch session ${request.sessionId} to ${request.provider}/${request.model} — `
        + `this host does not expose: ${missing.join(', ')}`,
      )
    }
    const sessions = present(services.sessions, 'sessions')
    const projections = present(services.projections, 'sessionProjections')

    const session = sessions(request.sessionId)
    if (session === undefined) {
      throw new Error(`acp switch: session ${request.sessionId} is not on this host anymore; nothing to switch`)
    }

    // The conversation this request would have carried, as the loop assembled
    // it. Unreadable is refuseable, never failable-quietly: a switch that
    // cannot say what it would carry must not carry nothing.
    if (request.messages === undefined) {
      throw new Error(
        `无法把会话 ${request.sessionId} 切到 ${request.provider}/${request.model}：读不到这轮请求携带的对话，`
        + '而创建一个不带历史的新会话等于静默丢掉这段对话——已拒绝，未创建任何会话。',
      )
    }
    const whole = messagesOf(request.messages)
    const { carried, question } = splitQuestion(whole)

    // A switch already made from this session to this target points at its new
    // session instead of making a second one.
    const prior = shared.switchFor(request.sessionId)
    const targetPreset = request.provider.startsWith('acp:') ? request.provider.slice('acp:'.length) : request.provider
    if (prior !== undefined && prior.target === targetPreset) {
      throw new Error(
        `这个会话此前已切到 ${targetPreset}：对话在新会话 ${prior.sessionId} 里，请到那个会话继续`,
      )
    }

    const plan = planSwitch(config, deps, { provider: request.provider, model: request.model }, {
      currentPreset: presetOfState(projections(session, 'agentPreset')),
      started: startedOf(projections(session, 'turnBoundary')),
      historyTokens: estimateTokens(carried),
      targetContextWindow: declaredContextWindow(config, request.provider, request.model),
      reservedForOutput: RESERVED_FOR_OUTPUT_TOKENS,
    }, {})

    if (plan.kind === 'noop') {
      // The session is supposedly already on this route, or the model is not
      // one this row advertises. Either way the takeover should have prevented
      // this request, and saying so is the whole point of the diagnostic.
      throw new Error(
        `acp catalog: ${request.provider}/${request.model} reached a native model request on session `
        + `${request.sessionId} even though the takeover should own its step — the takeover did not happen`,
      )
    }

    const ports: SwitchPorts = switchPortsOf(services, shared)

    const result = await applySwitchPlan(plan, request.sessionId, ports, {
      history: carried,
      prompt: question,
      selection: { provider: request.provider, model: request.model },
    })
    if (result.kind === 'nothing') {
      throw new Error(
        `acp switch: session ${request.sessionId} is already on ${request.provider}/${request.model}; `
        + 'reaching a model request for it means the takeover did not happen',
      )
    }
    const carriedNote = result.droppedTokens === undefined
      ? '整段对话已带过去'
      : `只带过去了最新的部分（丢弃约 ${String(result.droppedTokens)} tokens）`
    report(`acp switch: session ${request.sessionId} switched for ${request.provider}/${request.model}; ${carriedNote}; continue in session ${result.sessionId}.`)
    throw plan.kind === 'fork'
      ? `已按新会话切换到 ${request.provider}/${request.model}：新会话 ${result.sessionId} 已带上${result.droppedTokens === undefined ? '整段' : '部分'}对话历史`
        + `${question === '' ? '' : '，并已把这条消息提交给它'}。请到新会话继续。`
      : `已就地切换到 ${request.provider}/${request.model}：这个会话还没有开始对话，预设已换，直接在这里继续即可。`
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
