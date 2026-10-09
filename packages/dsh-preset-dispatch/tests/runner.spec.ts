/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive (codex and
 * grok both load a model catalogue and probe their environment during it), and a
 * DSH session is long-lived, so re-opening per turn would make every turn pay a
 * setup cost the agent already paid.
 */

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
    onTurnFrames: () => {},
  }
  return client
}

const DECISION: StepDecisionLike = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

describe('AcpTurnRunner', () => {
  it('opens a session on the first turn and reuses it after that', async () => {
    const client = fakeClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp' })

    await runner.run(DECISION)
    await runner.run(DECISION)

    const news = client.calls.filter(call => call.method === 'session/new')
    expect(news).toHaveLength(1)
  })

  it('sends the user’s text as the prompt', async () => {
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION)

    const prompt = client.calls.find(call => call.method === 'session/prompt')
    expect((prompt!.params as { prompt: { text: string }[] }).prompt[0]!.text).toBe('hello')
  })

  it('returns only that turn’s frames, not everything seen so far', async () => {
    // Frames arrive while the prompt is still in flight, which is when they
    // really arrive.
    let emit: (frames: unknown[]) => void = () => {}
    let round = 0
    const client: AcpClientPort = {
      request: async method => {
        if (method === 'session/new') return { sessionId: 's1' }
        if (method === 'session/prompt') { emit([{ n: ++round }, { n: round }]); return { stopReason: 'end_turn' } }
        return {}
      },
      notify: () => {},
      onTurnFrames: handler => { emit = handler as (f: unknown[]) => void },
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp' })

    expect((await runner.run(DECISION)).frames).toHaveLength(2)
    // The second turn must not carry the first turn's frames along.
    const second = await runner.run(DECISION)
    expect(second.frames).toEqual([{ n: 2 }, { n: 2 }])
  })

  it('reports a turn the agent ended normally as completed', async () => {
    const runner = new AcpTurnRunner(fakeClient(), { cwd: '/tmp' })
    await expect(runner.run(DECISION)).resolves.toMatchObject({ end: { kind: 'completed' } })
  })

  it('reports an agent that stopped for its own reasons as blocked, not completed', async () => {
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/prompt') return { stopReason: 'refusal' }
      if (method === 'session/new') return { sessionId: 's1' }
      return {}
    }
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION)
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
    await expect(new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION)).rejects.toThrow(/agent binary missing/)
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
    await expect(runner.run(DECISION)).rejects.toThrow(/turn blew up/)
    await expect(runner.run(DECISION)).rejects.toThrow(/turn blew up/)
    expect(client.calls.filter(call => call.method === 'session/new')).toHaveLength(1)
    expect(attempts).toBe(2)
  })
})