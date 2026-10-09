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
import { registerCatalog } from './catalog-registration.ts'
import { buildPresetTable } from './registry.ts'
import type { AcpPresetConfig, PresetConfig } from './registry.ts'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'

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
  write?(agent: unknown, events: readonly ContentEvent[]): number | undefined
  /**
   * Which preset a session is actually on, right now.
   *
   * Supply the live projection. The header only records the preset a session
   * was *created* with, and a blank session can change preset afterwards.
   */
  presetOf?(agent: AgentLike): string | undefined
}

/** What a preset's agent reports it can serve. */
function modelsOf(
  config: PresetConfig,
  factory: { dialectFor(presetId: string, preset: AcpPresetConfig): AcpDialect | undefined },
  presetId: string,
): readonly { id: string; name: string; description?: string }[] {
  const preset = config.presets[presetId]
  if (preset === undefined) return []
  const dialect = factory.dialectFor(presetId, preset)
  // Not ours, or an agent that publishes nothing: no models to advertise.
  if (dialect === undefined) return []
  return preset.models ?? []
}

export function attachAcpDispatch(
  ctx: ContextLike,
  config: PresetConfig,
  options: AttachOptions,
): void {
  const factory = makeSessionFactory(config, options)
  const table = buildPresetTable(config, factory)

  // What makes the external agent's models appear in DSH's own model picker:
  // the catalog is global to this Host generation and already read by it.
  registerCatalog(ctx, config, {
    modelsOf: presetId => modelsOf(config, factory, presetId),
    dialectOf: presetId => table.get(presetId)?.dialect,
  })

  ctx.on('agent/created', payload => {
    const agent = payload.agent
    const binding = resolvePreset(agent as AgentLike, table, options.presetOf)
    // Not ours: leave this session exactly as it was.
    if (binding === undefined) return

    installAcpDispatch(agent as AgentLike & object, table, {
      ...(options.presetOf === undefined ? {} : { presetOf: options.presetOf }),
      produce: result =>
        // Turn and step numbers are zero here on purpose: the surrounding
        // native loop owns both, and the replaced step supplies content only.
        // They are corrected where the events are written.
        projectStepContent(result.frames, { turn: 0, step: 0, dialect: binding.dialect }),
      write: events => options.write?.(agent, events),
    })
  })
}
