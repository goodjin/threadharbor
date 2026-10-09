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

/** A transport that records what was written, and can push frames in. */
function fakeTransport(): AcpTransport & { readonly sent: string[]; deliver: (line: string) => void } {
  const sent: string[] = []
  let handler: (line: string) => void = () => {}
  return {
    sent,
    send: (line: string) => { sent.push(line) },
    onLine: (next: (line: string) => void) => { handler = next },
    close: () => {},
    deliver: (line: string) => handler(line),
  }
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
    await Promise.resolve()

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
    await Promise.resolve()

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
    await Promise.resolve()

    expect(asked?.toolName).toBe('Bash')
  })
})