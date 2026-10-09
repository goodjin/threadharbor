/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive (codex and
 * grok both load a model catalogue and probe their environment during it), and a
 * DSH session is long-lived, so re-opening per turn would make every turn pay a
 * setup cost the agent already paid.
 */

import type { AcpFrame } from '@threadharbor/dsh-acp-agent'
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
const TURN = (stream: Record<string, unknown>) => ({
  sessionId: 's1',
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

    await runner.run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })
    await runner.run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })

    const news = client.calls.filter(call => call.method === 'session/new')
    expect(news).toHaveLength(1)
  })

  it('sends the user’s text as the prompt', async () => {
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })

    const prompt = client.calls.find(call => call.method === 'session/prompt')
    expect((prompt!.params as { prompt: { text: string }[] }).prompt[0]!.text).toBe('hello')
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

    expect((await runner.run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })).frames).toHaveLength(2)
    // The second turn must not carry the first turn's frames along: a stale
    // frame replayed into a new turn reads as the agent answering something it
    // was never asked.
    const second = await runner.run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })
    expect(second.frames).toHaveLength(2)
    for (const frame of second.frames) {
      expect(JSON.stringify(frame.params)).toContain('run 2')
    }
  })

  it('reports a turn the agent ended normally as completed', async () => {
    const runner = new AcpTurnRunner(fakeClient(), { cwd: '/tmp' })
    await expect(runner.run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })).resolves.toMatchObject({ end: { kind: 'completed' } })
  })

  it('reports an agent that stopped for its own reasons as blocked, not completed', async () => {
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/prompt') return { stopReason: 'refusal' }
      if (method === 'session/new') return { sessionId: 's1' }
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })
    expect(result.end.kind).not.toBe('completed')
  })

  it('surfaces a failure to open rather than answering with an empty turn', async () => {
    // An empty turn would look to the user like the agent simply had nothing to
    // say, which is not what happened.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') throw new Error('agent binary missing')
      return {}
    }
    await expect(new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })).rejects.toThrow(/agent binary missing/)
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
    await expect(runner.run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })).rejects.toThrow(/turn blew up/)
    await expect(runner.run(DECISION, { sessionId: 's1', produce: () => [], write: () => 1 })).rejects.toThrow(/turn blew up/)
    expect(client.calls.filter(call => call.method === 'session/new')).toHaveLength(1)
    expect(attempts).toBe(2)
  })
})

describe('AcpTurnRunner handshake', () => {
  it('gives up on an agent that never answers', async () => {
    // An external agent that accepts the connection and then says nothing would
    // otherwise hold the session open forever with nothing on screen. The turn
    // has to come back with an answer, even if that answer is a failure.
    const runner = new AcpTurnRunner(
      { request: () => new Promise(() => {}), notify: () => {}, onFrame: () => {} },
      { cwd: '/tmp', openTimeoutMs: 20 },
    )
    await expect(runner.run({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      { sessionId: 's1', produce: () => [], write: () => 1 })).rejects.toThrow(/within 20ms/)
  })
})
