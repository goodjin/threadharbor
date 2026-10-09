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

import type { AcpDialect } from '@threadharbor/dsh-acp-agent'

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
  readonly frames: readonly unknown[]
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
  readonly run: (decision: StepDecisionLike) => Promise<AcpStepResult>
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
  /** Append those events, in order. */
  readonly append: (event: ContentEvent) => void
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
  const id = presetOf === undefined ? readHeader(agent) : presetOf(agent)
  if (id === undefined || id === '') return undefined
  return presets.get(id)
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
      const result = await binding.run(decision)
      for (const event of options.produce(result)) options.append(event)
      return result.end
    } finally {
      active.delete(this)
    }
  })
  return true
}