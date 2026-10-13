/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive (codex and
 * grok both load a model catalogue and probe their environment during it), and a
 * DSH session is long-lived, so re-opening per turn would make every turn pay a
 * setup cost the agent already paid.
 */

import type { AcpFrame } from '@threadharbor/dsh-acp-agent'
import { grokDialect } from '@threadharbor/dsh-acp-agent'
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
    ;(client as AcpClientPort & { authenticate?: () => Promise<unknown> }).authenticate = async () => {
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
