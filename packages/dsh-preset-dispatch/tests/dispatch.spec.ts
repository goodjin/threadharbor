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
    run: run ?? (async () => ({ kind: 'completed' })),
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
    expect(installAcpDispatch(agent, new Map([['acp-grok', binding()]]), { produce: () => [], append: () => {} })).toBe(true)
    expect(protoStepOf(agent)).toBe(before)
  })

  it('does not touch a native session at all', async () => {
    const agent = new FakeAgent('dsh')
    const before = protoStepOf(agent)
    expect(installAcpDispatch(agent, new Map([['acp-grok', binding()]]), { produce: () => [], append: () => {} })).toBe(false)
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
    installAcpDispatch(taken, new Map([['acp-grok', binding()]]), { produce: () => [], append: () => {} })
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
      new Map([['acp-grok', binding(async decision => { ran.push(decision); return { kind: 'completed' } })]]),
      { produce: () => [], append: () => {} },
    )

    // Called the way the loop calls it: as a method, so `this` is the agent.
    const result = await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    expect(result).toEqual({ kind: 'completed' })
    expect(ran).toEqual([DECISION])
    // The native step never ran.
    expect(agent.calls).toEqual([])
  })

  it('writes the produced content events in order', async () => {
    const agent = new FakeAgent('acp-grok')
    const written: string[] = []
    installAcpDispatch(agent, new Map([['acp-grok', binding()]]), {
      produce: () => [
        { type: 'tool/call', payload: { callId: 'c1' } },
        { type: 'tool/result', payload: { callId: 'c1' } },
      ],
      append: event => { written.push(event.type) },
    })

    await (agent as unknown as { step(d: StepDecisionLike): Promise<unknown> }).step(DECISION)
    expect(written).toEqual(['tool/call', 'tool/result'])
  })

  it('still runs the external agent when one step follows another', async () => {
    const agent = new FakeAgent('acp-grok')
    let runs = 0
    installAcpDispatch(
      agent,
      new Map([['acp-grok', binding(async () => { runs += 1; return { kind: 'completed' } })]]),
      { produce: () => [], append: () => {} },
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
      { produce: () => [], append: () => {} },
    )).toThrow(/no step/i)
  })

  it('treats an empty preset as no preset', () => {
    const agent = new FakeAgent('')
    expect(installAcpDispatch(agent, new Map([['', binding()]]), { produce: () => [], append: () => {} })).toBe(false)
  })
})