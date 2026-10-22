/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive (codex and
 * grok both load a model catalogue and probe their environment during it), and a
 * DSH session is long-lived, so re-opening per turn would make every turn pay a
 * setup cost the agent already paid.
 */

import type { AcpFrame } from '@threadharbor/dsh-acp-agent'
import { claudeDialect, codexDialect, cursorDialect, grokDialect, qoderDialect } from '@threadharbor/dsh-acp-agent'
import { describe, expect, it } from 'vitest'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'
import type { StepDecisionLike } from '../src/dispatch.ts'

/** Records every call so the tests can assert on ordering and reuse. */
function fakeClient() {
  const calls: { method: string; params: unknown }[] = []
  let nextSession = 1
  const client: AcpClientPort & { calls: typeof calls } = {
    calls,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'session/new') {
        return { sessionId: `s${nextSession++}`, models: { availableModels: [{ modelId: 'm1', name: 'M1' }] } }
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    },
    notify: () => {},
    onFrame: () => {},
  }
  return client
}

const agentMessageChunk = (text: string) => ({
  method: 'session/update',
  params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
})
const agentThoughtChunk = (text: string) => ({
  method: 'session/update',
  params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } },
})

/** A turn context; streaming is supplied per turn, like the real caller does. */
const TURN = (stream: Record<string, unknown>) => ({ sessionId: 's1', position: { turn: 1, step: 1 },
  produce: (r: { frames: readonly unknown[]; end: unknown }) => [{ type: 'assistant/message', payload: { frames: r.frames.length } }],
  write: () => 1,
  openStream: () => ({ start: () => {}, records: () => [], abandon: () => {}, settle: () => {},
    ...stream } as never),
})

const DECISION: StepDecisionLike = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

describe('AcpTurnRunner', () => {
  it('opens a session on the first turn and reuses it after that', async () => {
    const client = fakeClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp' })

    await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    const news = client.calls.filter(call => call.method === 'session/new')
    expect(news).toHaveLength(1)
  })

  it('reads the model list off the session/new reply through the dialect', async () => {
    // The picker serves what the agent reports, so the reply's model list has
    // to reach the catalog the moment the session opens — read by the dialect,
    // because the agents disagree on where the list lives.
    const seen: unknown[] = []
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp', dialect: grokDialect, onModels: models => { seen.push(models) } })
      .run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    // fakeClient answers session/new with grok-shaped availableModels.
    expect(seen).toEqual([[{ id: 'm1', name: 'M1' }]])
  })

  it('reports a session/new reply that names no models as an empty list, not silence', async () => {
    // An agent that serves nothing must be able to say so through the same
    // channel; swallowing the report would leave the previous answer standing.
    const seen: unknown[] = []
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') return { sessionId: 's1' }
      return { stopReason: 'end_turn' }
    }
    await new AcpTurnRunner(client, { cwd: '/tmp', dialect: grokDialect, onModels: models => { seen.push(models) } })
      .run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    expect(seen).toEqual([[]])
  })

  it('authenticates between initialize and session/new when the port has one', async () => {
    // Cursor must authenticate (after an interactive `agent login`) before
    // session/new; the other agents have no such step and omit the method.
    const client = fakeClient()
    ;(client as AcpClientPort & { authenticate?: (initializeResult: unknown) => Promise<unknown> }).authenticate = async () => {
      client.calls.push({ method: 'authenticate', params: {} })
    }
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    const order = client.calls.map(call => call.method)
    expect(order).toContain('authenticate')
    // authenticate lands after initialize and before session/new — the order
    // cursor's handshake requires.
    expect(order.indexOf('authenticate')).toBeGreaterThan(order.indexOf('initialize'))
    expect(order.indexOf('authenticate')).toBeLessThan(order.indexOf('session/new'))
  })

  it('does not authenticate qoder when a logged-in session opens directly', async () => {
    // Qoder's CLI needs no authenticate round-trip once logged in, and calling
    // it anyway intermittently stalls for the whole open timeout (measured
    // 2026-10-20). The working path must not pay that call.
    const client = fakeClient()
    let auths = 0
    client.authenticate = async () => { auths += 1 }

    await new AcpTurnRunner(client, { cwd: '/tmp', dialect: qoderDialect })
      .run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    expect(client.calls.map(call => call.method)).not.toContain('authenticate')
    expect(auths).toBe(0)
  })

  it('authenticates qoder after session/new refuses for lack of login, then retries once', async () => {
    const client = fakeClient()
    const request = client.request
    let opens = 0
    client.request = async (method, params) => {
      if (method !== 'session/new') return await request(method, params)
      opens += 1
      client.calls.push({ method, params })
      if (opens === 1) {
        throw new Error('acp error: {"code":-32000,"message":"Authentication required: Authentication is required."}')
      }
      return { sessionId: 's1', models: { availableModels: [] } }
    }
    client.authenticate = async () => {
      client.calls.push({ method: 'authenticate', params: {} })
    }

    await new AcpTurnRunner(client, { cwd: '/tmp', dialect: qoderDialect })
      .run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    const order = client.calls.map(call => call.method)
    expect(order.filter(method => method === 'session/new')).toHaveLength(2)
    // The refusal comes first, then authenticate, then the one retry.
    expect(order.indexOf('authenticate')).toBeGreaterThan(order.indexOf('session/new'))
    expect(order.lastIndexOf('session/new')).toBeGreaterThan(order.indexOf('authenticate'))
  })

  it('does not retry qoder session/new on a failure that is not an auth refusal', async () => {
    const client = fakeClient()
    const request = client.request
    let auths = 0
    client.request = async (method, params) => {
      if (method !== 'session/new') return await request(method, params)
      client.calls.push({ method, params })
      throw new Error('acp error: {"code":-32602,"message":"Invalid params"}')
    }
    client.authenticate = async () => { auths += 1 }

    const result = await new AcpTurnRunner(client, { cwd: '/tmp', dialect: qoderDialect })
      .run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    expect(client.calls.filter(call => call.method === 'session/new')).toHaveLength(1)
    expect(auths).toBe(0)
    expect(result.end).toMatchObject({ kind: 'error' })
  })

  it('declares the subagents client capability in the handshake', async () => {
    // The ACP subagent draft (#1992) is bilateral: without
    // `clientCapabilities.subagents` the adapter keeps subagent lifecycle as
    // an ordinary tool call and never sends subagent_spawned frames. Both
    // codex-acp 1.10.0 and claude-agent-acp 0.76.0 on this machine implement
    // the draft, so asking for it turns the native frames on.
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    const init = client.calls.find(call => call.method === 'initialize')!
    expect((init.params as { clientCapabilities: Record<string, unknown> }).clientCapabilities['subagents'])
      .toEqual({})
  })

  it('also advertises subagents through the jetbrains.air meta the released SDKs keep', async () => {
    // Measured 2026-10-20: with only the draft field, both adapters still
    // projected delegations as ordinary tool calls ("Start subagent …" cards
    // on codex, an Agent tool card on claude — failure captures in
    // dsh-acp-agent/tests/fixtures/captured-subagent-frames.json). The
    // released @agentclientprotocol/sdk strips the draft field off
    // clientCapabilities at initialize; the adapters' documented fallback is
    // the `_meta.jetbrains.air` extension (version 1, capability list), which
    // the schema passes through. Advertise BOTH spellings: the meta one works
    // today, the canonical one wins once the SDK ships it.
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    const init = client.calls.find(call => call.method === 'initialize')!
    const capabilities = (init.params as { clientCapabilities: { _meta?: unknown } }).clientCapabilities
    const jetbrains = (capabilities._meta as Record<string, unknown>)['jetbrains'] as Record<string, unknown> | undefined
    const air = jetbrains?.['air'] as { version?: unknown; capabilities?: unknown } | undefined
    expect(air).toEqual({ version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] })
  })

  it('cursor reads the subagent capability under _meta, where its own check looks', async () => {
    // Measured 2026-10-21 against cursor 2026.10.01: `subagentsEnabled` is
    // `clientCapabilities.subagents || clientCapabilities._meta.subagents`,
    // and the released SDK strips the top-level field before it reaches the
    // agent. Only the meta spelling makes cursor send subagent frames and
    // resume the parent after the child finishes.
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp', dialect: cursorDialect })
      .run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    const init = client.calls.find(call => call.method === 'initialize')!
    const capabilities = (init.params as { clientCapabilities: { _meta?: Record<string, unknown> } }).clientCapabilities
    expect(capabilities._meta?.['subagents']).toEqual({})
  })

  it('sends the user’s text as the prompt', async () => {
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

    const prompt = client.calls.find(call => call.method === 'session/prompt')
    expect((prompt!.params as { prompt: { text: string }[] }).prompt[0]!.text).toBe('hello')
  })

  it('sends the model the turn chose, and it outranks the configured default', async () => {
    // The session's own selection is what the user picked for this
    // conversation; the configured default is only the preset's fallback.
    const client = fakeClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', modelId: 'grok-4.7' })
    await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1, modelId: 'grok-4.6' })
    const prompt = client.calls.find(call => call.method === 'session/prompt')!
    expect((prompt.params as { modelId?: string }).modelId).toBe('grok-4.6')
  })

  it('keeps the configured default when the turn names no model', async () => {
    const client = fakeClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', modelId: 'grok-4.7' })
    await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    const prompt = client.calls.find(call => call.method === 'session/prompt')!
    expect((prompt.params as { modelId?: string }).modelId).toBe('grok-4.7')
  })

  it('applies a config-option dialect’s pick through session/set_config_option before the prompt', async () => {
    // Qoder publishes the model selector in session/new and documents no
    // modelId param on session/prompt — the pick travels the protocol's own
    // write path, ahead of the prompt it applies to.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') {
        return {
          sessionId: 's1',
          configOptions: [{ id: 'model', category: 'model', currentValue: 'auto',
            options: [{ value: 'auto', name: 'Auto' }, { value: 'gmodel', name: 'GLM-5.3' }] }],
        }
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: qoderDialect })
    await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1, modelId: 'gmodel' })

    const order = client.calls.map(call => call.method)
    expect(order).toContain('session/set_config_option')
    expect(order.indexOf('session/set_config_option')).toBeLessThan(order.indexOf('session/prompt'))
    expect(client.calls.find(call => call.method === 'session/set_config_option')!.params)
      .toEqual({ sessionId: 's1', configId: 'model', value: 'gmodel' })
    // The nonstandard prompt param stays out: this agent has no documented use for it.
    expect((client.calls.find(call => call.method === 'session/prompt')!.params as { modelId?: string }).modelId).toBeUndefined()
  })

  it('cursor’s model pick rides set_config_option with configId "model"', async () => {
    // Cursor publishes configOptions[id=model] in session/new and implements
    // unstable_setSessionModel on that path; the prompt-side modelId param is
    // not part of the protocol and Cursor never reads it.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') {
        return {
          sessionId: 's1',
          models: { availableModels: [{ modelId: 'grok-4.7[]', name: 'grok-4.7' }] },
          configOptions: [{ id: 'model', category: 'model', currentValue: 'default[]',
            options: [{ value: 'default[]', name: 'Auto' }, { value: 'grok-4.7[]', name: 'grok-4.7' }] }],
        }
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: cursorDialect })
    await runner.run(DECISION, {
      sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1, modelId: 'grok-4.7[]',
    })

    expect(client.calls.find(call => call.method === 'session/set_config_option')!.params)
      .toEqual({ sessionId: 's1', configId: 'model', value: 'grok-4.7[]' })
    expect((client.calls.find(call => call.method === 'session/prompt')!.params as { modelId?: string }).modelId)
      .toBeUndefined()
  })

  it('resolves a stale cursor model id to the value its config option advertises', async () => {
    // Sessions stamped before cursor appended its configuration suffix carry
    // the plain name (`grok-4.7`). Sending that verbatim makes cursor reject
    // the turn with -32602 "Invalid model value: grok-4.7" — the pick used to
    // ride a prompt param cursor ignored, so the stale id only surfaced once
    // the write became strict. The option's name/base is the bridge.
    const live = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') {
        return {
          sessionId: 's1',
          models: { availableModels: [{ modelId: live, name: 'grok-4.7' }] },
          configOptions: [{ id: 'model', category: 'model', currentValue: 'default[]',
            options: [{ value: 'default[]', name: 'Auto' }, { value: live, name: 'grok-4.7' }] }],
        }
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: cursorDialect })
    const turn = (modelId: string) => ({ sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1, modelId })

    await runner.run(DECISION, turn('grok-4.7'))
    await runner.run(DECISION, turn('grok-4.7[context=128k]'))
    const values = client.calls
      .filter(call => call.method === 'session/set_config_option')
      .map(call => (call.params as { value: string }).value)
    expect(values).toEqual([live, live])
  })

  it('ends a turn whose model is no longer in the agent’s list with a re-select message', async () => {
    // The session's pick can also name a model the agent has since dropped, and
    // no alias bridges that. Sending it spends a request only to buy cursor's
    // opaque -32602; the honest end is local and tells the user the list moved
    // on. The fresh list already reached the catalog through this turn's
    // session/new report, so re-selecting is all that is left to do.
    const live = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') {
        return {
          sessionId: 's1',
          models: { availableModels: [{ modelId: live, name: 'grok-4.7' }] },
          configOptions: [{ id: 'model', category: 'model', currentValue: 'default[]',
            options: [{ value: 'default[]', name: 'Auto' }, { value: live, name: 'grok-4.7' }] }],
        }
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: cursorDialect })
    const result = await runner.run(DECISION, {
      sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1, modelId: 'grok-9-preview',
    })

    expect(result.end.kind).toBe('error')
    const error = (result.end as { error: { code: string; message: string } }).error
    expect(error.code).toBe('ACP_INTERNAL')
    expect(error.message).toContain('grok-9-preview')
    expect(error.message).toContain('重新选择')
    // The refused id never travels: neither the selector nor the prompt sees it.
    expect(client.calls.some(call => call.method === 'session/set_config_option')).toBe(false)
    expect(client.calls.some(call => call.method === 'session/prompt')).toBe(false)
  })

  it('applies a config-option pick once per change, not once per turn', async () => {
    // The agent keeps its selection across turns; re-sending an unchanged
    // pick before every prompt would charge the wire for nothing.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') {
        return { sessionId: 's1', configOptions: [{ id: 'model', category: 'model',
          options: [{ value: 'auto', name: 'Auto' }, { value: 'gmodel', name: 'GLM-5.3' }] }] }
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: qoderDialect })
    const turn = (modelId: string) => ({ sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1, modelId })

    await runner.run(DECISION, turn('gmodel'))
    await runner.run(DECISION, turn('gmodel'))
    expect(client.calls.filter(call => call.method === 'session/set_config_option')).toHaveLength(1)

    await runner.run(DECISION, turn('auto'))
    const values = client.calls
      .filter(call => call.method === 'session/set_config_option')
      .map(call => (call.params as { value: string }).value)
    expect(values).toEqual(['gmodel', 'auto'])
  })

  it('codex sends the combined pick through session/set_model, ahead of the prompt', async () => {
    // codex's config-option model selector accepts only the bare id; the
    // picker's value carries the effort (`gpt-6-astra[high]`). The legacy
    // set_model method takes exactly that value, and the prompt must not get
    // a param codex ignores.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') {
        return { sessionId: 's1', models: { availableModels: [{ modelId: 'gpt-6-astra[high]', name: 'GPT-6-Astra' }] } }
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    await runner.run(DECISION, {
      sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1, modelId: 'gpt-6-astra[high]',
    })

    const order = client.calls.map(call => call.method)
    expect(order).toContain('session/set_model')
    expect(order.indexOf('session/set_model')).toBeLessThan(order.indexOf('session/prompt'))
    expect(client.calls.find(call => call.method === 'session/set_model')!.params)
      .toEqual({ sessionId: 's1', modelId: 'gpt-6-astra[high]' })
    expect((client.calls.find(call => call.method === 'session/prompt')!.params as { modelId?: string }).modelId)
      .toBeUndefined()
  })

  it("claude sends the pick through its published model config option", async () => {
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') {
        return { sessionId: 's1', configOptions: [{ id: 'model', category: 'model', currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }, { value: 'opus', name: 'Opus' }] }] }
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: claudeDialect })
    await runner.run(DECISION, {
      sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1, modelId: 'opus',
    })

    expect(client.calls.find(call => call.method === 'session/set_config_option')!.params)
      .toEqual({ sessionId: 's1', configId: 'model', value: 'opus' })
    expect((client.calls.find(call => call.method === 'session/prompt')!.params as { modelId?: string }).modelId)
      .toBeUndefined()
  })

  it('returns only that turn’s frames, not everything seen so far', async () => {
    // Frames arrive while the prompt is still in flight, which is when they
    // really arrive.
    let emit: (frame: AcpFrame) => void = () => {}
    let round = 0
    const client: AcpClientPort = {
      request: async method => {
        if (method === 'session/new') return { sessionId: 's1' }
        if (method === 'session/prompt') {
          const n = ++round
          emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `run ${n}` } } } })
          emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `run ${n}` } } } })
          return { stopReason: 'end_turn' }
        }
        return {}
      },
      notify: () => {},
      onFrame: handler => { emit = handler },
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp' })

    expect((await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })).frames).toHaveLength(2)
    // The second turn must not carry the first turn's frames along: a stale
    // frame replayed into a new turn reads as the agent answering something it
    // was never asked.
    const second = await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    expect(second.frames).toHaveLength(2)
    for (const frame of second.frames) {
      expect(JSON.stringify(frame.params)).toContain('run 2')
    }
  })

  it('reports a turn the agent ended normally as completed', async () => {
    const runner = new AcpTurnRunner(fakeClient(), { cwd: '/tmp' })
    await expect(runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })).resolves.toMatchObject({ end: { kind: 'completed' } })
  })

  it('reports an agent that stopped for its own reasons as blocked, not completed', async () => {
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/prompt') return { stopReason: 'refusal' }
      if (method === 'session/new') return { sessionId: 's1' }
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    expect(result.end.kind).not.toBe('completed')
  })

  it('surfaces a failure to open rather than answering with an empty turn', async () => {
    // An empty turn would look to the user like the agent simply had nothing to
    // say, which is not what happened. The turn ends as a classified error
    // instead, its row naming the reconnect hint and the original cause.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') throw new Error('acp agent grok-4.7 could not run: spawn ENOENT')
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_CONNECTION' } })
    expect((result.end as { error: { message: string } }).error.message).toContain('could not run')
  })

  it('feeds text to the stream as frames arrive, not after the turn ends', async () => {
    // The whole point of streaming: a delta reaching the UI while the agent is
    // still working. Collecting frames and replaying them afterwards is exactly
    // the "wait, then it all appears" behaviour this is meant to replace.
    const deltas: string[] = []
    let emit: (frame: AcpFrame) => void = () => {}
    const client: AcpClientPort = {
      request: async method => {
        if (method === 'session/new') return { sessionId: 's1' }
        if (method === 'session/prompt') {
          emit(agentMessageChunk('Hel'))
          emit(agentMessageChunk('lo'))
          return { stopReason: 'end_turn' }
        }
        return {}
      },
      notify: () => {},
      onFrame: handler => { emit = handler as (f: unknown) => void },
    }
    const runner = new AcpTurnRunner(client, {
      cwd: '/tmp',
    })

    await runner.run(DECISION, TURN({ textDelta: (t: string) => deltas.push(t), reasoningDelta: () => {} }))
    expect(deltas).toEqual(['Hel', 'lo'])
  })

  it('sends reasoning through its own channel, kept apart from the answer', async () => {
    const text: string[] = []
    const reasoning: string[] = []
    let emit: (frame: AcpFrame) => void = () => {}
    const client: AcpClientPort = {
      request: async method => {
        if (method === 'session/new') return { sessionId: 's1' }
        if (method === 'session/prompt') {
          emit(agentThoughtChunk('pondering'))
          emit(agentMessageChunk('answer'))
          return { stopReason: 'end_turn' }
        }
        return {}
      },
      notify: () => {},
      onFrame: handler => { emit = handler as (f: unknown) => void },
    }
    await new AcpTurnRunner(client, {
      cwd: '/tmp',
    }).run(DECISION, TURN({ textDelta: (t: string) => text.push(t), reasoningDelta: (t: string) => reasoning.push(t) }))

    expect(reasoning).toEqual(['pondering'])
    expect(text).toEqual(['answer'])
  })

  it('opens the session once even if the first turn fails', async () => {
    const client = fakeClient()
    let attempts = 0
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/prompt') { attempts += 1; throw new Error('turn blew up') }
      if (method === 'session/new') return { sessionId: 's1' }
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp' })
    const first = await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    const second = await runner.run(DECISION, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    // Both failures end as classified errors — and the external conversation
    // still opened only once, so the failure did not turn into re-open churn.
    // The thrown text is not `acp `-shaped, so it is an internal failure, not
    // a connection one: the label says so instead of borrowing the hint.
    expect(first.end).toMatchObject({ kind: 'error', error: { code: 'ACP_INTERNAL' } })
    expect(second.end).toMatchObject({ kind: 'error', error: { code: 'ACP_INTERNAL' } })
    expect(client.calls.filter(call => call.method === 'session/new')).toHaveLength(1)
    expect(attempts).toBe(2)
  })
})

describe('AcpTurnRunner handshake', () => {
  it.each(['initialize', 'authenticate', 'session/new', 'session/set_mode'])(
    'names the stalled handshake operation: %s', async stage => {
      const client = fakeClient()
      const request = client.request
      client.request = (method, params) => method === stage
        ? new Promise(() => {}) : request(method, params)
      client.authenticate = () => stage === 'authenticate' ? new Promise(() => {}) : Promise.resolve({})
      const runner = new AcpTurnRunner(client, { cwd: '/tmp', modeId: 'agent', openTimeoutMs: 20 })
      const result = await runner.run(DECISION,
        { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
      expect(result.end).toMatchObject({ kind: 'error', error: {
        code: 'ACP_CONNECTION', message: expect.stringContaining(`等待 ${stage}`),
      } })
    },
  )

  it('gives up on an agent that never answers', async () => {
    // An external agent that accepts the connection and then says nothing would
    // otherwise hold the session open forever with nothing on screen. The turn
    // has to come back with an answer, even if that answer is a failure.
    const runner = new AcpTurnRunner(
      { request: () => new Promise(() => {}), notify: () => {}, onFrame: () => {} },
      { cwd: '/tmp', openTimeoutMs: 20 },
    )
    const result = await runner.run({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_CONNECTION' } })
    expect((result.end as { error: { message: string } }).error.message).toContain('within 20ms')
  })
})

describe('AcpTurnRunner — resumed external sessions', () => {
  /** A client whose agent-side sessions survive its own process. */
  const resumableClient = () => {
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/resume') {
        return { configOptions: [{ id: 'model', category: 'model', currentValue: 'auto', options: [] }] }
      }
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    return client
  }
  const TURN_S1 = { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 }

  it('reattaches a journaled session instead of opening fresh, and skips the text replay', async () => {
    // The agent still has the conversation it kept server-side, so the prompt
    // must arrive bare: riding the host transcript would read the history to
    // the agent a second time.
    const client = resumableClient()
    const taken: string[] = []
    const runner = new AcpTurnRunner(client, {
      cwd: '/tmp',
      dialect: qoderDialect,
      resumeOf: () => 'old-s1',
      replay: { take: sessionId => { taken.push(sessionId); return '旧对话' } },
    })

    await runner.run(DECISION, TURN_S1)

    const order = client.calls.map(call => call.method)
    expect(order).not.toContain('session/new')
    expect(client.calls.find(call => call.method === 'session/resume')!.params)
      .toEqual({ sessionId: 'old-s1', cwd: '/tmp', mcpServers: [] })
    const prompt = client.calls.find(call => call.method === 'session/prompt')!
    expect((prompt.params as { sessionId: string }).sessionId).toBe('old-s1')
    expect((prompt.params as { prompt: { text: string }[] }).prompt[0]!.text).toBe('hello')
    expect(taken).toEqual([])
  })

  it('falls back to a fresh open with the replay intact when the agent no longer has the session', async () => {
    // Agents prune their own sessions (retention, a CLI update); a journaled
    // id that went stale must degrade to today's behavior, not fail the turn.
    const client = resumableClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/resume') throw new Error('session not found')
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    }
    const runner = new AcpTurnRunner(client, {
      cwd: '/tmp',
      dialect: qoderDialect,
      resumeOf: () => 'old-s1',
      replay: { take: () => '旧对话' },
    })

    await runner.run(DECISION, TURN_S1)

    const order = client.calls.map(call => call.method)
    expect(order).toContain('session/resume')
    expect(order).toContain('session/new')
    const prompt = client.calls.find(call => call.method === 'session/prompt')!
    expect((prompt.params as { sessionId: string }).sessionId).toBe('s1')
    expect((prompt.params as { prompt: { text: string }[] }).prompt[0]!.text).toContain('【之前对话】')
  })

  it('never attempts a resume for a dialect that does not declare the capability', async () => {
    const client = resumableClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: grokDialect, resumeOf: () => 'old-s1' })

    await runner.run(DECISION, TURN_S1)

    expect(client.calls.map(call => call.method)).not.toContain('session/resume')
  })
})

describe('AcpTurnRunner — handed-over conversation', () => {
  const TURN_OF = (sessionId: string) => ({
    sessionId, position: { turn: 1, step: 1 }, produce: () => [], write: () => 1,
  })

  it('rides the first model request ahead of the question, once', async () => {
    const client = fakeClient()
    const taken: string[] = []
    const restored: string[] = []
    // A real ledger hands the text to the first taker only.
    let primed = true
    const runner = new AcpTurnRunner(client, {
      cwd: '/tmp',
      primer: {
        take: id => {
          taken.push(id)
          if (!primed) return undefined
          primed = false
          return '【移交记录】'
        },
        restore: (id, text) => { restored.push(`${id}:${text}`) },
      },
    })

    await runner.run(DECISION, TURN_OF('s1'))
    await runner.run(DECISION, TURN_OF('s1'))

    const prompts = client.calls.filter(call => call.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect((prompts[0]!.params as { prompt: { text: string }[] }).prompt[0]!.text)
      .toBe('【移交记录】\n\nhello')
    expect((prompts[1]!.params as { prompt: { text: string }[] }).prompt[0]!.text).toBe('hello')
    expect(taken).toEqual(['s1', 's1'])
    expect(restored).toEqual([])
  })

  it('puts the handover back when the request fails, so a retry keeps the history', async () => {
    const client = fakeClient()
    client.request = async method => {
      if (method === 'session/prompt') throw new Error('agent died')
      if (method === 'session/new') return { sessionId: 's9' }
      return {}
    }
    const restored: string[] = []
    const runner = new AcpTurnRunner(client, {
      cwd: '/tmp',
      primer: {
        take: () => '【移交记录】',
        restore: (id, text) => { restored.push(`${id}:${text}`) },
      },
    })

    const result = await runner.run(DECISION, TURN_OF('s1'))
    expect(result.end.kind).toBe('error')
    expect(restored).toEqual(['s1:【移交记录】'])
  })
})

/**
 * A failed turn's error row is the turn's own end reason: the client renders
 * its `error.message` verbatim. A raw transport or JSON-RPC string there reads
 * as noise, so the runner classifies the failure into the actionable copy the
 * spec names — connection-class ends point at resending, permission-class
 * ends point at approval/login, and everything else keeps the raw string.
 */
describe('AcpTurnRunner — failed turns end with actionable error rows', () => {
  const TURN_OF = (sessionId: string) => ({
    sessionId, position: { turn: 1, step: 1 }, produce: () => [], write: () => 1,
  })

  it('ends a dead connection as an error naming the reconnect hint', async () => {
    // Measured shape: the transport's death fails every in-flight request with
    // its close reason ('acp connection closed', a process exit line, …) — no
    // JSON-RPC reply was involved.
    const client = fakeClient()
    client.request = async method => {
      if (method === 'session/prompt') throw new Error('acp connection closed: agent process exited (1)')
      if (method === 'session/new') return { sessionId: 's1' }
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, TURN_OF('s1'))
    expect(result.end).toMatchObject({
      kind: 'error',
      error: { code: 'ACP_CONNECTION' },
    })
    const message = (result.end as { error: { message: string } }).error.message
    expect(message).toContain('重新发送')
    // The original detail stays on the row: a hint without the cause is a
    // dead end for anyone diagnosing why the connection dropped.
    expect(message).toContain('acp connection closed')
  })

  it('ends an agent permission/auth refusal as an error naming the approval hint', async () => {
    // Measured shape: an agent refusing the prompt replies with a JSON-RPC
    // error, which reaches the runner as `acp error: {json}`.
    const client = fakeClient()
    client.request = async method => {
      if (method === 'session/prompt') throw new Error('acp error: {"code":-32000,"message":"authentication required"}')
      if (method === 'session/new') return { sessionId: 's1' }
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, TURN_OF('s1'))
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_PERMISSION' } })
    const message = (result.end as { error: { message: string } }).error.message
    expect(message).toContain('授权')
    expect(message).toContain('authentication required')
  })

  it('shows any other agent rejection as the raw string it sent', async () => {
    // The spec's third bucket: not a connection problem, not a permission
    // problem — the row keeps the agent's own error untouched.
    const raw = 'acp error: {"code":-32603,"message":"Internal error"}'
    const client = fakeClient()
    client.request = async method => {
      if (method === 'session/prompt') throw new Error(raw)
      if (method === 'session/new') return { sessionId: 's1' }
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, TURN_OF('s1'))
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_ERROR', message: raw } })
  })

  it('ends a failed session open as a connection error too', async () => {
    // An agent that never opened (spawn failure, handshake timeout) is the
    // reconnect case just as much as one that died mid-turn. The shape here is
    // the transport's own spawn line, which carries the `acp ` marker.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') throw new Error('acp agent grok-4.7 could not run: spawn ENOENT')
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, TURN_OF('s1'))
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_CONNECTION' } })
    expect(((result.end as { error: { message: string } }).error.message)).toContain('could not run')
  })

  it('does not dress an internal failure up as a connection problem', async () => {
    // A bug inside the turn's own handling (a TypeError anywhere around open,
    // set_mode or the prompt plumbing) is not the agent's connection dying.
    // Labeling it ACP_CONNECTION would tell the user to resend and reconnect —
    // advice that cannot help — so a non-`acp `-shaped error gets the neutral
    // internal label, with the detail kept for whoever diagnoses it.
    const client = fakeClient()
    client.request = async method => {
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') throw new TypeError('cannot read properties of undefined (reading sessionId)')
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, TURN_OF('s1'))
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_INTERNAL' } })
    const message = (result.end as { error: { message: string } }).error.message
    expect(message).toContain('cannot read properties of undefined')
    expect(message).not.toContain('重新发送')
  })

  it('writes the frames the agent sent before the connection died', async () => {
    // The agent said things before dying; a turn that dropped them would erase
    // work the user watched happen. The failure path now runs the same
    // produce/write tail a completed turn does.
    const client = fakeClient()
    let emit: (frame: AcpFrame) => void = () => {}
    client.request = async method => {
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') {
        emit({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial thought' } } } })
        throw new Error('acp connection closed')
      }
      return {}
    }
    client.onFrame = handler => { emit = handler }
    const produced: unknown[] = []
    const written: unknown[] = []
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, {
      sessionId: 's1', position: { turn: 1, step: 1 },
      produce: result => { produced.push(result); return [] },
      write: events => { written.push(events); return undefined },
    })
    expect(produced).toHaveLength(1)
    expect(written).toHaveLength(1)
  })

  it('still ends a stopped turn as aborted even when the prompt then fails', async () => {
    // The user stopped; whatever error raced out of the dying connection, the
    // turn is what the user made it — stopped, not broken.
    const client = fakeClient()
    client.request = async method => {
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') throw new Error('acp connection closed')
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', abort: () => {
      const controller = new AbortController()
      controller.abort()
      return controller.signal
    } })
    const result = await runner.run(DECISION, TURN_OF('s1'))
    expect(result.end.kind).toBe('aborted')
  })
})

describe('AcpTurnRunner — 外部 agent 自己的委托运行', () => {
  it('记着还开着的子代理：出生帧记一笔，收尾帧销掉', async () => {
    // 外部 agent 在自己的回合里派出子代理并等它们——网关的总上限据此让路。
    // 这份账本只回答「现在是不是在等自己的子代理」（2026-10-20 会话
    // 7165a323：codex 派出 5 个子代理后等了近 27 分钟，总上限到点把主回合
    // 按 ACP_TIMEOUT 收尾，5 个子代理的结果全部丢失）。
    const client = fakeClient()
    let emit: (frame: AcpFrame) => void = () => {}
    client.onFrame = handler => { emit = handler }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    client.request = async method => {
      if (method === 'session/new') return { sessionId: 's1', models: { availableModels: [] } }
      if (method === 'session/prompt') {
        emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child-1', name: '研究', task: '查资料' },
          },
        })
        expect(runner.liveDelegatedRuns()).toBe(1)
        emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-1', state: 'completed', output: '好了' },
          },
        })
        expect(runner.liveDelegatedRuns()).toBe(0)
        return { stopReason: 'end_turn' }
      }
      return {}
    }
    await runner.run(DECISION, TURN({}))
    expect(runner.liveDelegatedRuns()).toBe(0)
  })
})
