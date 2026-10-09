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
const describeRequest = (request: PermissionRequest): { toolName: string; callId?: string; reason?: string } => ({
  toolName: request.toolName ?? 'unknown',
  callId: String(request.requestId ?? ''),
  ...(request.title === undefined ? {} : { reason: request.title }),
})

describe('makeApprovalBridge', () => {
  it('allows when the host grants', async () => {
    const bridge = makeApprovalBridge(ask(ALLOWED_ONCE), undefined, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'allow' })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])('refuses on %s', async outcome => {
    const bridge = makeApprovalBridge(ask(outcome), undefined, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'reject' })
  })

  it('refuses on a value it does not recognise', async () => {
    const bridge = makeApprovalBridge(ask('allowed-always'), undefined, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'reject' })
  })

  it('refuses rather than hangs when the host throws', async () => {
    // The host throws when there is no open turn to attach the request to;
    // waiting for an answer that can never come is the worse failure.
    const bridge = makeApprovalBridge(async () => { throw new Error('no open turn') }, undefined, describeRequest)
    expect(await bridge(REQUEST)).toEqual({ outcome: 'reject' })
  })

  it('tells the host what the agent wants to do', async () => {
    const seen: unknown[] = []
    const bridge = makeApprovalBridge(async request => { seen.push(request); return ALLOWED_ONCE }, { id: 'a1' }, describeRequest)
    await bridge(REQUEST)
    expect(seen[0]).toMatchObject({ agent: { id: 'a1' }, toolName: 'Bash', reason: 'Run `ls`' })
  })

  it('never asks without naming a tool', async () => {
    // A nameless request renders as a blank prompt nobody can judge.
    const seen: unknown[] = []
    const bridge = makeApprovalBridge(async request => { seen.push(request); return ALLOWED_ONCE }, undefined, describeRequest)
    const { toolName: _dropped, ...withoutTool } = REQUEST
    await bridge(withoutTool)
    expect(seen[0]).toMatchObject({ toolName: 'unknown' })
  })
})
