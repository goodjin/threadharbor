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
 * Drop a session's index entry when its work is stopped.
 *
 * @param sessionId - The session that stopped.
 */
export function forgetSession(sessionId: string): void {
  agentBySession.delete(sessionId)
}
