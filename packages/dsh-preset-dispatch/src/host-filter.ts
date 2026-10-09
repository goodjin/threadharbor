/**
 * Which presets a given host offers.
 *
 * With one tab per host, a preset that only makes sense on one machine — a local
 * codex, a grok relay reachable only from the office — must not appear on the
 * others. The default stays permissive: a preset with no constraint is available
 * everywhere, so adding a host filter is opt-in and existing configurations
 * keep working untouched.
 */

import type { AcpPresetConfig, PresetConfig } from './registry.ts'

export function presetsForHost(config: PresetConfig, hostId: string): PresetConfig {
  const presets: Record<string, AcpPresetConfig> = {}
  for (const [presetId, preset] of Object.entries(config.presets)) {
    if (!offeredOn(preset, hostId)) continue
    // Kept whole: filtering is how a preset gets chosen for display, not how it
    // gets rewritten — its model and mode still have to reach the agent.
    presets[presetId] = preset
  }
  return { presets }
}

/**
 * Whether this preset is offered here.
 *
 * An empty host list is a deliberate "off", not a missing constraint — which is
 * how a preset gets disabled without deleting its configuration.
 */
function offeredOn(preset: AcpPresetConfig, hostId: string): boolean {
  if (preset.hosts === undefined) return true
  return preset.hosts.includes(hostId)
}
