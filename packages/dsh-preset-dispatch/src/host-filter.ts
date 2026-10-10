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
 * An empty host list means no restriction, not "off" — which is
 * how a preset gets disabled without deleting its configuration.
 */
function offeredOn(preset: AcpPresetConfig, hostId: string): boolean {
  // Empty means no restriction, not "switched off". A configured field and an
  // omitted one both arrive as an empty list, so reading that as "off" left the
  // plugin mounted nowhere on any machine — verified by booting the web build.
  const hosts = preset.hosts ?? []
  if (hosts.length === 0) return true
  return hosts.includes(hostId)
}
