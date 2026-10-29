/**
 * Stopping a turn the external agent is running.
 *
 * The host stops a turn by aborting the loop's own signal; the external agent
 * knows nothing of that signal and would otherwise run to completion into a
 * turn nobody is reading any more. The runner listens for it, tells the agent
 * `session/cancel`, and discards whatever still arrives after the stop.
 */

import type { AcpDialect, AcpFrame } from '@threadharbor/dsh-acp-agent'
import { describe, expect, it } from 'vitest'
import { installAcpDispatch } from '../src/dispatch.ts'
import type { StepDecisionLike } from '../src/dispatch.ts'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'
import { buildPresetTable, sessionsRegistry } from '../src/registry.ts'
import type { AcpSessionFactory } from '../src/registry.ts'

/** Capabilities of a stand-in dialect, shaped as `AcpDialect['capabilities']`; the wiring tests flip `cancelsTurns`. */
const FAKE_CAPABILITIES = {
  cancelsTurns: true,
  acceptsImageContent: false,
  toolFrameShape: 'two_frame',
  commandVia: 'tool_frame',
  toolNameMap: {},
} as const

const DECISION: StepDecisionLike = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

const TURN = { sessionId: 'dsh1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 }

/** One `session/update` frame, shaped the way the real frames arrive. */
const frame = (text: string): AcpFrame => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
})

/**
 * A client whose agent keeps working for a while: the prompt resolves long
 * after the stop lands, the way a real agent lags its cancellation.
 */
function slowClient(promptMs: number, stopReason: unknown): AcpClientPort & {
  cancelled: { method: string; params: unknown }[]
} {
  const cancelled: { method: string; params: unknown }[] = []
  return {
    cancelled,
    request: async method => {
      if (method === 'initialize') return {}
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') {
        // 模拟外部 agent 被取消后才结束
        await new Promise(resolve => setTimeout(resolve, promptMs))
        return { stopReason }
      }
      return {}
    },
    notify: (method, params) => {
      if (method === 'session/cancel') cancelled.push({ method, params })
    },
    onFrame: () => {},
  }
}

describe('AcpTurnRunner — stop signal', () => {
  it('runner 收到中止信号就发取消并中止落账', async () => {
    const client = slowClient(50, 'cancelled')
    const abort = new AbortController()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', abort: () => abort.signal })
    const p = runner.run(DECISION, TURN)
    setTimeout(() => abort.abort(), 10)
    const result = await p
    expect(client.cancelled).toEqual([{ method: 'session/cancel', params: { sessionId: 's1' } }])
    expect(result.end.kind).toBe('aborted')
  })

  it('ends aborted even when the agent answers something else after the stop', async () => {
    // The stop is what happened; an agent that races the cancel and reports a
    // normal end must not dress the turn up as a success.
    const client = slowClient(50, 'end_turn')
    const abort = new AbortController()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', abort: () => abort.signal })
    const p = runner.run(DECISION, TURN)
    setTimeout(() => abort.abort(), 10)
    const result = await p
    expect(result.end.kind).toBe('aborted')
  })

  it('discards frames that arrive after the stop', async () => {
    // 中止后到达的帧一律丢弃: the agent has not processed the cancel yet and
    // keeps talking; those frames belong to a turn nobody is reading.
    let emit: (frame: AcpFrame) => void = () => {}
    const client = slowClient(50, 'cancelled')
    client.onFrame = handler => { emit = handler }
    const abort = new AbortController()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', abort: () => abort.signal })
    const p = runner.run(DECISION, TURN)
    setTimeout(() => {
      abort.abort()
      emit(frame('arrived after the stop'))
    }, 10)
    const result = await p
    expect(result.end.kind).toBe('aborted')
    expect(result.frames).toHaveLength(0)
  })

  it('leaves a turn without a stop signal exactly as it was', async () => {
    // No abort capability, no behaviour change: no cancel goes out, and an
    // ordinary end stays an ordinary end.
    const client = slowClient(0, 'end_turn')
    const result = await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, TURN)
    expect(client.cancelled).toEqual([])
    expect(result.end.kind).toBe('completed')
  })
})

describe('stop wiring — dispatch to runner', () => {
  /**
   * The whole chain, hermetically: the patched step captures the turn's
   * signal, the table hands it to the runner at open, the runner listens, and
   * a stop mid-turn reaches the external agent. The factory is fake, the
   * runner is the real one — assembled the way the real factory assembles it,
   * options passed through untouched.
   */
  function wiredStopChain(capabilities: AcpDialect['capabilities']): {
    agent: { cancel(): void; step(decision: StepDecisionLike): Promise<{ kind: string }> }
    client: AcpClientPort & { cancelled: { method: string; params: unknown }[] }
  } {
    const client = slowClient(50, 'end_turn')
    const abort = new AbortController()

    /** Same prototype arrangement as the real loop agent: `step` and `cancel` on the class. */
    class StoppableAgent {
      session = { header: { agentPreset: 'acp-grok' } }
      phase = { abort }
      cancel(): void {
        abort.abort('user')
      }
      async step(_decision: StepDecisionLike): Promise<{ kind: string }> {
        return { kind: 'completed' }
      }
    }
    const agent = new StoppableAgent()

    const factory: AcpSessionFactory = {
      dialectFor: () => ({ id: 'fake', capabilities, readModels: () => [], foldTool: () => ({ callId: '', name: '', arguments: {} }), toolOutput: () => '', isContent: () => true, readReplyUsage: () => undefined }) as unknown as AcpDialect,
      open: async (_presetId, options) => {
        const runner = new AcpTurnRunner(client, options)
        return {
          run: async (decision, turn) => await runner.run(decision, turn),
          close: () => {},
          diagnostics: () => ({ lastFrameAt: Date.now(), lastDiagnosticAt: Date.now(), stderrTail: [] }),
          onDead: () => {},
        }
      },
      openShared: async () => {
        let dead = false
        return {
          get alive() { return !dead },
          openSession: async (opts) => {
            const runner = new AcpTurnRunner(client, {
              cwd: opts.cwd,
              dialect: opts.dialect,
              ...(opts.abort !== undefined ? { abort: opts.abort } : {}),
            })
            return {
              run: async (decision, turn) => await runner.run(decision, turn),
              close: () => {},
              onDead: () => {},
              diagnostics: () => ({ lastFrameAt: Date.now(), lastDiagnosticAt: Date.now(), stderrTail: [] }),
            }
          },
          kill: () => { dead = true },
          dropSession: () => {},
          sessionIds: () => [],
        }
      },
    }
    const table = buildPresetTable({ presets: { 'acp-grok': { agent: 'fake' } } }, factory, sessionsRegistry(), { cwdOfSession: () => '/workspace' })
    installAcpDispatch(agent, table, { produce: () => [], write: () => undefined, positionOf: () => ({ turn: 1, step: 1 }) })
    return { agent, client }
  }

  it('carries the host’s stop from the agent’s cancel to the external agent', async () => {
    const { agent, client } = wiredStopChain(FAKE_CAPABILITIES)
    const p = agent.step(DECISION)
    // The host's stop, the way the loop makes it: a method call on the agent.
    setTimeout(() => agent.cancel(), 10)
    const end = await p

    expect(end.kind).toBe('aborted')
    expect(client.cancelled).toEqual([{ method: 'session/cancel', params: { sessionId: 's1' } }])
  })

  it('does not wire the stop for a dialect that declares it cannot cancel turns', async () => {
    // The capability table is the single source of truth: a dialect without
    // `cancelsTurns` gets no cancel notice at all, even though the host's own
    // signal still fires — the turn runs to its ordinary end, exactly as
    // before the stop wiring existed.
    const { agent, client } = wiredStopChain({ ...FAKE_CAPABILITIES, cancelsTurns: false })
    const p = agent.step(DECISION)
    setTimeout(() => agent.cancel(), 10)
    const end = await p
    expect(client.cancelled).toEqual([])
    expect(end.kind).toBe('completed')
  })
})
