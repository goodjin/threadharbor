/**
 * Which sessions get handed to an external agent, and which must not be.
 *
 * The requirement that shapes most of this file: a session on a native preset
 * must behave **exactly** as before. Not "close enough" — the native path is not
 * taken over at all, and the test asserts that by checking the agent's own
 * `step` is the same function reference it started with.
 */

import { describe, expect, it } from 'vitest'
import { installAcpDispatch, resolvePreset } from '../src/dispatch.ts'
import type { AcpPresetBinding, StepDecisionLike } from '../src/dispatch.ts'

/**
 * A stand-in with the same prototype arrangement as the real agent: `step` lives
 * on the prototype, so replacing it on one instance must not touch another.
 */
class FakeAgent {
  session: { header: { agentPreset?: string } }
  calls: StepDecisionLike[] = []
  constructor(agentPreset?: string) {
    this.session = { header: agentPreset === undefined ? {} : { agentPreset } }
  }

  private async step(decision: StepDecisionLike): Promise<{ kind: 'completed' } | null> {
    this.calls.push(decision)
    return { kind: 'completed' }
  }
}

/** Reach the prototype method the way the installer has to. */
function protoStepOf(agent: object): unknown {
  return (Object.getPrototypeOf(agent) as Record<string, unknown>)['step']
}

function binding(run?: AcpPresetBinding['run']): AcpPresetBinding {
  return {
    dialect: { id: 'acp' } as AcpPresetBinding['dialect'],
    run: run ?? (async (_decision, turn) => {
      const result = { frames: [], end: { kind: 'completed' as const } }
      turn.write(turn.produce(result))
      return result
    }),
  }
}

const DECISION: StepDecisionLike = { kind: 'enter', messages: [{ type: 'text', text: 'hi' }] }

describe('resolvePreset', () => {
  it('finds the binding named by the session header', () => {
    const agent = new FakeAgent('acp-grok')
    expect(resolvePreset(agent, new Map([['acp-grok', binding()]]))).toBeDefined()
  })

  it('leaves a session with no preset alone', () => {
    expect(resolvePreset(new FakeAgent(), new Map([['acp-grok', binding()]]))).toBeUndefined()
  })

  it('leaves a native preset alone, even though it is a preset', () => {
    expect(resolvePreset(new FakeAgent('dsh'), new Map([['acp-grok', binding()]]))).toBeUndefined()
  })
})

describe('installAcpDispatch', () => {
  it('takes over a session whose preset names an external agent', async () => {
    const agent = new FakeAgent('acp-grok')
    const before = protoStepOf(agent)
    expect(installAcpDispatch(agent, new Map([['acp-grok', binding()]]), { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) })).toBe(true)
    expect(protoStepOf(agent)).toBe(before)
  })

  it('does not touch a native session at all', async () => {
    const agent = new FakeAgent('dsh')
    const before = protoStepOf(agent)
    expect(installAcpDispatch(agent, new Map([['acp-grok', binding()]]), { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) })).toBe(false)
    // Same function reference: the native path is not merely bypassed, it is
    // untouched, so there is nothing to regress.
    expect(protoStepOf(agent)).toBe(before)
  })

  it('leaves one session taking over not affecting another', async () => {
    // The class is shared by every session, so anything patched on the prototype
    // would change native sessions too.
    const taken = new FakeAgent('acp-grok')
    const native = new FakeAgent('dsh')
    const nativeStepBefore = protoStepOf(native)
    installAcpDispatch(taken, new Map([['acp-grok', binding()]]), { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) })
    expect(protoStepOf(native)).toBe(nativeStepBefore)
    // No own property: the native session still reaches the prototype method,
    // untouched. (Looking up `native.step` would find it through the chain.)
    expect(Object.hasOwn(native, 'step')).toBe(false)
    expect(Object.hasOwn(taken, 'step')).toBe(true)
  })

  it('runs the external agent instead of the native step', async () => {
    const agent = new FakeAgent('acp-grok')
    const ran: StepDecisionLike[] = []
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async decision => { ran.push(decision); return { frames: [], end: { kind: 'completed' } } })]]),
      { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) },
    )

    // Called the way the loop calls it: as a method, so `this` is the agent.
    const result = await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    expect(result).toEqual({ kind: 'completed' })
    expect(ran).toEqual([DECISION])
    // The native step never ran.
    expect(agent.calls).toEqual([])
  })

  it('produces content only after the turn has run, since events describe its result', async () => {
    // Content events describe what the external agent did. Producing them before
    // the run would write whatever the previous turn left behind — usually
    // nothing at all. The user's own messages are the input, so they are written
    // before the run and again show up first in the order below.
    const agent = new FakeAgent('acp-grok')
    const order: string[] = []
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async (_decision, turn) => {
        order.push('run')
        const result = { frames: [], end: { kind: 'completed' as const } }
        turn.write(turn.produce(result))
        return result
      })]]),
      {
        produce: () => { order.push('produce'); return [{ type: 'assistant/message', payload: {} }] },
        write: () => { order.push('write'); return 1 },
        positionOf: () => ({ turn: 1, step: 1 }),
      },
    )

    await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    // The turn owns its write: content is produced after the run, and written
    // after that. The closing stream frame depends on this order.
    expect(order).toEqual(['write', 'run', 'produce', 'write'])
  })

  it('writes the produced content events in order', async () => {
    const agent = new FakeAgent('acp-grok')
    const written: string[] = []
    installAcpDispatch(agent, new Map([['acp-grok', binding()]]), {
      produce: () => [
        { type: 'tool/call', payload: { callId: 'c1' } },
        { type: 'tool/result', payload: { callId: 'c1' } },
      ],
      write: events => { written.push(...events.map(event => event.type)); return 1 },
      positionOf: () => ({ turn: 1, step: 1 }),
    })

    await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    expect(written).toEqual(['user/message', 'tool/call', 'tool/result'])
  })

  it('still runs the external agent when one step follows another', async () => {
    const agent = new FakeAgent('acp-grok')
    let runs = 0
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async () => { runs += 1; return { frames: [], end: { kind: 'completed' } } })]]),
      { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) },
    )
    const host = agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }
    await host.step(DECISION)
    await host.step(DECISION)
    expect(runs).toBe(2)
  })

  it('refuses loudly when there is no step to replace', () => {
    // Silently doing nothing here produces a session that never answers.
    const agent = { session: { header: { agentPreset: 'acp-grok' } } }
    expect(() => installAcpDispatch(
      agent,
      new Map([['acp-grok', binding()]]),
      { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) },
    )).toThrow(/no step/i)
  })

  it('treats an empty preset as no preset', () => {
    const agent = new FakeAgent('')
    expect(installAcpDispatch(agent, new Map([['', binding()]]), { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) })).toBe(false)
  })

  it('does not re-wrap an agent this binding already holds', () => {
    // The same preset can be selected twice on a blank session; the second
    // select re-announces the preset and must not stack a second wrapper (and
    // must not log a second takeover for the same install).
    const agent = new FakeAgent('acp-grok')
    const table = new Map([['acp-grok', binding()]])
    const options = { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) }
    expect(installAcpDispatch(agent, table, options)).toBe(true)
    const own = (agent as unknown as Record<string, unknown>)['step']
    expect(installAcpDispatch(agent, table, options)).toBe(false)
    expect((agent as unknown as Record<string, unknown>)['step']).toBe(own)
  })

  it('lets the session go when the preset has moved away since the install', async () => {
    // A blank session can change preset after this install. The registry only
    // rebinds the agent's scope then — no `agent/created` fires again — so a
    // step captured once would keep driving the session under the old agent.
    // The step therefore re-reads the preset on every turn.
    const agent = new FakeAgent('acp-grok')
    let current: string | undefined = 'acp-grok'
    const ran: StepDecisionLike[] = []
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async decision => { ran.push(decision); return { frames: [], end: { kind: 'completed' } } })]]),
      { produce: () => [], write: () => undefined, presetOf: () => current, positionOf: () => ({ turn: 1, step: 1 }) },
    )
    const host = agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }
    await host.step(DECISION)
    expect(ran).toEqual([DECISION])

    current = 'standard'
    await host.step(DECISION)
    // The external agent did not run again; the native step did.
    expect(ran).toEqual([DECISION])
    expect(agent.calls).toEqual([DECISION])
  })

  it('keeps driving the session while the preset still names this row', async () => {
    // The per-turn re-read must not degrade the standing case: a session created
    // on this preset keeps taking every turn from the external agent.
    const agent = new FakeAgent('acp-grok')
    let runs = 0
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async () => { runs += 1; return { frames: [], end: { kind: 'completed' } } })]]),
      { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) },
    )
    const host = agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }
    await host.step(DECISION)
    await host.step(DECISION)
    expect(runs).toBe(2)
    expect(agent.calls).toEqual([])
  })

  it('refuses to write content when the loop reported no position', async () => {
    // Content numbered differently from the boundaries is grouped under a step
    // the view never saw start, and dropped: the session would look answered
    // while showing nothing. Refusing is the honest failure.
    const agent = new FakeAgent('acp-grok')
    const ran: StepDecisionLike[] = []
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async decision => { ran.push(decision); return { frames: [], end: { kind: 'completed' } } })]]),
      { produce: () => [], write: () => undefined, positionOf: () => undefined },
    )
    await expect(
      (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION),
    ).rejects.toThrow(/no position/i)
    expect(ran).toEqual([])
  })

  it('places produce and the stream under the numbers the loop announced', async () => {
    // The conversation view folds content under `${turn}:${step}` and only
    // starts a node from the step's own start event — the numbers have to be
    // the loop's, everywhere.
    const agent = new FakeAgent('acp-grok')
    const positions: string[] = []
    let streamPosition: string | undefined
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async (_decision, turn) => {
        turn.openStream?.()
        const result = { frames: [], end: { kind: 'completed' as const } }
        turn.write(turn.produce(result))
        return result
      })]]),
      {
        positionOf: () => ({ turn: 3, step: 2 }),
        produce: (_result, position) => {
          positions.push(`${position.turn}:${position.step}`)
          return []
        },
        write: () => 1,
        openStream: (_candidate, position) => () => {
          streamPosition = `${position.turn}:${position.step}`
          return undefined
        },
      },
    )
    await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    expect(positions).toEqual(['3:2'])
    expect(streamPosition).toBe('3:2')
  })

  it('commits the user messages before the turn runs', async () => {
    // They are the turn's input, committed the way the native step commits
    // them; a refusal later in the step must still leave the question on the
    // record.
    const agent = new FakeAgent('acp-grok')
    const seen: Array<{ phase: string; types: readonly string[] }> = []
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async (_decision, turn) => {
        seen.push({ phase: 'run', types: [] })
        const result = { frames: [], end: { kind: 'completed' as const } }
        turn.write(turn.produce(result))
        return result
      })]]),
      {
        produce: () => [{ type: 'assistant/message', payload: {} }],
        write: events => {
          seen.push({ phase: 'write', types: events.map(event => event.type) })
          return 1
        },
        positionOf: () => ({ turn: 1, step: 1 }),
      },
    )
    await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    expect(seen).toEqual([
      { phase: 'write', types: ['user/message'] },
      { phase: 'run', types: [] },
      { phase: 'write', types: ['assistant/message'] },
    ])
  })

  it('refuses the turn when the model decision says so, after committing the input', async () => {
    // The session's picker named a model this preset does not serve; answering
    // anyway would put one agent's words under another model's name.
    const agent = new FakeAgent('acp-grok')
    const ran: StepDecisionLike[] = []
    const written: string[] = []
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async decision => { ran.push(decision); return { frames: [], end: { kind: 'completed' } } })]]),
      {
        produce: () => [],
        write: events => { written.push(...events.map(event => event.type)); return 1 },
        positionOf: () => ({ turn: 1, step: 1 }),
        turnModel: () => ({ kind: 'refuse', reason: '该模型不由这个预设提供' }),
      },
    )
    await expect(
      (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION),
    ).rejects.toThrow('该模型不由这个预设提供')
    expect(ran).toEqual([])
    expect(written).toEqual(['user/message'])
  })

  it('hands a chosen model to the turn', async () => {
    // A selection this preset serves rides the turn as its modelId, outranking
    // the preset's configured default.
    const agent = new FakeAgent('acp-grok')
    let used: string | undefined
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async (_decision, turn) => {
        used = turn.modelId
        return { frames: [], end: { kind: 'completed' } }
      })]]),
      {
        produce: () => [],
        write: () => undefined,
        positionOf: () => ({ turn: 1, step: 1 }),
        turnModel: () => ({ kind: 'own', modelId: 'grok-4.6' }),
      },
    )
    await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    expect(used).toBe('grok-4.6')
  })

  it('ends a redirected turn pointing at the new session, without recording the question here', async () => {
    // The switch already delivered the conversation AND the question to the
    // session it created; writing the question on this session's log too would
    // put one question in two conversations' hands. The turn ends by naming
    // where the conversation went — returned to the loop as the turn's ending,
    // not thrown, so the client renders a handover and not a failure.
    const agent = new FakeAgent('acp-grok')
    const ran: StepDecisionLike[] = []
    const written: string[] = []
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async decision => { ran.push(decision); return { frames: [], end: { kind: 'completed' } } })]]),
      {
        produce: () => [],
        write: events => { written.push(...events.map(event => event.type)); return 1 },
        positionOf: () => ({ turn: 1, step: 1 }),
        turnModel: async () => ({
          kind: 'redirected',
          target: 'acp-codex',
          sessionId: 'n1',
          note: '已切到新会话 n1，请到那里继续',
        }),
      },
    )
    const ended = await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    expect(ended).toEqual({
      kind: 'agent-switch/handover',
      target: 'acp-codex',
      sessionId: 'n1',
      note: '已切到新会话 n1，请到那里继续',
    })
    expect(ran).toEqual([])
    expect(written).toEqual([])
  })
})