/**
 * Client-side JSON-RPC tests for the shared ACP layer.
 *
 * The load-bearing case here is permission answering. Answering a
 * `session/request_permission` with a *notification* instead of a response is
 * accepted silently by the agent — the turn then simply never returns, with no
 * error and no timeout. That failure was measured, not imagined: a capture that
 * hung for the full 240 s budget with no output.
 */

import { describe, expect, it } from 'vitest'
import { AcpClient } from '../src/client.ts'
import type { AcpTransport } from '../src/transport.ts'
import { TerminalService } from '../src/terminals.ts'

/** A transport that records what was written, and can push frames in. */
function fakeTransport(): AcpTransport & { readonly sent: string[]; deliver: (line: string) => void; die: (reason: string) => void } {
  const sent: string[] = []
  let handler: (line: string) => void = () => {}
  let death: (reason: string) => void = () => {}
  return {
    sent,
    send: (line: string) => { sent.push(line) },
    onLine: (next: (line: string) => void) => { handler = next },
    onDeath: (next: (reason: string) => void) => { death = next },
    close: () => {},
    die: (reason: string) => { death(reason) },
    deliver: (line: string) => handler(line),
  }
}

/**
 * Let queued microtasks run.
 *
 * Answering an agent-initiated request now crosses an async boundary (a spawn
 * plus a service call), so a single `await Promise.resolve()` is not enough to
 * observe the reply. This waits longer rather than relaxing the assertions.
 */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

/** The exact permission request claude-agent-acp@0.76.0 emitted (2026-10-09). */
const PERMISSION_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'session/request_permission',
  params: {
    toolCall: { toolCallId: 'chatcmpl-tool-88f4fca4b7f7bc36', name: 'Bash', status: 'pending', rawInput: { command: 'echo ok > /tmp/probe.txt' } },
    options: [
      { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'reject', name: 'No', kind: 'reject_once' },
    ],
    sessionId: 'ad5c2e8b-45e8-430e-a9f4-8eafaa37b127',
  },
})

describe('AcpClient permission requests', () => {
  it('answers with a JSON-RPC response carrying the request id, not a notification', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'claude' })
    client.onPermissionRequest = async () => ({ outcome: 'allow' })
    transport.deliver(PERMISSION_REQUEST)
    await flush()

    expect(transport.sent).toHaveLength(1)
    const answer = JSON.parse(transport.sent[0]!) as Record<string, unknown>
    expect(answer['id']).toBe(0)
    expect(answer['method']).toBeUndefined()
  })

  it('selects the allow-once option the agent offered', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'claude' })
    client.onPermissionRequest = async () => ({ outcome: 'allow' })
    transport.deliver(PERMISSION_REQUEST)
    await flush()

    const answer = JSON.parse(transport.sent[0]!) as { result: { outcome: { optionId: string } } }
    expect(answer.result.outcome.optionId).toBe('allow-once')
  })

  it('surfaces the tool asking for permission, so a decision can be shown', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'claude' })
    let asked: { toolName?: string | undefined } | undefined
    client.onPermissionRequest = async request => {
      asked = { toolName: request.toolName }
      return { outcome: 'reject' }
    }
    transport.deliver(PERMISSION_REQUEST)
    await flush()

    expect(asked?.toolName).toBe('Bash')
  })
})
/**
 * The frame grok sent while a turn was in flight (captured 2026-10-09).
 *
 * grok delegates its shell work *to the client*: it sends `terminal/create` as a
 * JSON-RPC **request** carrying an id, and waits for the output. A client that
 * only understands responses and permission requests treats this as a
 * notification, nobody answers, and the turn never ends — the same silent hang
 * as answering a permission request with a notification, pointing the other way.
 */
const TERMINAL_CREATE = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'terminal/create',
  params: {
    sessionId: '01a11f40-825a-7712-a947-766e2fe5df10',
    command: "/bin/bash -lc 'echo ACP_LIVE_OK'",
    cwd: '/Users/good/github/threadharbor',
  },
})

describe('AcpClient handling agent-initiated requests', () => {
  it('runs the command and answers with its output, echoing the request id', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'grok' })
    const ran: string[] = []
    client.terminals = new TerminalService({
      spawn: spec => {
        ran.push(spec.command)
        return { output: () => 'ACP_LIVE_OK\n', exited: Promise.resolve(0), kill: () => {} }
      },
    })
    transport.deliver(TERMINAL_CREATE)
    await flush()

    expect(ran).toEqual(["/bin/bash -lc 'echo ACP_LIVE_OK'"])
    const answer = JSON.parse(transport.sent[0]!) as Record<string, unknown>
    expect(answer['id']).toBe(0)
    expect(answer['method']).toBeUndefined()
    // Only a terminal id: ACP's CreateTerminalResponse names no output field.
    expect(answer['result']).toEqual({ terminalId: 'term-1' })
  })

  it('answers with a JSON-RPC error instead of staying silent when nothing can run it', async () => {
    // Silence here is what strands the turn. An error at least lets the agent
    // report that it could not run the command.
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'grok' })
    transport.deliver(TERMINAL_CREATE)
    await flush()

    expect(transport.sent).toHaveLength(1)
    const answer = JSON.parse(transport.sent[0]!) as { id: number; error?: unknown }
    expect(answer.id).toBe(0)
    expect(answer.error).toBeDefined()
  })

  it('still answers when the command handler itself throws', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'grok' })
    client.terminals = new TerminalService({
      spawn: () => { throw new Error('no shell available') },
    })
    transport.deliver(TERMINAL_CREATE)
    await flush()

    expect(transport.sent).toHaveLength(1)
    expect(JSON.parse(transport.sent[0]!)['id']).toBe(0)
  })

  it('does not confuse an agent-initiated request with a notification', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'grok' })
    const notifications: unknown[] = []
    client.onNotification = frame => { notifications.push(frame) }
    client.terminals = new TerminalService({
      spawn: () => ({ output: () => '', exited: Promise.resolve(0), kill: () => {} }),
    })
    transport.deliver(TERMINAL_CREATE)
    await flush()

    expect(notifications).toEqual([])
  })

  it('reports every inbound frame to a listener, replies included', async () => {
    // Streaming needs to see text the moment it lands. An observer that saw
    // only notifications would miss replies; one that saw nothing would make
    // every turn look instant and empty.
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'grok' })
    const seen: unknown[] = []
    client.onFrame(frame => { seen.push(frame) })

    void client.request('session/new', { cwd: '/tmp', mcpServers: [] }).catch(() => undefined)
    transport.deliver(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessionId: 's1' } }))
    transport.deliver(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } }))
    await flush()

    expect(seen).toHaveLength(2)
  })

  it('keeps reporting frames after one listener throws', async () => {
    // A listener is an observer; one that throws must not take the turn with it.
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'grok' })
    const seen: unknown[] = []
    client.onFrame(() => { throw new Error('listener blew up') })
    client.onFrame(frame => { seen.push(frame) })

    transport.deliver(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }))
    await flush()

    expect(seen).toHaveLength(1)
  })
})

describe('AcpClient agent-specific extension requests', () => {
  it('lets a wired hook answer cursor/ask_question with a benign skipped outcome', async () => {
    // The blocking custom method stalls the turn if left unanswered; the hook
    // resolves it so the agent proceeds.
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'cursor' })
    client.onExtensionRequest = frame => {
      if (frame.method === 'cursor/ask_question') { client.reply(frame.id as number, { outcome: { outcome: 'skipped' } }); return true }
      return false
    }
    transport.deliver(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'cursor/ask_question', params: {} }))
    await flush()

    expect(transport.sent).toHaveLength(1)
    const answer = JSON.parse(transport.sent[0]!) as { id: number; result: { outcome: { outcome: string } } }
    expect(answer.id).toBe(7)
    expect(answer.result.outcome.outcome).toBe('skipped')
  })

  it('answers cursor/create_plan with cancelled', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'cursor' })
    client.onExtensionRequest = frame => {
      if (frame.method === 'cursor/create_plan') { client.reply(frame.id as number, { outcome: { outcome: 'cancelled' } }); return true }
      return false
    }
    transport.deliver(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'cursor/create_plan', params: {} }))
    await flush()

    const answer = JSON.parse(transport.sent[0]!) as { result: { outcome: { outcome: string } } }
    expect(answer.result.outcome.outcome).toBe('cancelled')
  })

  it('falls through to the default error when the hook declines', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'cursor' })
    client.onExtensionRequest = () => false
    transport.deliver(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'cursor/something_else', params: {} }))
    await flush()

    const answer = JSON.parse(transport.sent[0]!) as { id: number; error?: unknown }
    expect(answer.id).toBe(9)
    expect(answer.error).toBeDefined()
  })

  it('sends the default error when no hook is wired at all', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'codex' })
    transport.deliver(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'cursor/ask_question', params: {} }))
    await flush()

    const answer = JSON.parse(transport.sent[0]!) as { id: number; error?: unknown }
    expect(answer.error).toBeDefined()
  })
})

describe('a connection that dies', () => {
  it('fails the request that was waiting, instead of waiting forever', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'claude' })
    const pending = client.request('session/prompt', { sessionId: 's', prompt: 'hi' })
    // The agent never answers. Without the death signal this promise never
    // settles, and the turn spins with nothing on screen to explain why.
    transport.die('acp agent connection closed')
    await expect(pending).rejects.toThrow(/connection closed/)
  })

  it('says why, rather than only that it ended', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, { id: 'grok' })
    const pending = client.request('session/prompt', { sessionId: 's' })
    transport.die('acp agent exited (code=137 signal=null): killed')
    await expect(pending).rejects.toThrow(/code=137/)
  })
})
