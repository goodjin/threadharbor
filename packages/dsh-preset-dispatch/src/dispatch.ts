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
  | {
    /**
     * The turn ended because its conversation was handed over: a model pick
     * asked for another agent, and the switch carried the conversation and the
     * question into the session named here. Not a failure — the loop records
     * it as the turn's ending, and `TurnEndReasonMap` (the host's
     * merge-extensible union of endings) is the declared place for a plugin
     * variant whose loss cannot misread the log. Clients that do not know the
     * kind ignore it, which is exactly how DSH's own readers treat endings
     * they do not own.
     */
    readonly kind: 'agent-switch/handover'
    /** The preset the conversation moved to, as a `acp:` catalog id without the prefix. */
    readonly target: string
    /** The session that now carries the conversation and the question. */
    readonly sessionId: string
    /** The user-facing sentence describing the handover, composed at the switch. */
    readonly note: string
  }

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

/** Where in the loop the current step sits, as the loop itself numbers it. */
export type StepPosition = {
  readonly turn: number
  readonly step: number
}

/**
 * What one turn decided about the session's chosen model.
 *
 * Mirrors `decideSelection`; carried as a port result so the dispatch stays
 * mechanical and the row — which owns the preset's model list — decides. The
 * decision may take work (a mid-conversation switch is performed here, before
 * the turn runs anywhere), so the port may return a promise.
 */
export type TurnModelDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'own'; readonly modelId: string }
  | { readonly kind: 'refuse'; readonly reason: string }
  | {
    /**
     * The switch this pick asked for has already happened: the conversation
     * and the question now live in the session named by `sessionId`, and this
     * turn ends pointing there. The question is deliberately not written on
     * this session's log — it was asked, answered-to-be, in the session the
     * switch created, and recording it here too would put one question in two
     * conversations.
     */
    readonly kind: 'redirected'
    /** The preset the conversation moved to, without the `acp:` catalog prefix. */
    readonly target: string
    /** The session that now carries the conversation and the question. */
    readonly sessionId: string
    /** The user-facing sentence describing the handover, composed at the switch. */
    readonly note: string
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
   * number, and it is how the UI knows the text it watchedarrive is now
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
  /**
   * Where the loop numbers this step. Every event the turn writes carries these
   * numbers — the conversation view groups content under the step that declared
   * them, so content numbered differently from the boundaries is dropped on the
   * floor.
   */
  readonly position: StepPosition
  readonly produce: (result: AcpStepResult) => readonly ContentEvent[]
  /** Append the events; returns the message's sequence number. */
  readonly write: ContentWriter
  /** The model this turn asked for, when the session's own selection named one. */
  readonly modelId?: string
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
  /**
   * Where the loop numbers the step it is about to run.
   *
   * Read per turn, before anything is written. The loop announces the position
   * on its `agent/pre-step` waterfall and appends the boundaries itself, so this
   * is the only source the replaced step has; without it the content would be
   * written under numbers that match no step, and the view would drop it.
   */
  readonly positionOf: (agent: AgentLike) => StepPosition | undefined
  /** Turns what a turn produced into the events the session log should carry. */
  readonly produce: (result: AcpStepResult, position: StepPosition) => readonly ContentEvent[]
  /** Append those events, in order; returns the message's sequence number. */
  readonly write: ContentWriter
  /**
   * What this turn does about the session's chosen model, decided per turn.
   *
   * The replaced step never fires a model request, so the picker's choice would
   * otherwise sit unused while the preset's agent answers anyway. A refusal
   * throws, ending the turn as a named error; an own model rides the turn as
   * its `modelId`; a redirection ends the turn pointing at the session the
   * switch moved the conversation to. Handed the step's claimed messages so a
   * switch can carry the question it has not yet written anywhere.
   */
  readonly turnModel?: (agent: AgentLike, decision: StepDecisionLike) => TurnModelDecision | Promise<TurnModelDecision>
  /** Open this agent's live stream for a turn, if it can stream. */
  readonly openStream?: (agent: AgentLike, position: StepPosition) => () => TurnStreamHandle | undefined
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

/** Which agent is held by which binding, for the re-announce check and the caller's log silence. */
const held = new WeakMap<object, AcpPresetBinding>()

/**
 * Install `step` as an own property, shadowing the prototype's for this agent alone.
 *
 * Patches the **instance**, not the prototype: the class is shared by every
 * session, so a prototype patch would change native sessions too. The original
 * is kept and called for anything this plugin does not claim.
 *
 * A preset can also be chosen *after* the agent exists — the interface's preset
 * selector on a blank session rebinds the agent without firing `agent/created`
 * again — so the installed step re-reads the preset on every turn and hands the
 * turn back to the native step once the session no longer names this row.
 *
 * @returns whether the agent was taken over by this binding; `false` also when
 * this exact binding already holds the agent (a preset selected twice
 * re-announces itself — re-wrapping would stack a second takeover).
 */
export function installAcpDispatch(
  agent: AgentLike,
  presets: ReadonlyMap<string, AcpPresetBinding>,
  options: AcpDispatchOptions,
): boolean {
  const binding = resolvePreset(agent, presets, options.presetOf)
  if (binding === undefined) return false
  if (holdsAcpDispatch(agent, binding)) return false

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
    // Re-read the preset per turn (see the install comment): the registry's
    // rebind fires no event this module could observe, so a binding captured at
    // install time would keep driving a session that has since left — or, on a
    // host without a projection, hold the stale answer forever.
    const current = resolvePreset(this, presets, options.presetOf)
    if (current === undefined) return original.call(this, decision)
    // The loop states where it numbers this step on `agent/pre-step`, before it
    // appends the boundaries. Content written under any other numbers is
    // grouped under a step the view never saw start, and dropped — so without a
    // position the turn refuses rather than writes content nothing will show.
    const position = options.positionOf(this)
    if (position === undefined) {
      throw new Error('acp dispatch: the loop reported no position for this step; refusing to write content the view could not place')
    }
    active.add(this)
    try {
      // Decided before anything is written. A refusal still leaves the
      // question on this session's record; a switch must not record it here —
      // the question is asked, with the whole conversation, in the session the
      // switch created, and writing it here too would put one question in two
      // conversations' hands.
      const model = (await options.turnModel?.(this, decision)) ?? { kind: 'none' as const }
      if (model.kind === 'refuse') {
        // The user's claimed messages go on the log before the turn refuses,
        // the way the native step commits them — a refusal must still leave
        // the question on the record.
        options.write(userEvents(decision))
        throw new Error(model.reason)
      }
      if (model.kind === 'redirected') {
        // The switch succeeded, so the turn ends by naming where the
        // conversation went — a neutral ending, not a thrown error. Throwing
        // here is what made the client render this turn as a failure even
        // though the switch had worked; the loop appends whatever ending the
        // step returns as the turn's `turn/end` reason verbatim.
        return {
          kind: 'agent-switch/handover',
          target: model.target,
          sessionId: model.sessionId,
          note: model.note,
        }
      }
      // The user's claimed messages go on the log before the turn runs, the
      // way the native step commits them — they are the turn's input.
      options.write(userEvents(decision))
      // Run after the input is committed: the content events describe what the
      // turn produced, so producing them beforehand would write the previous
      // turn's remainder. The turn owns its own writing, including the stream's
      // closing frame: that frame has to follow the durable append, and the
      // append belongs to this session while the stream belongs to the turn.
      // Splitting them across two places is what left streaming unwired for so
      // long.
      const result = await current.run(decision, {
        sessionId: sessionIdOf(this) ?? '',
        position,
        produce: result => options.produce(result, position),
        write: options.write,
        ...(model.kind === 'own' ? { modelId: model.modelId } : {}),
        ...(options.openStream === undefined ? {} : { openStream: options.openStream(this, position) }),
      })
      return result.end
    } finally {
      active.delete(this)
    }
  })
  held.set(agent, binding)
  return true
}

/** The claimed messages, as the log's user-message events. */
function userEvents(decision: StepDecisionLike): readonly ContentEvent[] {
  return decision.messages.map(message => ({ type: 'user/message', payload: message }))
}

/**
 * Whether this exact binding already replaced the agent's step.
 *
 * The scope rebind that moves a blank session between presets fires no
 * `agent/created`, so the only way the same binding sees the same agent twice
 * is a preset selected twice — and each of those repeats the takeover log and
 * stacks a wrapper unless the holder is checked first.
 */
export function holdsAcpDispatch(agent: AgentLike, binding: AcpPresetBinding): boolean {
  return held.get(agent) === binding
}

/** This agent's session id, which the external conversation is keyed by. */
function sessionIdOf(agent: { readonly id?: unknown; readonly session?: unknown }): string | undefined {
  if (typeof agent.id === 'string') return agent.id
  const session = agent.session as { readonly id?: unknown } | undefined
  return typeof session?.id === 'string' ? session.id : undefined
}
