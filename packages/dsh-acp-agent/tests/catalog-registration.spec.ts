/**
 * Getting the ACP models into the model catalog.
 *
 * The catalog is global to one Host generation and DSH's own picker reads it,
 * so this is what makes an external agent's models appear in the composer
 * without replacing the picker. Without it the session runs on the external
 * agent but the model list stays native-only.
 */

import { describe, expect, it } from 'vitest'
import { attachAcpDispatch } from '../src/service.ts'
import { providerRoute } from '../src/catalog.ts'
import { catalogRoutes, modelsOfPreset } from '../src/catalog-registration.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp' },
    'acp-codex': { agent: 'codex', command: 'codex-acp' },
  },
}

function llm() {
  const registrations: { providers: string[]; adapter: { providerInfo(p: string): { id: string; name: string } } }[] = []
  return {
    registrations,
    registerAdapter: (providers: string[], adapter: { providerInfo(p: string): { id: string; name: string } }) => { registrations.push({ providers, adapter }) },
  }
}

function ctxWith(llmPort: ReturnType<typeof llm>) {
  return {
    on: () => {},
    llm: { registerAdapter: llmPort.registerAdapter },
  } as never
}

describe('catalogRoutes', () => {
  it('gives one route per preset', () => {
    expect(catalogRoutes(CONFIG).sort()).toEqual(
      ['acp:acp-claude', 'acp:acp-codex', 'acp:acp-grok'],
    )
  })

  it('gives no routes when there are no presets', () => {
    expect(catalogRoutes({ presets: {} })).toEqual([])
  })

  it('describes each route as an agent rather than a vendor', () => {
    // The provider entry is what the composer shows; a readable name next to
    // the model is what makes an external agent look like any other choice.
    const adapter = catalogAdapterFactory(CONFIG, {
      modelsOf: () => [{ id: 'grok-4.7', name: 'Grok 4.7' }],
      dialectOf: () => ({ name: 'grok' }) as never,
    })
    expect(adapter.providerInfo(providerRoute('acp-grok'))).toMatchObject({ id: 'acp:acp-grok' })
    expect(adapter.providerInfo(providerRoute('acp-grok')).name.length).toBeGreaterThan(0)
  })

  it('offers the models a preset declares', async () => {
    const withModels: PresetConfig = { presets: { 'acp-grok': { agent: 'grok', models: [{ id: 'grok-4.7', name: 'Grok 4.7' }] } } }
    const adapter = catalogAdapterFactory(withModels, {
      modelsOf: () => [{ id: 'grok-4.7', name: 'Grok 4.7' }],
      dialectOf: () => undefined,
    })
    // The catalog entry carries the route, so an entry is self-describing when
    // it reaches the picker rather than depending on its column.
    expect(await adapter.listModels(providerRoute('acp-grok'))).toEqual([
      { provider: 'acp:acp-grok', id: 'grok-4.7', name: 'Grok 4.7' },
    ])
  })
})

describe('a preset that opts out of effort collapse', () => {
  it('keeps each config-suffixed model id as its own row, with no reasoning axis', async () => {
    // Cursor's ids carry a config bundle (context/reasoning/fast), not a single
    // effort axis. Collapsing would merge distinct configs into one row; with
    // collapseEfforts:false each id stays its own row.
    const cursorModels = [
      { id: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]', name: 'grok-4.7' },
      { id: 'grok-4.7[context=256k,reasoning_effort=low,fast=false]', name: 'grok-4.7' },
    ]
    const cursorConfig: PresetConfig = { presets: { 'acp-cursor': { agent: 'cursor', collapseEfforts: false, models: cursorModels } } }
    const adapter = catalogAdapterFactory(cursorConfig, {
      modelsOf: () => cursorModels,
      dialectOf: () => undefined,
    })
    const models = await adapter.listModels(providerRoute('acp-cursor'))
    expect(models.map(model => model.id)).toEqual([
      'grok-4.7[context=256k,reasoning_effort=high,fast=true]',
      'grok-4.7[context=256k,reasoning_effort=low,fast=false]',
    ])
    for (const model of models) expect(model.reasoning).toBeUndefined()
  })
})

import { catalogAdapter as catalogAdapterFactory } from '../src/catalog.ts'

describe('attachAcpDispatch catalog wiring', () => {
  it('registers one adapter covering every preset route', () => {
    const llmPort = llm()
    attachAcpDispatch(ctxWith(llmPort), CONFIG, { answerPermission: async () => ({ outcome: 'reject' }), positionOf: () => ({ turn: 1, step: 1 }) })
    expect(llmPort.registrations).toHaveLength(1)
    expect(llmPort.registrations[0]!.providers.sort()).toEqual(['acp:acp-claude', 'acp:acp-codex', 'acp:acp-grok'])
  })

  it('registers nothing when there are no presets', () => {
    // An empty registration is rejected by the runtime, so it must not be made.
    const llmPort = llm()
    attachAcpDispatch(ctxWith(llmPort), { presets: {} }, { answerPermission: async () => ({ outcome: 'reject' }), positionOf: () => ({ turn: 1, step: 1 }) })
    expect(llmPort.registrations).toEqual([])
  })

  it('registers nothing when the host has no model registry', () => {
    // A host without one is not ours to fail over: the dispatch still runs.
    const ctx = { on: () => {} } as never
    expect(() => { attachAcpDispatch(ctx, CONFIG, { answerPermission: async () => ({ outcome: 'reject' }), positionOf: () => ({ turn: 1, step: 1 }) }) }).not.toThrow()
  })
})

describe('没有传输方言的模型行', () => {
  const noDialect = { dialectFor: () => undefined }

  it('模型列表照配置给出——这一行没有子进程，配置里的就是它能答的模型', () => {
    // 这一类行（zcode、minimaxi）由 DSH 自己的循环应答，没有帧方言。曾经这里
    // 只认 zcode，于是 minimaxi 那一行挂上了、也注册了，模型选择器却是空的。
    const config: PresetConfig = {
      presets: {
        'acp-minimaxi': {
          agent: 'minimaxi',
          models: [{ id: 'MiniMax-M3.1-Flash', name: 'M3.1 Flash' }, { id: 'MiniMax-M3', name: 'MiniMax M3' }],
        },
      },
    }
    expect(modelsOfPreset(config, noDialect, 'acp-minimaxi').map(model => model.id))
      .toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3'])
  })

  it('真正的外部 agent 没有方言时仍然不公布模型', () => {
    const config: PresetConfig = {
      presets: { 'acp-grok': { agent: 'grok', models: [{ id: 'grok-4', name: 'grok' }] } },
    }
    expect(modelsOfPreset(config, noDialect, 'acp-grok')).toEqual([])
  })
})
