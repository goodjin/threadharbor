/**
 * Where each session's open turn and step sit, as the loop itself numbers them.
 *
 * The loop announces the pair on its pre-step waterfall; anything that writes
 * session content outside a replaced step — the in-place gateway — has to ask
 * here rather than invent a number. It has to: the session log validates a
 * `tool/call` against the turn and step open when it was written
 * (`requireStep` in session-format), and that check runs when the session is
 * opened. A number that is merely plausible is enough to look right in the live
 * view, which places a card by where the event sits between the loop's own
 * boundaries, and still enough to make the whole log unloadable afterwards.
 *
 * Keyed by agent in a WeakMap so a finished session's entry disappears with its
 * agent; the session index mirrors the `agents` map this package already keeps
 * for the same lifetime, and every read goes through the agent, so a stale index
 * can answer `undefined` rather than a stale number.
 *
 * @module threadharbor-acp/step-position
 */

import type { StepPosition } from './dispatch.ts'

/** The open position per agent; the weak key is what retires the entry. */
const byAgent = new WeakMap<object, StepPosition>()

/** Which agent a session is running, so a sessionId can reach its position. */
const agentBySession = new Map<string, object>()

/**
 * Record the position the loop announced for one step.
 *
 * @param agent - The agent the loop is stepping.
 * @param sessionId - That agent's session, when it is known.
 * @param position - The turn and step the loop announced.
 */
export function rememberStepPosition(agent: object, sessionId: string | undefined, position: StepPosition): void {
  byAgent.set(agent, position)
  if (sessionId !== undefined) agentBySession.set(sessionId, agent)
}

/**
 * Resolve the session a core-shaped loop agent belongs to.
 *
 * Core's own code reads `agent.session.header.id` (see `underArchivedSession`
 * in dsh-api-session-controller) and never trusts `agent.id` for session
 * identity — that is the loop's own handle. The flat `session.id` and a
 * string `agent.id` stay as fallbacks for tests and older hosts.
 */
function sessionKeyOf(agent: object): string | undefined {
  const session = (agent as { session?: { header?: { id?: unknown }; id?: unknown } }).session
  if (typeof session?.header?.id === 'string') return session.header.id
  if (typeof session?.id === 'string') return session.id
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/**
 * Remember a whole `agent/pre-step` waterfall payload.
 *
 * The bus fuses the agent into the payload; the turn and step ride as plain
 * numbers. Anything that does not resolve to a session and a numeric pair is
 * ignored whole — a wrong key here answers `undefined` forever, and every
 * in-place answer silently drops its tool events.
 *
 * @param payload - The payload as the listener received it.
 */
export function rememberPreStepPayload(payload: { agent?: unknown; turn?: unknown; step?: unknown }): void {
  const agent = payload.agent
  if (typeof agent !== 'object' || agent === null) return
  if (typeof payload.turn !== 'number' || typeof payload.step !== 'number') return
  const sessionId = sessionKeyOf(agent)
  if (sessionId === undefined) return
  rememberStepPosition(agent, sessionId, { turn: payload.turn, step: payload.step })
}

/**
 * The position the loop last announced for this agent.
 *
 * @param agent - The agent to read for.
 * @returns The open position, or `undefined` when no step has announced one.
 */
export function stepPositionOf(agent: unknown): StepPosition | undefined {
  return typeof agent === 'object' && agent !== null ? byAgent.get(agent) : undefined
}

/**
 * The position the loop last announced for this session's agent.
 *
 * @param sessionId - The session to read for.
 * @returns The open position, or `undefined` when there is no agent or it has
 * not stepped.
 */
export function stepPositionOfSession(sessionId: string): StepPosition | undefined {
  const agent = agentBySession.get(sessionId)
  return agent === undefined ? undefined : byAgent.get(agent)
}

/**
 * Derive the open turn and step from a session's own event log.
 *
 * The row's context is scoped to the agents mounted with it, so a session the
 * in-place gateway answers for never delivers its `agent/pre-step` notice to
 * this row (verified live 2026-10-16: five gateway asks, zero event feeds).
 * The session log is the unscoped source of truth — its tail records the open
 * boundaries the same way the loop announced them — so the gateway reads the
 * position from there instead of replaying events.
 *
 * The scan walks backward and lets the first boundary record decide: an open
 * `step/start` answers with its numbers, while any end record (or a turn with
 * no step yet, or nothing boundary-shaped at all) means there is nothing open
 * to write tool events against.
 *
 * @param events - The session's events, oldest first.
 * @returns The open position, or `undefined` when no step is open.
 */
export function positionOfSessionEvents(events: readonly unknown[]): StepPosition | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as { type?: unknown; data?: unknown } | null
    if (typeof event !== 'object' || event === null) continue
    if (event.type === 'step/start') {
      const data = event.data as { turn?: unknown; step?: unknown } | null
      if (typeof data !== 'object' || data === null) return undefined
      return typeof data.turn === 'number' && typeof data.step === 'number'
        ? { turn: data.turn, step: data.step }
        : undefined
    }
    if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'turn/start') return undefined
  }
  return undefined
}

/**
 * Drop a session's index entry when its work is stopped.
 *
 * @param sessionId - The session that stopped.
 */
export function forgetSession(sessionId: string): void {
  agentBySession.delete(sessionId)
}
