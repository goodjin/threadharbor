/**
 * Routing a session's turns to an external ACP agent.
 *
 * The seam is the loop's own `step`. The native loop appends `step/start`
 * before calling it and `step/end` in a finally, with `turn/end` when the turn
 * unwinds, and it decides whether a turn continues from the inbox rather than
 * from what `step` returned. So a replacement step contributes only the
 * model-visible content, and the native loop keeps owning the turn.
 *
 * Why structural types at this boundary: the published `@deepseek-ai/dsh-*`
 * packages are well behind the runtime they load into (0.1.0-rc.6 published vs
 * 0.2.0-rc.2 running), and `ReactLoopAgent` is not importable at all — it is not
 * re-exported from its barrel and the package exposes no `./agent` subpath.
 * Typing against the published declarations would describe a different API than
 * the one actually running, and the class reference does not exist to obtain.
 * So this module states the minimum it reads, and the caller adapts.
 */

import type { AcpDialect, AcpFrame } from '@threadharbor/dsh-acp-agent'
import type { StreamRecord } from './stream.ts'
import type { ContentWriter } from './content-writer.ts'

/** The header fields this module reads to decide whether to take over. */
export type SessionHeaderLike = {
  /** Flat on the header — not under a `meta` object. */
  readonly agentPreset?: string | undefined
}

/** What this module needs from a live agent. */
export type AgentLike = {
  readonly session?: { readonly header?: SessionHeaderLike } | undefined
}

/** One step's worth of work, as the native loop hands it over. */
export type StepDecisionLike = {
  readonly kind: 'enter'
  readonly messages: readonly unknown[]
}

/** What a replacement step reports back; mirrors the loop's own vocabulary. */
export type StepEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'blocked'; readonly reason?: unknown }
  | { readonly kind: 'aborted'; readonly reason: unknown }
  | { readonly kind: 'error'; readonly error: { readonly message: string; readonly code: string } }

/** What one external turn produced: the frames it sent, and how it ended. */
export type AcpStepResult = {
  /** ACP frames from this turn alone, for projection. */
  readonly frames: readonly AcpFrame[]
  /**
   * The compacted stream, when the turn ran with streaming on.
   *
   * The durable message embeds it, so the text a user watched arrive is still
   * there after a reload. Without this the live stream and the transcript are
   * two different versions of the same turn.
   */
  readonly stream?: readonly StreamRecord[]
  readonly end: StepEndReason
}

/** How to drive one session's external agent. */
export type AcpPresetBinding = {
  readonly dialect: AcpDialect
  /**
   * Runs one turn and returns what it produced.
   *
   * The replacement step owns this call, including its failures: anything thrown
   * here reaches the loop's own error handling, which closes the turn as an
   * error rather than leaving it open.
   */
  readonly run: (decision: StepDecisionLike, turn: TurnContext) => Promise<AcpStepResult>
}

/** The live stream this turn writes into, if streaming is on. */
export type TurnStreamHandle = {
  start(): void
  textDelta(text: string): void
  reasoningDelta(text: string): void
  /** The compacted stream for the durable message. */
  records(): readonly StreamRecord[]
  /**
   * Announce the end, pointing at the durable write's sequence number.
   *
   * Call this only once that write has happened: the closing frame carries the
   * number, and it is how the UI knows the text it watched arrive is now
   * findable. If nothing was written, abandon instead.
   */
  settle(eventType: 'assistant/message' | 'assistant/attempt', commit: () => number): void
  abandon(): void
}

/**
 * What one turn needs from the session it belongs to.
 *
 * Passed per turn rather than held, because the writer belongs to a session
 * while the external agent is opened per preset. Passing them together is what
 * lets the turn own its stream's whole life without two sessions sharing one.
 */
export type TurnContext = {
  /** This DSH session's id; the external conversation is keyed by it. */
  readonly sessionId: string
  readonly produce: (result: AcpStepResult) => readonly ContentEvent[]
  /** Append the events; returns the message's sequence number. */
  readonly write: ContentWriter
  readonly openStream?: () => TurnStreamHandle | undefined
}

/**
 * What the patched step writes into the session log.
 *
 * Shaped as the projection already emits it, so the content events need no
 * re-shaping on the way out.
 */
export type ContentEvent = { readonly type: string; readonly payload: unknown }

export type AcpDispatchOptions = {
  /** Which preset this session is actually on. Defaults to the session header. */
  readonly presetOf?: PresetResolver
  /** Turns what a turn produced into the events the session log should carry. */
  readonly produce: (result: AcpStepResult) => readonly ContentEvent[]
  /** Append those events, in order; returns the message's sequence number. */
  readonly write: ContentWriter
  /** Open this agent's live stream for a turn, if it can stream. */
  readonly openStream?: (agent: AgentLike) => () => TurnStreamHandle | undefined
}

/**
 * Whether a session's turns belong to an external agent.
 *
 * An absent preset, or one this plugin does not own, must leave the native
 * agent completely untouched — that is the whole of the "no behaviour change"
 * requirement, and it is why this reads before it writes anything.
 */
export function resolvePreset(
  agent: AgentLike,
  presets: ReadonlyMap<string, AcpPresetBinding>,
  presetOf?: PresetResolver,
): AcpPresetBinding | undefined {
  // Same question, same answer as `presetIdOf`. Two spellings of "which preset is
  // this session on" that can disagree is how a row matches a session and then
  // declines to take it over.
  const id = presetIdOf(agent, presetOf)
  if (id === undefined) return undefined
  return presets.get(id)
}

/**
 * Which preset a session is on, as an id.
 *
 * Split out from `resolvePreset` so a caller that needs to know *which* preset
 * matched — rather than what it can do — asks the same question the same way.
 */
export function presetIdOf(agent: AgentLike, presetOf?: PresetResolver): string | undefined {
  // Projection first, header second — and the header is not the stale fallback
  // it looks like. The projection is written when a preset is selected, which
  // happens *after* `agent/created` fires for the sessions it recomposes. At that
  // moment the header is the current answer, not a stale one: the session is
  // being mounted precisely because this preset was selected for it. A resolver
  // alone would therefore claim nothing on a real host and fail silently.
  const fromProjection = presetOf?.(agent)
  const id = fromProjection === undefined || fromProjection === '' ? readHeader(agent) : fromProjection
  return id === '' ? undefined : id
}

/**
 * Which preset a session is *actually* on, right now.
 *
 * The header records the preset the session was **created** with. A blank
 * session can change preset afterwards, and the header keeps the old value — so
 * reading it can take over a session that has already moved on, or run a native
 * session as though it were ACP. DSH's own code reads the projection
 * (`ctx.sessionProjections.stateOf(session, 'agentPreset')`) for this reason;
 * supply that here when it is available.
 */
export type PresetResolver = (agent: AgentLike) => string | undefined

/**
 * Read the preset out of a projection state value.
 *
 * Verified against `reference/deepseek-harness` @ 5badb15009
 * (`agent-preset-registry/src/session.ts:34-44`): the `agentPreset` projection's
 * state **is** the preset string itself (`string | null`), not an object
 * wrapping it. A reader that only unwraps `state.agentPreset` therefore answers
 * "nothing" on every real host while looking correct in isolation. Both shapes
 * are accepted here so the one question — which preset is this session on —
 * keeps one answer wherever it is asked.
 */
export function presetOfState(state: unknown): string | undefined {
  if (typeof state === 'string') return state === '' ? undefined : state
  const wrapped = (typeof state === 'object' && state !== null ? state : {}) as { agentPreset?: unknown }
  const nested = wrapped['agentPreset']
  return typeof nested === 'string' && nested !== '' ? nested : undefined
}

/**
 * Flat on the header. Reading `header.meta.agentPreset` — as the design document
 * originally had it — yields undefined forever, so dispatch silently falls back
 * to the native agent with no error anywhere.
 *
 * Tolerates an agent whose shape this does not recognise: "not ours" is the
 * safe reading, and throwing would take down a session we were only meant to
 * leave alone.
 */
function readHeader(agent: AgentLike): string | undefined {
  return agent.session?.header?.agentPreset
}

/** Read a `step` implementation off an instance or its prototype chain. */
function readStep(
  agent: object,
): ((decision: StepDecisionLike) => Promise<StepEndReason | null>) | undefined {
  const own = (agent as { step?: unknown }).step
  if (typeof own === 'function') return own as (decision: StepDecisionLike) => Promise<StepEndReason | null>
  const inherited = (Object.getPrototypeOf(agent) as { step?: unknown } | null)?.step
  if (typeof inherited === 'function') {
    return inherited as (decision: StepDecisionLike) => Promise<StepEndReason | null>
  }
  return undefined
}

/** Install `step` as an own property, shadowing the prototype's for this agent alone. */
function writeStep(
  agent: object,
  step: (decision: StepDecisionLike) => Promise<StepEndReason | null>,
): void {
  Object.defineProperty(agent, 'step', { value: step, writable: true, configurable: true, enumerable: false })
}

/**
 * Replace one agent's `step` when its preset names an external agent.
 *
 * Patches the **instance**, not the prototype: the class is shared by every
 * session, so a prototype patch would change native sessions too. The original
 * is kept and called for anything this plugin does not claim.
 *
 * @returns whether the agent was taken over.
 */
export function installAcpDispatch(
  agent: AgentLike,
  presets: ReadonlyMap<string, AcpPresetBinding>,
  options: AcpDispatchOptions,
): boolean {
  const binding = resolvePreset(agent, presets, options.presetOf)
  if (binding === undefined) return false

  const original = readStep(agent)
  if (original === undefined) {
    // Loud, because the alternative is a session that silently never answers.
    throw new Error('acp dispatch: this agent has no step to replace')
  }

  const active = new WeakSet<object>()
  writeStep(agent, async function acpStep(
    this: AgentLike,
    decision: StepDecisionLike,
  ): Promise<StepEndReason | null> {
    // Guard against re-entry: another plugin patching the loop must not be able
    // to make this call itself.
    if (active.has(this)) return original.call(this, decision)
    active.add(this)
    try {
      // Run first: the content events describe what the turn produced, so
      // producing them beforehand would write the previous turn's remainder.
      // The turn owns its own writing, including the stream's closing frame:
      // that frame has to follow the durable append, and the append belongs
      // to this session while the stream belongs to the turn. Splitting them
      // across two places is what left streaming unwired for so long.
      const result = await binding.run(decision, {
        sessionId: sessionIdOf(this) ?? '',
        produce: options.produce,
        write: options.write,
        ...(options.openStream === undefined ? {} : { openStream: options.openStream(this) }),
      })
      return result.end
    } finally {
      active.delete(this)
    }
  })
  return true
}

/** This agent's session id, which the external conversation is keyed by. */
function sessionIdOf(agent: { readonly id?: unknown; readonly session?: unknown }): string | undefined {
  if (typeof agent.id === 'string') return agent.id
  const session = agent.session as { readonly id?: unknown } | undefined
  return typeof session?.id === 'string' ? session.id : undefined
}
