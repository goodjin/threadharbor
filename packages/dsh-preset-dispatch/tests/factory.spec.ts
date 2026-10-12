/**
 * How configuration becomes a reachable agent.
 *
 * Scope note, deliberately narrow: this covers the decisions the factory makes
 * — which dialect an agent speaks, and what happens when a preset does not
 * exist. Actually connecting is the transport's own business and already has
 * its own tests; duplicating it here would only test `WebSocket` and `spawn`.
 */

import { describe, expect, it } from 'vitest'
import { claudeDialect, codexDialect, grokDialect } from '@threadharbor/dsh-acp-agent'
import { makeSessionFactory } from '../src/factory.ts'
import type { AcpTransport } from '@threadharbor/dsh-acp-agent'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419', model: 'grok-4.7' },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp', mode: 'default' },
    'acp-codex': { agent: 'codex', command: 'codex-acp' },
  },
}

const deps = { answerPermission: async () => ({ outcome: 'reject' as const }) }

describe('makeSessionFactory', () => {
  it('gives each agent its own dialect', () => {
    const factory = makeSessionFactory(CONFIG, deps)
    expect(factory.dialectFor('acp-grok', CONFIG.presets['acp-grok']!)).toBe(grokDialect)
    expect(factory.dialectFor('acp-claude', CONFIG.presets['acp-claude']!)).toBe(claudeDialect)
    expect(factory.dialectFor('acp-codex', CONFIG.presets['acp-codex']!)).toBe(codexDialect)
  })

  it('refuses an agent it does not drive, rather than guessing a dialect', () => {
    // Guessing here would parse a native session's frames as ACP and write
    // whatever came out into its log.
    const factory = makeSessionFactory(CONFIG, deps)
    expect(factory.dialectFor('dsh', { agent: 'native' })).toBeUndefined()
    expect(factory.dialectFor('dsh', {})).toBeUndefined()
  })

  it('reports a preset that is not configured instead of opening nothing', async () => {
    // Opening nothing would leave the session running with no agent, which
    // looks exactly like an agent that is merely slow.
    const factory = makeSessionFactory(CONFIG, deps)
    await expect(factory.open('acp-missing', { cwd: '/tmp' })).rejects.toThrow(/no preset named/)
  })
})

/** A transport a test can kill, holding one death slot like the real ones do. */
function killableTransport(): AcpTransport & { die(reason: string): void } {
  let line: (line: string) => void = () => {}
  let death: (reason: string) => void = () => {}
  return {
    send: () => {},
    onLine: handler => { line = handler },
    onDeath: handler => { death = handler },
    close: () => {},
    die: reason => { death(reason) },
    /** Exposed so a test can drive frames the way a live agent would. */
    receive: (frame: string) => { line(frame) },
  } as AcpTransport & { die(reason: string): void; receive(frame: string): void }
}

describe('连接死亡的转播', () => {
  it('传输死亡同时到达 AcpClient 的在途请求和会话的观察者', async () => {
    // Both listeners matter: the client's rejection is what fails a hung turn
    // loudly, and the session-level callback is what lets the registry drop
    // the dead connection. The real transports hold one death slot, so the
    // factory has to fan the event out — registering the observer directly on
    // the transport would silently steal the client's slot.
    const transport = killableTransport()
    const factory = makeSessionFactory(
      { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport },
    )
    const session = await factory.open('acp-grok', { cwd: '/tmp' })
    const seenBySession: string[] = []
    session.onDead(reason => { seenBySession.push(reason) })

    // One request in flight: its rejection proves the client kept its listener.
    const pending = session.run(
      { kind: 'enter', messages: [] },
      { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 },
    )
    transport.die('agent process exited')
    await expect(pending).rejects.toThrow('agent process exited')
    expect(seenBySession).toEqual(['agent process exited'])
  })

  it('会话自己关掉时不再报告死亡', async () => {
    const transport = killableTransport()
    const factory = makeSessionFactory(
      { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport },
    )
    const session = await factory.open('acp-grok', { cwd: '/tmp' })
    const deaths: string[] = []
    session.onDead(reason => { deaths.push(reason) })
    session.close()
    expect(deaths).toEqual([])
  })
})
