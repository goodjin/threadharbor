/**
 * The plugin's reaction to agent creation.
 *
 * This is the point where DSH's own loop hands over a session, and the only
 * moment the preset is worth reading. It is serial and awaited before the agent
 * reaches the loop, and queued input waits for its listeners, so patching here
 * cannot race the first turn.
 */

import { describe, expect, it } from 'vitest'
import { attachAcpDispatch } from '../src/service.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } },
}

/** A context with just the one method this uses. */
function fakeContext() {
  const handlers = new Map<string, (payload: { agent: unknown }) => void>()
  return {
    ctx: { on: (event: string, handler: (payload: { agent: unknown }) => void) => { handlers.set(event, handler) } },
    fire: (payload: { agent: unknown }) => { handlers.get('agent/created')?.(payload) },
    events: () => [...handlers.keys()],
  }
}

const deps = {
  answerPermission: async () => ({ outcome: 'reject' as const }),
  positionOf: () => ({ turn: 1, step: 1 }),
}

/**
 * A stand-in with the same arrangement as the real agent: `step` on the
 * prototype, reached as `this.step(...)`.
 */
function agentWith(agentPreset?: string) {
  class FakeAgent {
    session: { header: { agentPreset?: string } }
    constructor() { this.session = { header: agentPreset === undefined ? {} : { agentPreset } } }
    private async step(): Promise<null> { return null }
  }
  return { agent: new FakeAgent() }
}

describe('attachAcpDispatch', () => {
  it('listens for agent creation', () => {
    const host = fakeContext()
    attachAcpDispatch(host.ctx, CONFIG, deps)
    expect(host.events()).toEqual(['agent/created'])
  })

  it('takes over a session whose preset names an agent it drives', () => {
    const host = fakeContext()
    attachAcpDispatch(host.ctx, CONFIG, deps)
    const agent = agentWith('acp-grok')

    host.fire(agent)
    expect(Object.hasOwn(agent.agent, 'step')).toBe(true)
  })

  it('leaves a native session completely alone', () => {
    const host = fakeContext()
    attachAcpDispatch(host.ctx, CONFIG, deps)
    const agent = agentWith('dsh')

    host.fire(agent)
    expect(Object.hasOwn(agent.agent, 'step')).toBe(false)
  })

  it('leaves a session with no preset alone', () => {
    const host = fakeContext()
    attachAcpDispatch(host.ctx, CONFIG, deps)
    const agent = agentWith()

    host.fire(agent)
    expect(Object.hasOwn(agent.agent, 'step')).toBe(false)
  })

  it('follows the live preset, not the value the session was created with', () => {
    // A blank session can change preset after it was created. The header keeps
    // the original value, so trusting it would take over a session that has
    // already moved on — or run a native session as if it were ACP.
    const host = fakeContext()
    attachAcpDispatch(host.ctx, CONFIG, { ...deps, presetOf: () => 'dsh' })
    const stale = agentWith('acp-grok')

    host.fire(stale)
    expect(Object.hasOwn(stale.agent, 'step')).toBe(false)
  })

  it('takes over a session whose header is stale but whose live preset is ours', () => {
    const host = fakeContext()
    attachAcpDispatch(host.ctx, CONFIG, { ...deps, presetOf: () => 'acp-grok' })
    const stale = agentWith('dsh')

    host.fire(stale)
    expect(Object.hasOwn(stale.agent, 'step')).toBe(true)
  })

  it('reports an agent it cannot patch rather than letting the turn hang', () => {
    const host = fakeContext()
    attachAcpDispatch(host.ctx, CONFIG, deps)
    // No `step` anywhere on it: taking over is impossible.
    const agent: Record<string, unknown> = { session: { header: { agentPreset: 'acp-grok' } } }

    expect(() => host.fire({ agent })).toThrow(/no step/i)
  })
})