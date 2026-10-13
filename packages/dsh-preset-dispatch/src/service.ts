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
import { modelsOfPreset, registerCatalog, runtimeModels } from './catalog-registration.ts'
import { buildPresetTable, sessionsRegistry } from './registry.ts'
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
  write?(agent: unknown, events: readonly ContentEvent[]): number | undefined
  /**
   * Which preset a session is actually on, right now.
   *
   * Supply the live projection. The header only records the preset a session
   * was *created* with, and a blank session can change preset afterwards.
   */
  presetOf?(agent: AgentLike): string | undefined
  /**
   * Where the loop numbers the step it is about to run.
   *
   * Without a source for the numbers the replaced step has nothing true to write
   * its content under, so this one is required here the way the entry row's
   * listener is: supply it from the loop's `agent/pre-step` notice.
   */
  positionOf(agent: AgentLike): { readonly turn: number; readonly step: number } | undefined
}

export function attachAcpDispatch(
  ctx: ContextLike,
  config: PresetConfig,
  options: AttachOptions,
): void {
  // The agent's own `session/new` reports, per preset, shared by the factory
  // seam and the catalog registration below, so the picker and the sessions
  // read the same source.
  const runtimeModelReports = runtimeModels()
  const factory = makeSessionFactory(config, {
    ...options,
    // No catalog-owning caller supplied a report sink: record into the shared
    // ledger this attach registered the catalog with.
    ...(options.onRuntimeModels === undefined
      ? { onRuntimeModels: (presetId: string, models: readonly { id: string; name: string; description?: string }[]) => { runtimeModelReports.record(presetId, models) } }
      : {}),
  })
  const table = buildPresetTable(config, factory, sessionsRegistry())

  // What makes the external agent's models appear in DSH's own model picker:
  // the catalog is global to this Host generation and already read by it. The
  // list reads the agent's own report once a session has opened, and degrades
  // to the configured list until then.
  registerCatalog(ctx, config, {
    modelsOf: presetId => modelsOfPreset(config, factory, presetId),
    runtimeModelsOf: presetId => runtimeModelReports.modelsOf(presetId),
    dialectOf: presetId => table.get(presetId)?.dialect,
  })

  ctx.on('agent/created', payload => {
    const agent = payload.agent
    const binding = resolvePreset(agent as AgentLike, table, options.presetOf)
    // Not ours: leave this session exactly as it was.
    if (binding === undefined) return

    installAcpDispatch(agent as AgentLike & object, table, {
      ...(options.presetOf === undefined ? {} : { presetOf: options.presetOf }),
      positionOf: candidate => options.positionOf(candidate),
      produce: (result, position) =>
        // The numbers the loop announced stand: content grouped under any other
        // step is dropped by the conversation view.
        projectStepContent(result.frames, { turn: position.turn, step: position.step, dialect: binding.dialect }),
      write: events => options.write?.(agent, events),
    })
  })
}
