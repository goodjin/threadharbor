/**
 * Asking another host to take over a conversation.
 *
 * With one tab per host there is no connection from the roll-up to the machine
 * that holds a session — only the channel between tabs. So a cross-host switch
 * is a request to the owning tab: it runs the handover locally, where the
 * session actually lives, and reports what came of it.
 *
 * The reply has to carry refusals as refusals. A request that comes back empty
 * would leave the roll-up showing a switch that never happened.
 */

import { describe, expect, it } from 'vitest'
import { HostFederation } from '../src/federation.ts'
import type { FederationBus, HostSession } from '../src/federation.ts'
import type { HostIdentity } from '../src/identity.ts'
import { installHandoverResponder, requestHandover } from '../src/handover.ts'
import type { HandoverRequest, HandoverReply } from '../src/handover.ts'

const ME: HostIdentity = { hostId: 'alpha', hostTitle: 'Alpha', derived: false }
const BETA: HostIdentity = { hostId: 'beta', hostTitle: 'Beta', derived: false }

function bus() {
  const posted: unknown[] = []
  const listeners = new Set<(message: unknown) => void>()
  const port: FederationBus = {
    post: message => { posted.push(message) },
    subscribe: listener => { listeners.add(listener) },
  }
  return {
    posted,
    port,
    deliver: (message: unknown) => { for (const listener of listeners) listener(message) },
  }
}

const session = (sessionId: string, hostId: string): HostSession => ({
  projectId: 'w1', sessionId, title: sessionId, hostId,
} as HostSession & { hostId: string })

function responderTab(options: {
  runs?: (request: HandoverRequest) => Promise<{ sessionId: string }>
  sessions?: HostSession[]
} = {}) {
  const channel = bus()
  const fed = new HostFederation(ME, channel.port, {
    staleMs: 1_000,
    listSessions: () => options.sessions ?? [session('s1', 'alpha')],
  })
  fed.start()
  const calls: HandoverRequest[] = []
  installHandoverResponder(fed, channel.port, async request => {
    calls.push(request)
    return options.runs?.(request) ?? { sessionId: `${request.sessionId}-copy` }
  })
  return { channel, fed, calls }
}

function replies(posted: unknown[]): HandoverReply[] {
  return posted.filter((m): m is HandoverReply => (m as { kind?: string }).kind === 'handover-reply')
}

describe('requestHandover', () => {
  it('asks the host that holds the session, not this one', () => {
    const channel = bus()
    requestHandover(channel.port, { fromHostId: 'gamma', sessionId: 's1', toHostId: 'beta', toPresetId: 'acp-claude' })
    const request = channel.posted[0] as HandoverRequest
    expect(request).toMatchObject({ kind: 'handover-request', toHostId: 'beta', sessionId: 's1' })
  })

  it('refuses to ask this tab’s own host over the channel', () => {
    // This tab can do it locally; sending it over the wire would take a slower
    // path to the same place and hide local refusals.
    const channel = bus()
    const request = requestHandover(channel.port, { fromHostId: 'gamma', sessionId: 's1', toHostId: 'gamma', toPresetId: 'x' })
    expect(request).toEqual({ kind: 'ignored' })
    expect(channel.posted).toEqual([])
  })

  it('refuses a request that names no target', () => {
    const channel = bus()
    expect(requestHandover(channel.port, { fromHostId: 'g', sessionId: 's1', toHostId: 'beta', toPresetId: '' }))
      .toEqual({ kind: 'ignored' })
    expect(channel.posted).toEqual([])
  })
})

describe('handover responder', () => {
  it('runs a request addressed to this host', async () => {
    const { channel, calls } = responderTab()
    channel.deliver({ kind: 'handover-request', fromHostId: 'gamma', toHostId: 'alpha', sessionId: 's1', toPresetId: 'acp-claude' })
    await settle()
    expect(calls.map(c => c.sessionId)).toEqual(['s1'])
  })

  it('answers with the session the conversation moved to', async () => {
    const { channel } = responderTab({ runs: async () => ({ sessionId: 's1-copy' }) })
    channel.deliver({ kind: 'handover-request', fromHostId: 'gamma', toHostId: 'alpha', sessionId: 's1', toPresetId: 'acp-claude' })
    await settle()
    expect(replies(channel.posted)).toEqual([
      { kind: 'handover-reply', toHostId: 'gamma', sessionId: 's1', result: { kind: 'switched', sessionId: 's1-copy' } },
    ])
  })

  it('ignores a request aimed at another host', async () => {
    // Every tab hears every message; acting on someone else's would have two
    // hosts claiming one conversation.
    const { channel, calls } = responderTab()
    channel.deliver({ kind: 'handover-request', fromHostId: 'gamma', toHostId: 'beta', sessionId: 's1', toPresetId: 'acp-claude' })
    await settle()
    expect(calls).toEqual([])
    expect(replies(channel.posted)).toEqual([])
  })

  it('refuses a request for a session this host does not hold', async () => {
    const { channel, calls } = responderTab({ sessions: [] })
    channel.deliver({ kind: 'handover-request', fromHostId: 'gamma', toHostId: 'alpha', sessionId: 'gone', toPresetId: 'acp-claude' })
    await settle()
    expect(calls).toEqual([])
    expect(replies(channel.posted)[0]?.result.kind).toBe('unknown-session')
  })

  it('passes a refusal back as a refusal', async () => {
    // A refusal that came back empty would leave the roll-up showing a switch
    // that never happened.
    const { channel } = responderTab({ runs: async () => { throw Object.assign(new Error('too large by 108000 tokens'), { kind: 'too-long' }) } })
    channel.deliver({ kind: 'handover-request', fromHostId: 'gamma', toHostId: 'alpha', sessionId: 's1', toPresetId: 'acp-claude' })
    await settle()
    expect(replies(channel.posted)[0]?.result).toMatchObject({ kind: 'too-long' })
  })

  it('passes an ordinary failure back with its reason', async () => {
    const { channel } = responderTab({ runs: async () => { throw new Error('target unreachable') } })
    channel.deliver({ kind: 'handover-request', fromHostId: 'gamma', toHostId: 'alpha', sessionId: 's1', toPresetId: 'acp-claude' })
    await settle()
    const result = replies(channel.posted)[0]?.result
    expect(result?.kind).toBe('failed')
    expect(result?.kind === 'failed' && result.message).toContain('target unreachable')
  })

  it('does not let a rejected request stop later ones', async () => {
    const { channel, calls } = responderTab({ runs: async () => { throw new Error('boom') } })
    channel.deliver({ kind: 'handover-request', fromHostId: 'gamma', toHostId: 'alpha', sessionId: 's1', toPresetId: 'a' })
    await settle()
    channel.deliver({ kind: 'handover-request', fromHostId: 'gamma', toHostId: 'alpha', sessionId: 's1', toPresetId: 'b' })
    await settle()
    expect(calls).toHaveLength(2)
  })
})

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}