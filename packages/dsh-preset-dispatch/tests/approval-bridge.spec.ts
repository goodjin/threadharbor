/**
 * The approval bridge, against the host's closed outcome vocabulary.
 *
 * The host grants exactly one way. Everything else — the three refusal values,
 * a value invented later, and a thrown error — has to come out as a refusal,
 * because a bridge that guessed the other way on an unfamiliar value would hand
 * a tool permission nobody approved.
 */

import { describe, expect, it } from 'vitest'
import { ALLOWED_ONCE, makeApprovalBridge } from '../src/approval-bridge.ts'
import type { PermissionRequest } from '@threadharbor/dsh-acp-agent'

const REQUEST: PermissionRequest = {
  requestId: 7,
  toolName: 'Bash',
  title: 'Run `ls`',
  rawInput: { command: 'ls' },
  options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
}

const ask = (outcome: unknown) => async () => outcome
const AGENT = { id: 'a1' }
const describeRequest = (request: PermissionRequest): { toolName: string; callId?: string; reason?: string } => ({
  toolName: request.toolName ?? 'unknown',
  callId: String(request.requestId ?? ''),
  ...(request.title === undefined ? {} : { reason: request.title }),
})

describe('makeApprovalBridge', () => {
  it('allows when the host grants', async () => {
    const bridge = makeApprovalBridge(ask(ALLOWED_ONCE), () => AGENT, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'allow' })
  })

  it('auto-allows when no agent is registered (gateway path: user chose this model)', async () => {
    // The gateway opens an external conversation for a session it doesn't take
    // over, so no agent is registered in the agents map. Without one there is
    // nothing to attach an approval card to — silently rejecting makes a
    // capable agent report「策略是 never」and refuse every command.
    const bridge = makeApprovalBridge(ask('rejected'), () => undefined, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'allow' })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])('refuses on %s', async outcome => {
    const bridge = makeApprovalBridge(ask(outcome), () => AGENT, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'reject' })
  })

  it('refuses on a value it does not recognise', async () => {
    const bridge = makeApprovalBridge(ask('allowed-always'), () => AGENT, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'reject' })
  })

  it('refuses rather than hangs when the host throws', async () => {
    // The host throws when there is no open turn to attach the request to;
    // waiting for an answer that can never come is the worse failure.
    const bridge = makeApprovalBridge(async () => { throw new Error('no open turn') }, () => AGENT, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'reject' })
  })

  it('tells the host what the agent wants to do, and who is asking', async () => {
    const seen: unknown[] = []
    const bridge = makeApprovalBridge(async request => { seen.push(request); return ALLOWED_ONCE }, () => ({ id: 'a1' }), describeRequest)
    await bridge(REQUEST)
    expect(seen[0]).toMatchObject({ agent: { id: 'a1' }, toolName: 'Bash', reason: 'Run `ls`' })
  })

  it('resolves the agent from the request, not from a fixed capture', async () => {
    // Several sessions are live at once and a request names its session, so the
    // bridge has to ask per request. A bridge built around one captured agent
    // would attach every prompt to the wrong conversation.
    const seen: unknown[] = []
    const agents = new Map([['s1', { id: 'a1' }], ['s2', { id: 'a2' }]])
    const bridge = makeApprovalBridge(
      async request => { seen.push(request); return ALLOWED_ONCE },
      request => request.sessionId === undefined ? undefined : agents.get(request.sessionId),
      describeRequest,
    )
    await bridge({ ...REQUEST, sessionId: 's2' })
    expect(seen[0]).toMatchObject({ agent: { id: 'a2' } })
  })

  it('never asks without naming a tool', async () => {
    // A nameless request renders as a blank prompt nobody can judge.
    const seen: unknown[] = []
    const bridge = makeApprovalBridge(async request => { seen.push(request); return ALLOWED_ONCE }, () => AGENT, describeRequest)
    const { toolName: _dropped, ...withoutTool } = REQUEST
    await bridge(withoutTool)
    expect(seen[0]).toMatchObject({ toolName: 'unknown' })
  })
})
