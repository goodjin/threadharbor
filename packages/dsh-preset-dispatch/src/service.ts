/**
 * Taking over ACP-backed sessions as they are created.
 *
 * `agent/created` is serial and awaited before the agent reaches the loop, and
 * queued input waits for its listeners — so patching here cannot race the first
 * turn. The payload carries the live agent, which is the only moment the preset
 * is worth reading.
 *
 * No imports from the DSH runtime packages, on purpose: the published versions
 * lag far behind what actually runs (0.1.0-rc.6 published, 0.2.0-rc.2 running),
 * and `ReactLoopAgent` cannot be imported at all — it is re-exported from
 * nowhere and its package exposes no subpath for it. So this states the one
 * event it listens for, and the caller adapts.
 */

import { projectStepContent } from '@threadharbor/dsh-acp-agent'
import { installAcpDispatch, resolvePreset } from './dispatch.ts'
import type { AgentLike } from './dispatch.ts'
import type { ContentEvent } from './dispatch.ts'
import { makeSessionFactory } from './factory.ts'
import type { FactoryDeps } from './factory.ts'
import { buildPresetTable } from './registry.ts'
import type { PresetConfig } from './registry.ts'

/** The part of a Cordis context this uses. */
type ContextLike = {
  on(event: 'agent/created', handler: (payload: { agent: unknown }) => void): unknown
}

export type AttachOptions = FactoryDeps & {
  /**
   * Where the events a turn produced are written.
   *
   * The native loop owns the turn and step boundaries, so only the content
   * events belong here.
   */
  write?(agent: unknown, events: readonly ContentEvent[]): void
}

export function attachAcpDispatch(ctx: ContextLike, config: PresetConfig, options: AttachOptions): void {
  const factory = makeSessionFactory(config, options)
  const table = buildPresetTable(config, factory)

  ctx.on('agent/created', payload => {
    const agent = payload.agent
    const binding = resolvePreset(agent as AgentLike, table)
    // Not ours: leave this session exactly as it was.
    if (binding === undefined) return

    installAcpDispatch(agent as AgentLike & object, table, {
      produce: result =>
        // Turn and step numbers are zero here on purpose: the surrounding
        // native loop owns both, and the replaced step supplies content only.
        // They are corrected where the events are written.
        projectStepContent(result.frames as never[], { turn: 0, step: 0, dialect: binding.dialect }),
      append: event => { options.write?.(agent, [event]) },
    })
  })
}
