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
  /**
   * The models this agent serves, as offered in the model picker.
   *
   * Declared rather than probed: probing needs the agent to be running, and the
   * picker has to render before anyone has opened a session. An absent list
   * means the agent offers nothing here yet.
   */
  readonly models?: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  /**
   * Hosts this preset is offered on.
   *
   * Absent means everywhere — adding a constraint is opt-in. An empty list is
   * a deliberate "off", which is how a preset gets disabled without deleting it.
   */
  readonly hosts?: readonly string[]
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
    // One external conversation per DSH session, not per preset.
    //
    // Sharing one across sessions is the original bug: two conversations in the
    // same preset land in the same external session, so each one's answer shows
    // up in the other's history. The keys are session ids, and a session that
    // is gone drops its entry with it.
    const opened = new Map<string, AcpSession>()
    table.set(presetId, {
      dialect,
      run: async (decision, turn) => {
        let session = opened.get(turn.sessionId)
        if (session === undefined) {
          session = factory.open(presetId, {
            cwd: preset.cwd ?? process.cwd(),
            ...(preset.model === undefined ? {} : { modelId: preset.model }),
            ...(preset.mode === undefined ? {} : { modeId: preset.mode }),
          })
          opened.set(turn.sessionId, session)
        }
        return session.run(decision, turn)
      },
    })
  }
  return table
}