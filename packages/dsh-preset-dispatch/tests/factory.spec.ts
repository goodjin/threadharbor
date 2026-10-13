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

  it('hands the session/new model list to the catalog as the opening preset’s report', async () => {
    // The picker serves what the agent reported; the factory knows which preset
    // opened, so it is the seam that keys the report by preset.
    const transport = recordingTransport()
    const reports: { presetId: string; models: unknown }[] = []
    const factory = makeSessionFactory(
      { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport, onRuntimeModels: (presetId, models) => { reports.push({ presetId, models }) } },
    )
    const session = await factory.open('acp-grok', { cwd: '/tmp' })
    void session.run(
      { kind: 'enter', messages: [] },
      { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 },
    )
    // Answer the handshake in order: initialize, then session/new with the
    // grok-shaped model list.
    for (const frame of transport.sent) {
      const request = JSON.parse(frame) as { id?: number; method?: string }
      if (request.id === undefined) continue
      const result = request.method === 'session/new'
        ? { sessionId: 's1', models: { availableModels: [{ modelId: 'm1', name: 'M1' }] } }
        : {}
      transport.receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
      await flush()
    }
    expect(reports).toEqual([{ presetId: 'acp-grok', models: [{ id: 'm1', name: 'M1' }] }])
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

    // One request in flight: its classified failure proves the client kept its
    // listener (the transport's death reason names the row's reconnect hint).
    // The reason text is the real stdio transport's exit line — `acp `-prefixed,
    // which is what keeps it in the connection bucket.
    const pending = session.run(
      { kind: 'enter', messages: [] },
      { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 },
    )
    transport.die('acp agent grok-4.7 exited (code=1 signal=none)')
    const result = await pending
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_CONNECTION' } })
    expect(seenBySession).toEqual(['acp agent grok-4.7 exited (code=1 signal=none)'])
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

/** A transport that records what the client wrote, and can push frames in. */
function recordingTransport(): AcpTransport & { readonly sent: string[]; receive: (frame: string) => void } {
  const sent: string[] = []
  let line: (frame: string) => void = () => {}
  return {
    sent,
    send: (frame: string) => { sent.push(frame) },
    onLine: (handler: (frame: string) => void) => { line = handler },
    onDeath: () => {},
    close: () => {},
    receive: (frame: string) => { line(frame) },
  } as AcpTransport & { readonly sent: string[]; receive: (frame: string) => void }
}

/** Let queued microtasks run, so the async answer path has settled. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

const CURSOR_ASK = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'cursor/ask_question',
  params: {
    questions: [{ id: 'q1', prompt: 'Which mode?', options: [{ id: 'plan', label: 'Plan' }] }],
  },
})

describe('把 agent 的提问接到 host 的提问服务', () => {
  it('host 可提问时，提问走 host 钩子并带上会话，答案按 cursor 形状回传', async () => {
    // The hook answered on the host's behalf, and the reply is the answered
    // envelope — not the auto-answer's skip.
    const transport = recordingTransport()
    const seen: unknown[] = []
    const factory = makeSessionFactory(
      { presets: { 'acp-cursor': { agent: 'cursor', url: 'ws://127.0.0.1:2419' } } },
      {
        ...deps,
        transport: () => transport,
        answerAskQuestion: async request => { seen.push(request); return { answer: 'Plan' } },
      },
    )
    // The opener knows the DSH session; the hook's request names it, so the
    // host-side bridge can resolve the live agent the card belongs to.
    await factory.open('acp-cursor', { cwd: '/tmp', dshSessionId: 's1' })
    transport.receive(CURSOR_ASK)
    await flush()

    expect(seen[0]).toMatchObject({ sessionId: 's1', questions: [{ id: 'q1', prompt: 'Which mode?' }] })
    expect(transport.sent).toHaveLength(1)
    const reply = JSON.parse(transport.sent[0]!) as { id: number; result: { outcome: { outcome: string } } }
    expect(reply.id).toBe(0)
    expect(reply.result).toEqual({
      outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['plan'] }] },
    })
  })

  it('host 接不到时维持现状：扩展钩子的自动应答照旧生效', async () => {
    // No-regression pin: without a host ask bridge, cursor's question gets the
    // benign skip it has always gotten, and the turn proceeds.
    const transport = recordingTransport()
    const factory = makeSessionFactory(
      { presets: { 'acp-cursor': { agent: 'cursor', url: 'ws://127.0.0.1:2419' } } },
      { ...deps, transport: () => transport },
    )
    await factory.open('acp-cursor', { cwd: '/tmp' })
    transport.receive(CURSOR_ASK)
    await flush()

    const reply = JSON.parse(transport.sent[0]!) as { id: number; result: { outcome: { outcome: string } } }
    expect(reply.id).toBe(0)
    expect(reply.result.outcome.outcome).toBe('skipped')
  })
})
