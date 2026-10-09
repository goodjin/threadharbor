/**
 * Turning configuration into the preset table the dispatcher consults.
 *
 * Only ACP presets belong in this table, and a native preset must be **absent**
 * rather than present-and-skipped: absence is what lets the dispatcher leave
 * those sessions completely alone, with nothing left to forget.
 */

import type { AcpDialect } from '@threadharbor/dsh-acp-agent'
import type { AcpPresetBinding } from './dispatch.ts'
import type { RunnerOptions } from './runner.ts'

/** One configured external agent. */
export type AcpPresetConfig = {
  /** Which agent this is; picks the frame dialect. */
  readonly agent?: string
  /** WebSocket URL, for agents that expose one. */
  readonly url?: string
  /** Command to spawn, for agents that run as a child process. */
  readonly command?: string
  readonly model?: string
  readonly mode?: string
  readonly cwd?: string
}

export type PresetConfig = { readonly presets: Readonly<Record<string, AcpPresetConfig>> }

/** What one session needs from an opened agent. */
export type AcpSession = {
  run: AcpPresetBinding['run']
}

/** How an agent is reached; separate so tests can stand in for spawning. */
export type AcpSessionFactory = {
  /**
   * The frame dialect for one preset, or `undefined` for an agent this plugin
   * does not handle.
   *
   * The check is on the **agent**, not on the preset being configured. A native
   * preset listed here would otherwise be taken over by accident, and native
   * sessions are the one thing that must never change.
   */
  dialectFor(presetId: string, config: AcpPresetConfig): AcpDialect | undefined
  /** Open the agent for one DSH session. Called once per session. */
  open(presetId: string, options: RunnerOptions): AcpSession
}

/**
 * Build the preset table.
 *
 * One agent is opened per session on first use and reused after — opening is
 * the expensive part, and a DSH session runs many turns.
 */
export function buildPresetTable(
  config: PresetConfig,
  factory: AcpSessionFactory,
): Map<string, AcpPresetBinding> {
  const table = new Map<string, AcpPresetBinding>()
  for (const [presetId, preset] of Object.entries(config.presets)) {
    if (preset.agent === undefined) continue
    const dialect = factory.dialectFor(presetId, preset)
    // Not an agent we drive: leave whatever that preset is entirely alone.
    if (dialect === undefined) continue
    let opened: AcpSession | undefined
    table.set(presetId, {
      dialect,
      run: async decision => {
        opened ??= factory.open(presetId, {
          cwd: preset.cwd ?? process.cwd(),
          ...(preset.model === undefined ? {} : { modelId: preset.model }),
          ...(preset.mode === undefined ? {} : { modeId: preset.mode }),
        })
        return opened.run(decision)
      },
    })
  }
  return table
}