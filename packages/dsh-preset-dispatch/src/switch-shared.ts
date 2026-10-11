/**
 * What every mounted row of this plugin shares, in one place.
 *
 * A switch is a cross-row act: a session on the grok row picks a codex model,
 * and the session it continues in is driven by the codex row. The two halves
 * meet here, because rows cannot see each other's composition — a row is
 * mounted inside its own preset's scope, and the registry's leak audit rightly
 * forbids a row from providing services the others could read.
 *
 * Two facts make a process-global module the honest shape rather than a hack:
 * each DSH process hosts exactly one machine's preset registry (design doc
 * §2.7c — one preset registry per process, isolated across hosts by nature),
 * and every row of this plugin in the process imports one module instance.
 * A host restart clears both tables, which is correct: nothing links the old
 * process's handovers to the new one, and the presets remount from config.
 */

import type { AcpPresetConfig, PresetConfig } from './registry.ts'

/** One model a mounted preset serves, with what planning needs to know about it. */
export type MountedModel = {
  readonly id: string
  readonly name: string
  readonly description?: string
  /**
   * The target's context window in tokens, when the configuration declares one.
   *
   * Declared, never probed: the planner may refuse a switch only on a number
   * the target actually claims, and the catalog is deliberately built without
   * opening the agent. An absent number means "unknown", and the handover
   * then never refuses on size.
   */
  readonly contextWindow?: number
}

/** The switch one source session already made, so a repeat points instead of duplicating. */
export type SwitchRecord = { readonly target: string; readonly sessionId: string }

/** What one row registers about itself at mount, for the other rows' switches. */
export type SwitchShared = {
  /** Add one mounted preset with the models it offers here. */
  registerPreset(presetId: string, preset: AcpPresetConfig, models: readonly MountedModel[]): void
  /** Every mounted preset, as the planner's view of what this host can switch to. */
  config(): PresetConfig
  /** The models one mounted preset serves here; empty for an unknown preset. */
  modelsOf(presetId: string): readonly MountedModel[]
  /** The declared window of one exact model, when its configuration names one. */
  contextWindowOf(presetId: string, modelId: string): number | undefined
  /** Whether a session id is still a live session on this host. */
  sessionExists(sessionId: string): boolean
  /** Give the host's session service to the liveness check; the entry wires this at mount. */
  wireSessions(reader: ((sessionId: string) => unknown) | undefined): void

  /** Store the text that primes a new conversation's first model request. */
  primeHandover(sessionId: string, text: string): void
  /** Take the priming text for a session, removing it — the first attempt owns it. */
  takeHandover(sessionId: string): string | undefined
  /** Put a priming text back after its first attempt failed to deliver it. */
  restoreHandover(sessionId: string, text: string): void

  /** Remember the switch a source session already made. */
  recordSwitch(sourceSessionId: string, record: SwitchRecord): void
  /** The switch a source session already made, while its new session still exists. */
  switchFor(sourceSessionId: string): SwitchRecord | undefined
}

export function makeSwitchShared(reads: {
  /** Read a live session by id; absent when the host exposes none. */
  sessionById?(sessionId: string): unknown
} = {}): SwitchShared {
  const presets = new Map<string, { preset: AcpPresetConfig; models: readonly MountedModel[] }>()
  const primed = new Map<string, string>()
  const switched = new Map<string, SwitchRecord>()
  let sessionById = reads.sessionById
  return {
    registerPreset(presetId, preset, models): void {
      presets.set(presetId, { preset, models })
    },
    config(): PresetConfig {
      const entries: Record<string, AcpPresetConfig> = {}
      for (const [presetId, mounted] of presets) entries[presetId] = mounted.preset
      return { presets: entries }
    },
    modelsOf(presetId): readonly MountedModel[] {
      return presets.get(presetId)?.models ?? []
    },
    contextWindowOf(presetId, modelId): number | undefined {
      const found = presets.get(presetId)?.models.find(model => model.id === modelId)
      const window = found?.contextWindow
      return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined
    },
    sessionExists(sessionId): boolean {
      if (sessionById === undefined) return true
      return sessionById(sessionId) !== undefined
    },
    wireSessions(reader): void {
      sessionById = reader
    },
    primeHandover(sessionId, text): void {
      primed.set(sessionId, text)
    },
    takeHandover(sessionId): string | undefined {
      const text = primed.get(sessionId)
      if (text !== undefined) primed.delete(sessionId)
      return text
    },
    restoreHandover(sessionId, text): void {
      primed.set(sessionId, text)
    },
    recordSwitch(sourceSessionId, record): void {
      switched.set(sourceSessionId, record)
    },
    switchFor(sourceSessionId): SwitchRecord | undefined {
      const record = switched.get(sourceSessionId)
      if (record === undefined) return undefined
      // A switch whose new session is gone (deleted, or the host restarted and
      // forgot it) no longer points anywhere: fall through and let the switch
      // be made again rather than naming a session that is not there.
      if (!this.sessionExists(record.sessionId)) return undefined
      return record
    },
  }
}

/**
 * The process-wide fabric every mounted row shares.
 *
 * Session liveness reads through the host's own session service when one is
 * injected (the entry wires it); standalone tests register without it, where
 * "still exists" means "not proven gone".
 */
export const switchShared: SwitchShared = makeSwitchShared()
