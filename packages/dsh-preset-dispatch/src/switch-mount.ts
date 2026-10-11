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
 * Two hard facts shape the outcome (design doc §2.4, verified):
 *
 * - A session that has produced any turn is locked; the host's own
 *   `agent-preset/select` throws `agent-preset/locked`. Switching therefore
 *   forks into a fresh session first and selects on the fork — the order
 *   `applySwitchPlan` already owns.
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
import type { SwitchPorts } from './apply-plan.ts'
import { presetOfState } from './dispatch.ts'
import { planSwitch } from './switch-plan.ts'
import type { CatalogDeps } from './catalog.ts'
import type { ForeignModelRequest } from './catalog.ts'
import type { PresetConfig } from './registry.ts'

/** Space held back from the target's window so it has room to answer. */
const RESERVED_FOR_OUTPUT_TOKENS = 8_192

/**
 * What this row needs from the host context, by service name.
 *
 * Names verified against `reference/deepseek-harness` @ 5badb15009:
 * `sessions` (core/session/src/index.ts:949), `agents` (core/agent/src/index.ts:256,
 * `get(sessionId)`), `sessionController` with public `fork(request)` returning
 * `{ sessionId }` (api/session-controller/src/index.ts:152,421-423), and
 * `agentPresets` with `select(agent, presetId)` (preset/agent-preset-registry/src/index.ts:59,347-362).
 */
export type HostServices = {
  readonly sessions?: ((id: string) => unknown) | undefined
  readonly projections?: ((session: unknown, key: string) => unknown) | undefined
  readonly controller?: ((request: { sessionId: string }) => Promise<unknown>) | undefined
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
    controller: method('sessionController', 'fork') as ((request: { sessionId: string }) => Promise<unknown>) | undefined,
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

/**
 * The two moves a switch can make, wired to the host services.
 *
 * Shared with the model-follow (`follow.ts`), which performs the same fork
 * when a started session picks another preset's model.
 */
export function switchPortsOf(services: HostServices): SwitchPorts {
  const agents = present(services.agents, 'agents')
  const presets = present(services.presets, 'agentPresets')
  const controller = present(services.controller, 'sessionController')
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
    fork: async sessionId => {
      const value = await controller({ sessionId })
      const forked = (typeof value === 'object' && value !== null ? value : {}) as { sessionId?: unknown }
      if (typeof forked['sessionId'] !== 'string' || forked['sessionId'] === '') {
        throw new Error('the host accepted the fork but did not name the session it created')
      }
      return { sessionId: forked['sessionId'] }
    },
  }
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

/** The fork a session already produced for one target, so a repeat says where to go instead of duplicating. */
export type ForkRecord = { readonly target: string; readonly forkedSessionId: string }

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
  report: (message: string) => void,
): (request: ForeignModelRequest) => Promise<void> {
  // Host-generation memory: after a restart the guard is empty and forking
  // again is legitimate, because nothing links the old fork to this process.
  const forks = new Map<string, ForkRecord>()

  return async request => {
    const services = servicesOf(ctx)
    const missing = [
      ...(services.sessions === undefined ? ['sessions'] : []),
      ...(services.projections === undefined ? ['sessionProjections'] : []),
      ...(services.controller === undefined ? ['sessionController'] : []),
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

    const plan = planSwitch(config, deps, { provider: request.provider, model: request.model }, {
      currentPreset: presetOfState(projections(session, 'agentPreset')),
      started: startedOf(projections(session, 'turnBoundary')),
      historyTokens: estimateTokens(request.messages),
      targetContextWindow: undefined,
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

    if (plan.kind === 'fork' && plan.preset !== undefined) {
      const prior = forks.get(request.sessionId)
      if (prior !== undefined && prior.target === plan.preset) {
        throw new Error(
          `acp switch: session ${request.sessionId} was already forked to ${plan.preset} as session `
          + `${prior.forkedSessionId} — continue there; forking again would duplicate the conversation`,
        )
      }
    }

    const ports: SwitchPorts = switchPortsOf(services)

    const result = await applySwitchPlan(plan, request.sessionId, ports)
    if (result.kind === 'nothing') {
      throw new Error(
        `acp switch: session ${request.sessionId} is already on ${request.provider}/${request.model}; `
        + 'reaching a model request for it means the takeover did not happen',
      )
    }
    if (plan.kind === 'fork' && plan.preset !== undefined) {
      forks.set(request.sessionId, { target: plan.preset, forkedSessionId: result.sessionId })
    }
    const carried = result.droppedTokens === undefined
      ? 'the whole conversation came across'
      : `only the newest turns came across (${String(result.droppedTokens)} tokens dropped)`
    const where = plan.kind === 'fork'
      ? `it was forked to session ${result.sessionId} — continue there`
      : plan.kind === 'switch-here'
        ? `its agent was switched in place to ${plan.preset ?? 'the native agent'} — resend the message there`
        : 'the switch did not happen'
    report(`acp switch: session ${request.sessionId} switched for ${request.provider}/${request.model}; ${carried}; ${where}.`)
    throw new Error(`acp switch: session ${request.sessionId} cannot stream ${request.provider}/${request.model} — ${where}`)
  }
}
