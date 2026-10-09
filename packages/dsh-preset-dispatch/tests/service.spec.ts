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

const deps = { answerPermission: async () => ({ outcome: 'reject' as const }) }

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

  it('reports an agent it cannot patch rather than letting the turn hang', () => {
    const host = fakeContext()
    attachAcpDispatch(host.ctx, CONFIG, deps)
    // No `step` anywhere on it: taking over is impossible.
    const agent: Record<string, unknown> = { session: { header: { agentPreset: 'acp-grok' } } }

    expect(() => host.fire({ agent })).toThrow(/no step/i)
  })
})