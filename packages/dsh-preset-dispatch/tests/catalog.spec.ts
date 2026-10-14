/**
 * External agents presented to the model selector as providers.
 *
 * DSH's model catalog is Host-generation-global by design, and the adapter
 * contract explicitly blesses an adapter that only advertises models
 * ("Adapters used there must advertise their available models"). So each
 * external agent gets one provider route, and the existing UI — which already
 * renders provider + model — gains those groups with no client change.
 *
 * The route these models belong to is also the routing key: a selection tells
 * us which agent the session should be on, which is what makes "pick a model,
 * switch agent" work.
 */

import { describe, expect, it } from 'vitest'
import { catalogAdapter, presetForModel, providerRoute } from '../src/catalog.ts'
import { runtimeModels } from '../src/catalog-registration.ts'
import { grokDialect } from '@threadharbor/dsh-acp-agent'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419', model: 'grok-4.7' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp' },
  },
}

/** Answers with the models each agent reports for itself. */
const modelsOf = (presetId: string) => presetId === 'acp-grok'
  ? [{ id: 'grok-4.7', name: 'Grok 4.7' }, { id: 'grok-4.7-fast', name: 'Grok 4.7 Fast' }]
  : [{ id: 'claude-opus-4', name: 'Claude Opus 4', description: 'strongest' }]

describe('providerRoute', () => {
  it('gives each agent a route of its own', () => {
    expect(providerRoute('acp-grok')).not.toBe(providerRoute('acp-claude'))
  })

  it('builds a route that reads back as the same preset', () => {
    // The route is the only thing tying a catalog entry back to an agent, so
    // it has to survive a round trip through the id.
    expect(providerRoute('acp-grok')).toContain('acp-grok')
  })

  it('is stable across calls', () => {
    // A route that changed per call would make every lookup miss.
    expect(providerRoute('acp-claude')).toBe(providerRoute('acp-claude'))
  })
})

/** Read a stream to its end; rejections propagate. */
async function readStream(iterable: AsyncIterable<{ type: string }>): Promise<{ type: string }[]> {
  const chunks: { type: string }[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** A stand-in answerer that records the request and streams one text block. */
function fakeGateway() {
  const seen: {
    sessionId: string
    presetId: string
    modelId?: string
    reasoningEffort?: string
    messages: readonly unknown[]
    position: { turn: number; step: number }
  }[] = []
  return {
    seen,
    gateway: {
      answer: async (sessionId: string, presetId: string, request: {
        messages: readonly unknown[]
        modelId?: string
        reasoningEffort?: string
        position: { turn: number; step: number }
      }, sink: { chunk(c: unknown): void }) => {
        seen.push({ sessionId, presetId, ...request })
        sink.chunk({ type: 'block-start', index: 0, blockType: 'text' })
        sink.chunk({ type: 'text-delta', index: 0, text: '答' })
        sink.chunk({ type: 'block-end', index: 0, block: { type: 'text', text: '答' } })
        sink.chunk({ type: 'finish', reason: { kind: 'stop' } })
      },
    },
  }
}

describe('catalogAdapter', () => {
  const adapter = catalogAdapter(CONFIG, { modelsOf, dialectOf: () => grokDialect })

  it('names the provider after the agent, for humans', () => {
    expect(adapter.providerInfo(providerRoute('acp-grok')).name).toBe('Grok')
  })

  it('advertises the models that agent actually reports', async () => {
    const models = await adapter.listModels(providerRoute('acp-claude'))
    expect(models).toEqual([{
      provider: providerRoute('acp-claude'),
      id: 'claude-opus-4',
      name: 'Claude Opus 4',
      description: 'strongest',
    }])
  })

  it('attributes each model to the route that owns it', async () => {
    const models = await adapter.listModels(providerRoute('acp-grok'))
    expect(models.every(m => m.provider === providerRoute('acp-grok'))).toBe(true)
  })

  it('reports nothing for a route it does not own', async () => {
    // Returning another agent's models here would show them under the wrong
    // provider, and selecting one would switch to an agent that cannot serve it.
    expect(await adapter.listModels('deepseek')).toEqual([])
  })

  it('answers the exact-model lookup the host makes, with the declared metadata', async () => {
    // The catalog resolves every advertised model once at build time; a missing
    // `resolveModel` turns the whole group into a catalog failure and the picker
    // silently drops it.
    expect(await adapter.resolveModel(providerRoute('acp-claude'), 'claude-opus-4')).toEqual({
      provider: providerRoute('acp-claude'),
      id: 'claude-opus-4',
      name: 'Claude Opus 4',
      description: 'strongest',
    })
  })

  it('answers an undeclared model id without throwing', async () => {
    // The host also resolves model ids that never went through the catalog
    // (a session stamped with one before the list changed, for instance). The
    // runtime's own default answer is identity metadata; ours must keep that
    // contract instead of failing the lookup.
    expect(await adapter.resolveModel(providerRoute('acp-grok'), 'unlisted-model')).toEqual({
      provider: providerRoute('acp-grok'),
      id: 'unlisted-model',
      name: 'unlisted-model',
    })
  })

  it('refuses without a session, loudly, naming the route that asked', async () => {
    // Nowhere to hang an in-place answer on: the refusal names the route so
    // the failure cannot read as a healthy empty answer.
    await expect(readStream(adapter.stream({
      provider: providerRoute('acp-grok'), model: 'grok-4.7',
    }))).rejects.toThrow(/acp:acp-grok\/grok-4\.7/s)
  })

  it('answers a foreign conversation request in place through the gateway', async () => {
    // The pick never moves the conversation: the gateway borrows the agent as
    // a model and its answer arrives as this route's own chunk stream.
    const { gateway, seen } = fakeGateway()
    const hooked = catalogAdapter(CONFIG, {
      modelsOf,
      dialectOf: () => grokDialect,
      gateway,
    })
    const messages = [{ role: 'user', content: [{ type: 'text', text: '问' }] }]
    const chunks = await readStream(hooked.stream({
      provider: providerRoute('acp-grok'), model: 'grok-4.7', sessionId: 's1', messages,
    }))
    expect(chunks.map(c => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(seen).toEqual([{
      sessionId: 's1',
      presetId: 'acp-grok',
      modelId: 'grok-4.7',
      messages,
      // GenerateOptions has no step numbers; a placeholder must still arrive —
      // the runner's card bookkeeping reads position.turn and crashed on
      // undefined the first time this wire shipped without it.
      position: { turn: 0, step: 0 },
    }])
  })

  it('keeps its refusal when a request carries no session to answer in', async () => {
    const { gateway, seen } = fakeGateway()
    const hooked = catalogAdapter(CONFIG, {
      modelsOf,
      dialectOf: () => grokDialect,
      gateway,
    })
    await expect(readStream(hooked.stream({
      provider: providerRoute('acp-grok'), model: 'grok-4.7',
    }))).rejects.toThrow(/never streams on its own/)
    expect(seen).toEqual([])
  })

  it('refuses background housekeeping requests without touching the switch hook', async () => {
    // Title generation and compaction borrow the session's route but are not
    // conversation turns: letting them reach the switch chain would race the
    // turn's own switch — or fork a session whose first prompt is the title
    // question. They refuse by name instead; the title falls back to the
    // first-prompt text exactly as it already does for driven sessions.
    const { gateway, seen } = fakeGateway()
    const hooked = catalogAdapter(CONFIG, {
      modelsOf,
      dialectOf: () => grokDialect,
      gateway,
    })
    await expect(readStream(hooked.stream({
      provider: providerRoute('acp-grok'), model: 'grok-4.7', sessionId: 's1', purpose: 'session-title',
    }))).rejects.toThrow(/background session-title request/)
    await expect(readStream(hooked.stream({
      provider: providerRoute('acp-grok'), model: 'grok-4.7', sessionId: 's1', purpose: 'compaction',
    }))).rejects.toThrow(/background compaction request/)
    expect(seen).toEqual([])
  })

  it('answers the per-step preparation the loop makes before any dispatch', async () => {
    // The loop resolves every native step through `llm.prepareCall()` before
    // the request is admitted (reference agent-loop `prepareRequest`), and the
    // runtime forwards that to the adapter unconditionally. The base class a
    // class-based adapter would inherit composes `resolveModel` + `stream`;
    // this is a plain object, so the method has to exist here or every step
    // on one of our routes dies as a TypeError before `stream` — and the
    // switch chain behind it — is ever reached.
    const prepared = await adapter.prepareCall(providerRoute('acp-claude'), 'claude-opus-4')
    expect(prepared.model).toEqual(await adapter.resolveModel(providerRoute('acp-claude'), 'claude-opus-4'))
    expect(typeof prepared.stream).toBe('function')
  })

  it('dispatches a prepared call with a session into the gateway', async () => {
    // Picking one of our models in a started session is answered in place at
    // that session's next turn: the native step prepares, then dispatches
    // through the prepared stream. The gateway must sit at the end of that
    // path, not only on the bare `stream` method.
    const { gateway, seen } = fakeGateway()
    const hooked = catalogAdapter(CONFIG, {
      modelsOf,
      dialectOf: () => grokDialect,
      gateway,
    })
    const prepared = await hooked.prepareCall(providerRoute('acp-grok'), 'grok-4.7')
    const chunks = await readStream(prepared.stream({
      provider: providerRoute('acp-grok'), model: 'grok-4.7', sessionId: 's1',
    }))
    expect(chunks.map(c => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(seen.map(entry => entry.sessionId)).toEqual(['s1'])
  })

  it('keeps the refusal when a prepared call has no session to answer in', async () => {
    const prepared = await adapter.prepareCall(providerRoute('acp-grok'), 'grok-4.7')
    await expect(readStream(prepared.stream({
      provider: providerRoute('acp-grok'), model: 'grok-4.7',
    }))).rejects.toThrow(/never streams on its own/)
  })
})

/**
 * The picker serves what the AGENT reported once it has reported, not the
 * operator's configured guess. `runtimeModelsOf` carries the models read off a
 * live `session/new` reply; `undefined` (no session has opened on this host
 * generation yet) degrades to the configured list, while a reported EMPTY list
 * is served as empty — the agent's own word beats a stale configuration.
 */
describe('catalogAdapter — model list from the live runtime', () => {
  it('serves the runtime report once one has arrived, replacing the configured list', async () => {
    const adapter = catalogAdapter(CONFIG, {
      modelsOf,
      dialectOf: () => grokDialect,
      runtimeModelsOf: presetId => presetId === 'acp-grok'
        ? [{ id: 'grok-5', name: 'Grok 5' }, { id: 'grok-5-fast', name: 'Grok 5 Fast' }]
        : undefined,
    })
    expect(await adapter.listModels(providerRoute('acp-grok'))).toEqual([
      { provider: providerRoute('acp-grok'), id: 'grok-5', name: 'Grok 5' },
      { provider: providerRoute('acp-grok'), id: 'grok-5-fast', name: 'Grok 5 Fast' },
    ])
  })

  it('serves a reported-empty list as empty — the stale configured list must not resurrect', async () => {
    // The agent answered the question "what do you serve" with "nothing".
    // Showing the configured models anyway would advertise sessions that
    // cannot run.
    const adapter = catalogAdapter(CONFIG, {
      modelsOf,
      dialectOf: () => grokDialect,
      runtimeModelsOf: presetId => presetId === 'acp-grok' ? [] : undefined,
    })
    expect(await adapter.listModels(providerRoute('acp-grok'))).toEqual([])
  })

  it('degrades to the configured list while no session has reported yet', async () => {
    // Before the first turn there is no runtime answer; the operator's
    // declaration keeps the picker usable instead of showing a dead group.
    const adapter = catalogAdapter(CONFIG, {
      modelsOf,
      dialectOf: () => grokDialect,
      runtimeModelsOf: () => undefined,
    })
    const models = await adapter.listModels(providerRoute('acp-grok'))
    expect(models.map(model => model.id)).toEqual(['grok-4.7', 'grok-4.7-fast'])
  })

  it('resolves an advertised runtime model against the runtime metadata', async () => {
    const adapter = catalogAdapter(CONFIG, {
      modelsOf,
      dialectOf: () => grokDialect,
      runtimeModelsOf: presetId => presetId === 'acp-grok'
        ? [{ id: 'grok-5', name: 'Grok 5', description: 'from the agent' }]
        : undefined,
    })
    expect(await adapter.resolveModel(providerRoute('acp-grok'), 'grok-5')).toEqual({
      provider: providerRoute('acp-grok'),
      id: 'grok-5',
      name: 'Grok 5',
      description: 'from the agent',
    })
  })
})

describe('runtimeModels holder', () => {
  it('keeps each preset’s report apart and replaces it on a later report', () => {
    const models = runtimeModels()
    expect(models.modelsOf('acp-grok')).toBeUndefined()
    models.record('acp-grok', [{ id: 'grok-5', name: 'Grok 5' }])
    models.record('acp-codex', [{ id: 'gpt-6', name: 'GPT-6' }])
    expect(models.modelsOf('acp-grok')).toEqual([{ id: 'grok-5', name: 'Grok 5' }])
    expect(models.modelsOf('acp-codex')).toEqual([{ id: 'gpt-6', name: 'GPT-6' }])
    // A later session/new replaces the list wholesale — a re-opened external
    // conversation reports what it serves now, not what it served before.
    models.record('acp-grok', [])
    expect(models.modelsOf('acp-grok')).toEqual([])
  })

  it('keeps only model-shaped entries the agent actually named', () => {
    // A frame field of the wrong shape is not a model; advertising it would
    // put a broken row in the picker.
    const models = runtimeModels()
    models.record('acp-grok', [
      { id: 'grok-5', name: 'Grok 5' },
      { name: 'no id' },
      { id: 7, name: 'numeric id' },
    ] as unknown as readonly { id: string; name: string }[])
    expect(models.modelsOf('acp-grok')).toEqual([{ id: 'grok-5', name: 'Grok 5' }])
  })
})

describe('presetForModel', () => {
  const deps = { modelsOf, dialectOf: () => grokDialect }

  it('maps a model back to the preset that serves it', () => {
    expect(presetForModel(CONFIG, deps, providerRoute('acp-grok'), 'grok-4.7-fast')).toBe('acp-grok')
  })

  it('maps every model of an agent, not just the configured one', () => {
    // Only the first model resolving would make the rest of the list unselectable.
    expect(presetForModel(CONFIG, deps, providerRoute('acp-grok'), 'grok-4.7')).toBe('acp-grok')
  })

  it('returns nothing for a model the agent does not serve', () => {
    expect(presetForModel(CONFIG, deps, providerRoute('acp-grok'), 'somebody-elses-model')).toBeUndefined()
  })

  it('returns nothing for a native provider', () => {
    expect(presetForModel(CONFIG, deps, 'deepseek', 'deepseek-chat')).toBeUndefined()
  })

  // Effort publishers (codex) declare base[effort] ids; the picker collapses
  // them to the base and rides effort separately, so the pick that arrives at
  // the switch chain names the bare base. Mapping that pick back to a preset
  // is what makes "pick a model, switch agent" fire at all for these agents.
  const CODEX: PresetConfig = { presets: { 'acp-codex': { agent: 'codex', command: 'codex-acp' } } }
  const codexDeps = {
    modelsOf: () => [{ id: 'gpt-6-astra[low]', name: 'low' }, { id: 'gpt-6-astra[high]', name: 'high' }],
    dialectOf: () => grokDialect,
  }

  it('maps a collapsed base pick to the preset that serves it at any effort', () => {
    expect(presetForModel(CODEX, codexDeps, providerRoute('acp-codex'), 'gpt-6-astra')).toBe('acp-codex')
  })

  it('still maps an exact suffixed id', () => {
    expect(presetForModel(CODEX, codexDeps, providerRoute('acp-codex'), 'gpt-6-astra[low]')).toBe('acp-codex')
  })

  it('returns nothing for a base the preset serves at no effort', () => {
    expect(presetForModel(CODEX, codexDeps, providerRoute('acp-codex'), 'gpt-5')).toBeUndefined()
  })
})

describe('zcode model plugin', () => {
  it('names ZCode in the picker and streams tool calls without the gateway', async () => {
    const { gateway, seen } = fakeGateway()
    const asked: { purpose?: unknown; tools?: unknown }[] = []
    const adapter = catalogAdapter(
      { presets: { 'acp-zcode': { agent: 'zcode', models: [{ id: 'GLM-5.3', name: 'GLM 5.3' }] } } },
      {
        modelsOf: () => [{ id: 'GLM-5.3', name: 'GLM 5.3' }],
        dialectOf: () => undefined,
        gateway,
        modelStream: (_presetId, request) => {
          asked.push({ purpose: request.purpose, tools: request.tools })
          return (async function* () {
            yield { type: 'tool-call-delta' as const, index: 0, id: 'c1', name: 'read', argumentsDelta: '{}' }
            yield { type: 'finish' as const, reason: { kind: 'tool-calls' as const } }
          })()
        },
      },
    )
    expect(adapter.providerInfo(providerRoute('acp-zcode'))).toEqual({ id: 'acp:acp-zcode', name: 'ZCode' })
    const chunks = await readStream(adapter.stream({
      provider: providerRoute('acp-zcode'),
      model: 'GLM-5.3',
      sessionId: 's1',
      purpose: 'compaction',
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    }))
    expect(chunks.map(chunk => chunk.type)).toEqual(['tool-call-delta', 'finish'])
    expect(asked).toEqual([{
      purpose: 'compaction',
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    }])
    expect(seen).toEqual([])
  })
})