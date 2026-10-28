/**
 * Live terminal output streaming for grok's bash cards.
 *
 * grok delegates shell execution to the client via the terminal sub-protocol.
 * Without streaming, the UI shows nothing until the process exits and grok
 * relays the output in a tool_call_update. With streaming, output appears as
 * it arrives — the same experience grok's own UI gives.
 */

import type { AcpFrame } from '@threadharbor/dsh-acp-agent'
import { grokDialect } from '@threadharbor/dsh-acp-agent'
import { describe, expect, it } from 'vitest'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'
import type { StepDecisionLike } from '../src/dispatch.ts'
import { makeContentWriter } from '../src/content-writer.ts'
import type { ContentWriter } from '../src/content-writer.ts'

const DECISION: StepDecisionLike = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'run a command' }] }],
}

const update = (fields: Record<string, unknown>): AcpFrame['params'] => ({
  sessionId: 'ext',
  update: fields,
})

/** grok's run_terminal_command opening frame. */
const bashOpenFrame: AcpFrame = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: update({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-bash-1',
    title: 'run_terminal_command',
    rawInput: { command: 'echo hello' },
  }),
}

type Append = { type: string; payload: Record<string, unknown> }

function recordingWrite(): { write: ContentWriter; appends: Append[] } {
  const appends: Append[] = []
  const write = makeContentWriter((type, payload) => {
    appends.push({ type, payload: payload as Record<string, unknown> })
    return { seq: appends.length }
  })
  return { write, appends }
}

type Harness = {
  run: () => Promise<{ end: { kind: string } }>
  started: () => Promise<void>
  release: () => void
  appends: Append[]
  push: (frames: readonly AcpFrame[]) => void
  emitTerminalOutput: (terminalId: string, data: string) => void
  emitTerminalExit: (terminalId: string, exitCode: number) => void
}

function harness(): Harness {
  let deliver: ((frame: AcpFrame) => void) | undefined
  let releasePrompt: () => void
  let startedResolve: () => void
  const started = new Promise<void>(resolve => { startedResolve = resolve })
  let terminalOutputHandler: ((terminalId: string, data: string) => void) | undefined
  let terminalExitHandler: ((terminalId: string, exitCode: number) => void) | undefined

  const client: AcpClientPort = {
    onFrame: handler => { deliver = handler },
    onTerminalOutput: handler => { terminalOutputHandler = handler },
    onTerminalExit: handler => { terminalExitHandler = handler },
    notify: () => {},
    request: async method => {
      if (method === 'initialize') return {}
      if (method === 'session/new') return { sessionId: 'ext' }
      if (method === 'session/prompt') {
        startedResolve()
        await new Promise<void>(resolve => {
          releasePrompt = () => resolve()
        })
        return { stopReason: 'end_turn' }
      }
      return {}
    },
  }

  const { write, appends } = recordingWrite()
  const runner = new AcpTurnRunner(client, {
    cwd: '/tmp',
    dialect: grokDialect,
  })

  const running = runner.run(DECISION, {
    sessionId: 'dsh1',
    position: { turn: 1, step: 1 },
    produce: () => [],
    write,
  })

  return {
    run: () => running,
    started: () => started.then(() => new Promise<void>(resolve => { setTimeout(resolve, 0) })),
    release: () => releasePrompt(),
    appends,
    push: frames => {
      for (const frame of frames) deliver!(frame)
    },
    emitTerminalOutput: (terminalId, data) => terminalOutputHandler?.(terminalId, data),
    emitTerminalExit: (terminalId, exitCode) => terminalExitHandler?.(terminalId, exitCode),
  }
}

describe('live terminal output streaming', () => {
  it('streams output to the bash card as it arrives from the terminal', async () => {
    const h = harness()
    await h.started()

    // grok announces the bash tool call.
    h.push([bashOpenFrame])

    // The opening card should be written (as tool/call for the opening,
    // and tool/result for the terminal result).
    const toolCalls = h.appends.filter(a => a.type === 'tool/call')
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(toolCalls[0]!.payload['name']).toBe('bash')

    // Simulate terminal output arriving in chunks.
    h.emitTerminalOutput('term-1', 'hello ')
    h.emitTerminalOutput('term-1', 'world\n')

    // The card should have been updated with accumulated output.
    const updates = h.appends.filter(a => a.type === 'tool/result')
    const hasOutput = updates.some(a => {
      const payload = a.payload as { message?: { content?: { text?: string }[] } }
      const text = payload.message?.content?.[0]?.text ?? ''
      return text.includes('hello')
    })
    expect(hasOutput).toBe(true)

    h.release()
    await h.run()
  })

  it('settles the bash card on terminal exit', async () => {
    const h = harness()
    await h.started()

    h.push([bashOpenFrame])
    h.emitTerminalOutput('term-1', 'output data')
    h.emitTerminalExit('term-1', 0)

    h.release()
    const result = await h.run()

    expect(result.end.kind).toBe('completed')
    // The card should be settled (a tool/result should exist).
    const results = h.appends.filter(a => a.type === 'tool/result')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })
})
