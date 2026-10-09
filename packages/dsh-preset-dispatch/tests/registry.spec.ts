/**
 * Turning configuration into the preset table the dispatcher consults.
 *
 * Only ACP presets belong in this table. A native preset must be absent, not
 * present-and-skipped: absence is what lets the dispatcher leave those sessions
 * completely alone.
 */

import { describe, expect, it } from 'vitest'
import { buildPresetTable } from '../src/registry.ts'
import type { AcpSessionFactory } from '../src/registry.ts'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'

/** A dialect is only ever read as an opaque handle by the registry. */
const stubDialect = (id: string): AcpDialect =>
  ({ id, foldTool: () => ({ callId: '', name: '', arguments: {} }), toolOutput: () => '', readModels: () => [], readUpdateTokens: () => undefined, isContent: () => true }) as unknown as AcpDialect

const CONFIG = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419', model: 'grok-4.7' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp', mode: 'default' },
  },
} as const

function fakeFactory(): AcpSessionFactory & { built: string[] } {
  const built: string[] = []
  return {
    built,
    dialectFor: presetId => stubDialect(presetId),
    open: presetId => {
      built.push(presetId)
      return { run: async () => ({ frames: [], end: { kind: 'completed' } }) }
    },
  }
}

describe('buildPresetTable', () => {
  it('includes exactly the configured ACP presets', () => {
    const table = buildPresetTable(CONFIG, fakeFactory())
    expect([...table.keys()].sort()).toEqual(['acp-claude', 'acp-grok'])
  })

  it('says nothing about a preset naming an agent it does not drive', () => {
    // A native session must not be taken over, and it can reach this config.
    // The check is on the agent, not on the preset being listed.
    const factory: AcpSessionFactory = {
      dialectFor: (presetId, config) => config.agent === 'native' ? undefined : stubDialect(presetId),
      open: () => ({ run: async () => ({ frames: [], end: { kind: 'completed' } }) }),
    }
    const table = buildPresetTable({ presets: { dsh: { agent: 'native' }, 'acp-grok': CONFIG.presets['acp-grok'] } }, factory)
    expect(table.has('dsh')).toBe(false)
    expect(table.has('acp-grok')).toBe(true)
  })

  it('opens one agent per session, not one per turn', async () => {
    const factory = fakeFactory()
    const table = buildPresetTable(CONFIG, factory)
    const binding = table.get('acp-grok')!
    const decision = { kind: 'enter' as const, messages: [] }

    await binding.run(decision)
    await binding.run(decision)

    expect(factory.built).toEqual(['acp-grok'])
  })

  it('gives each preset its own agent', async () => {
    const factory = fakeFactory()
    const table = buildPresetTable(CONFIG, factory)
    await table.get('acp-grok')!.run({ kind: 'enter', messages: [] })
    await table.get('acp-claude')!.run({ kind: 'enter', messages: [] })

    expect(factory.built).toEqual(['acp-grok', 'acp-claude'])
  })

  it('carries the configured model and mode through to the agent', async () => {
    // Dropping them would run the agent on its own defaults while the UI shows
    // the configured ones.
    const opened: { presetId: string; modelId?: string; modeId?: string }[] = []
    const factory: AcpSessionFactory = {
      dialectFor: () => stubDialect('x'),
      open: (presetId, options) => {
        opened.push({ presetId, ...(options.modelId === undefined ? {} : { modelId: options.modelId }), ...(options.modeId === undefined ? {} : { modeId: options.modeId }) })
        return { run: async () => ({ frames: [], end: { kind: 'completed' } }) }
      },
    }

    const table = buildPresetTable(CONFIG, factory)
    await table.get('acp-grok')!.run({ kind: 'enter', messages: [] })
    await table.get('acp-claude')!.run({ kind: 'enter', messages: [] })
    expect(opened).toContainEqual({ presetId: 'acp-grok', modelId: 'grok-4.7' })
    expect(opened).toContainEqual({ presetId: 'acp-claude', modeId: 'default' })
  })

  it('ignores a preset whose configuration names no agent', () => {
    const table = buildPresetTable({ presets: { broken: {} } } as never, fakeFactory())
    expect(table.size).toBe(0)
  })
})