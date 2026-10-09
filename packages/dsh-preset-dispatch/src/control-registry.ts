/**
 * Where an agent's controls live, keyed by preset id.
 *
 * On the context rather than in a module-level variable: the client side looks
 * these up by id, and a process-wide map would outlive the plugin that filled
 * it, so a second mount would inherit the first one's agents.
 */
import type { AgentControl } from './control.ts'

type WithControls = { [CONTROLS]?: Map<string, AgentControl> }
const CONTROLS = Symbol.for('threadharbor.agentControls')

export function controlsOf(ctx: object): Map<string, AgentControl> {
  const holder = ctx as WithControls
  holder[CONTROLS] ??= new Map<string, AgentControl>()
  return holder[CONTROLS]
}

/** What the client side can do to each configured agent. */
export function agentControls(ctx: object): ReadonlyMap<string, AgentControl> {
  return controlsOf(ctx)
}
