/**
 * The plugin that actually runs inside a preset.
 *
 * An agent preset is a composition: selecting one mounts its rows. So an
 * external agent's behaviour has to come from a row inside that composition —
 * which is what this entry is. One row per agent, configured with that agent's
 * transport and dialect.
 *
 * The scope is the filter. A row only sees the agents mounted alongside it, so
 * a session on some other preset is never seen here and keeps its own behaviour
 * with nothing to undo.
 *
 * No imports from the DSH runtime packages, for the reason the rest of this
 * package avoids them: the published versions lag far behind what runs, and the
 * classes involved cannot be imported at all. So this states the one event it
 * listens for and the shape it needs, and the caller adapts.
 */

import { presetIdOf } from './dispatch.ts'
import type { AgentLike, PresetResolver } from './dispatch.ts'
import { buildPresetTable } from './registry.ts'
import type { AcpPresetConfig, PresetConfig } from './registry.ts'
import { makeSessionFactory } from './factory.ts'
import type { AcpPresetBinding } from './dispatch.ts'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'

/** The part of a Cordis context this entry touches. */
export type AcpPluginContext = {
  on(event: 'agent/created', handler: (payload: { agent: unknown }) => void): unknown
}

/** What the caller supplies, since the DSH-facing pieces stay behind ports. */
export type AcpPluginDeps = {
  /**
   * Take the session over: patch its step so the external agent drives it.
   *
   * Handed the dialect that was resolved, so the caller need not re-derive it.
   */
  install(agent: AgentLike, presetId: string, dialect: AcpDialect, table: ReadonlyMap<string, AcpPresetBinding>): void
  /**
   * Say what went wrong on a session this row claimed.
   *
   * Optional because most callers only care that a session was or was not taken
   * over — but a row that cannot report is a row that fails quietly.
   */
  report?(message: string): void
  /**
   * Which preset a session is on right now.
   *
   * The header records the preset a session was *created* with, so reading it
   * can take over a session that has since moved on, or run a native session
   * as though it were ours. DSH reads the projection; supply that when it is
   * available and the header only as a fallback.
   */
  presetOf?: PresetResolver | undefined
}

/**
 * Take over ACP-backed sessions in this plugin's scope.
 *
 * One session failing must not take the rest with it: `agent/created` is awaited
 * before the agent reaches the loop, so a throw here would strand that one
 * session with no step at all.
 */
export function applyAcpPlugin(
  ctx: AcpPluginContext,
  presetId: string,
  config: AcpPresetConfig,
  deps: AcpPluginDeps,
): void {
  const presets: PresetConfig = { presets: { [presetId]: config } }
  const factory = makeSessionFactory(presets, {
    answerPermission: () => Promise.resolve({ outcome: 'reject' }),
  })
  const dialect = factory.dialectFor(presetId, config)
  // An unknown agent is a configuration mistake. Taking sessions over anyway
  // would hand them to a dialect that does not exist; better to leave them on
  // the native agent, where they still work.
  if (dialect === undefined) return
  const table = buildPresetTable(presets, factory)

  ctx.on('agent/created', payload => {
    try {
      const agent = payload.agent as AgentLike
      if (presetIdOf(agent, deps.presetOf) !== presetId) return
      const binding = table.get(presetId)
      if (binding === undefined) return
      deps.install(agent, presetId, dialect, table)
    } catch (error) {
      // Left alone: whatever this session is, it keeps a working step. Said out
      // loud, though — a takeover that loads, matches, announces itself and then
      // throws here is indistinguishable from working, from the outside.
      deps.report?.(`acp takeover failed: ${String(error)}`)
    }
  })
}