/**
 * Permission requests, through the client the factory actually builds.
 *
 * The chain is: an agent sends a permission frame, the client's handler fires,
 * and whatever answers decides. Every link can be wired to the wrong thing and
 * nothing throws — the session just quietly refuses everything, or quietly allows
 * everything. Only driving the real client shows which one happened.
 */

import { describe, expect, it } from 'vitest'
import { makeSessionFactory } from '../src/factory.ts'
import type { AcpTransport, PermissionDecision } from '@threadharbor/dsh-acp-agent'

/** A transport a test can push frames through. */
function fakeTransport(): AcpTransport & { push(frame: unknown): void } {
  let deliver: (line: string) => void = () => {}
  return {
    onLine: (handler: (line: string) => void) => { deliver = handler },
    onDeath: () => {},
    send: () => {},
    lastFrameAt: () => 0,
    lastDiagnosticAt: () => 0,
    stderrTail: () => [],
    close: () => {},
    push: (frame: unknown) => { deliver(JSON.stringify(frame)) },
  }
}

/** Open a session, push one permission request through it, report what was asked. */
async function askPermission(answer: PermissionDecision | Error): Promise<unknown[]> {
  const transport = fakeTransport()
  const asked: unknown[] = []
  const factory = makeSessionFactory(
    { presets: { 'acp-grok': { agent: 'grok', url: 'ws://127.0.0.1:2419/ws' } } },
    {
      answerPermission: async request => {
        asked.push(request)
        if (answer instanceof Error) throw answer
        return answer
      },
      transport: () => transport,
    },
  )
  // Opening the session is what builds the client and connects the handler.
  await factory.open('acp-grok', { cwd: '/tmp' })

  transport.push({
    jsonrpc: '2.0', id: 99, method: 'session/request_permission',
    params: { sessionId: 's1', toolCall: { title: 'Run a command' }, options: [] },
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  return asked
}

describe('permission requests', () => {
  it('reaches the host instead of being decided by the row', async () => {
    // Before this was wired, the row answered "reject" itself — an agent could
    // never do anything and nothing on screen said why.
    const asked = await askPermission({ outcome: 'allow' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ sessionId: 's1' })
  })

  it('carries the tool the host needs to describe the request', async () => {
    // A prompt that says only "allow?" tells the operator nothing about what
    // they are allowing.
    const asked = await askPermission({ outcome: 'allow' })
    expect((asked[0] as { title?: unknown }).title).toBe('Run a command')
  })

  it('still reaches the host when the host is the thing that throws', async () => {
    // The host throws when there is no open turn. That must not be mistaken for
    // "no need to ask" — swallowing it leaves the agent waiting forever.
    const asked = await askPermission(new Error('no open turn'))
    expect(asked).toHaveLength(1)
  })
})
