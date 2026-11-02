/**
 * Which preset a model request is answered by.
 *
 * One catalogue slot serves every model row, so this is where a preset that is
 * not a model plugin has to fall through to the gateway untouched, and where a
 * preset that is one must actually be claimed by it.
 */

import { describe, expect, it } from 'vitest'
import { describeClaimedModels, modelPluginStream } from '../src/model-plugins.ts'
import type { PresetConfig } from '../src/registry.ts'

const config = {
  presets: {
    'acp-zcode': { agent: 'zcode', models: [{ id: 'GLM-5.3', name: 'GLM 5.3' }] },
    'acp-minimax': { agent: 'minimaxi', models: [{ id: 'MiniMax-M3.1-Flash', name: 'M3.1 Flash' }] },
    'acp-codex': { agent: 'codex', models: [{ id: 'gpt-5', name: 'gpt-5' }] },
  },
} as unknown as PresetConfig

const request = { provider: 'minimaxi-cn', model: 'MiniMax-M3.1-Flash', messages: [], tools: [] }

describe('modelPluginStream', () => {
  it('claims a MiniMax row instead of letting it fall through to the gateway', () => {
    expect(modelPluginStream(config)('acp-minimax', request)).toBeDefined()
  })

  it('still claims the GLM row', () => {
    expect(modelPluginStream(config)('acp-zcode', { provider: 'zai-coding-cn', model: 'GLM-5.3', messages: [], tools: [] })).toBeDefined()
  })

  it('declines an ACP agent row, which belongs to the gateway path', () => {
    expect(modelPluginStream(config)('acp-codex', request)).toBeUndefined()
  })

  it('declines a preset nobody owns', () => {
    expect(modelPluginStream(config)('nope', request)).toBeUndefined()
  })
})

describe('describeClaimedModels', () => {
  it('names every row answered in place, so a missing one is visible in the log', () => {
    expect(describeClaimedModels(config)).toBe('acp-zcode=zcode acp-minimax=minimaxi')
  })

  it('says none rather than leaving an empty gap in the startup line', () => {
    const bare = { presets: { 'acp-codex': { agent: 'codex', models: [] } } } as unknown as PresetConfig
    expect(describeClaimedModels(bare)).toBe('none')
  })
})
