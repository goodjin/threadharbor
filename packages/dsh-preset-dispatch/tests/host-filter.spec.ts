/**
 * Which presets a given host offers.
 *
 * With one tab per host, a preset that only makes sense on one machine — a
 * local codex, a grok relay reachable only from the office — must not appear
 * on the others. The default stays permissive: a preset with no constraint is
 * available everywhere, so adding a host filter is opt-in.
 */

import { describe, expect, it } from 'vitest'
import { presetsForHost } from '../src/host-filter.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    anywhere: { agent: 'claude', command: 'claude-agent-acp' },
    'only-alpha': { agent: 'codex', command: 'codex-acp', hosts: ['alpha'] },
    'on-both': { agent: 'grok', url: 'ws://127.0.0.1:2419', hosts: ['alpha', 'beta'] },
    'on-none': { agent: 'grok', url: 'ws://127.0.0.1:2420', hosts: [] },
  },
}

const ids = (config: PresetConfig) => Object.keys(config.presets).sort()

describe('presetsForHost', () => {
  it('offers a preset with no host constraint everywhere', () => {
    expect(ids(presetsForHost(CONFIG, 'alpha'))).toContain('anywhere')
    expect(ids(presetsForHost(CONFIG, 'beta'))).toContain('anywhere')
  })

  it('offers a host-scoped preset only on that host', () => {
    expect(ids(presetsForHost(CONFIG, 'alpha'))).toContain('only-alpha')
    expect(ids(presetsForHost(CONFIG, 'beta'))).not.toContain('only-alpha')
  })

  it('offers a preset listed for several hosts on each of them', () => {
    expect(ids(presetsForHost(CONFIG, 'alpha'))).toContain('on-both')
    expect(ids(presetsForHost(CONFIG, 'beta'))).toContain('on-both')
  })

  it('offers a preset listed for no host nowhere', () => {
    // An empty list is a deliberate "switched off", not a missing constraint.
    expect(ids(presetsForHost(CONFIG, 'alpha'))).not.toContain('on-none')
    expect(ids(presetsForHost(CONFIG, 'beta'))).not.toContain('on-none')
  })

  it('leaves the other settings of a preset untouched', () => {
    // Filtering must not be how a preset gets rewritten — the model and mode
    // still have to reach the agent.
    const filtered = presetsForHost(CONFIG, 'beta')
    expect(filtered.presets['on-both']).toEqual(CONFIG.presets['on-both'])
  })

  it('does not modify the configuration it was given', () => {
    // The tab shows the filtered set; the config object is shared state and a
    // mutation here would leak one host's view into another's.
    const before = JSON.stringify(CONFIG)
    presetsForHost(CONFIG, 'alpha')
    expect(JSON.stringify(CONFIG)).toBe(before)
  })

  it('offers nothing on a host it has never heard of, except unconstrained ones', () => {
    expect(ids(presetsForHost(CONFIG, 'gamma'))).toEqual(['anywhere'])
  })
})