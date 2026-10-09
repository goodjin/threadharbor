/**
 * Tests for the bridge from ACP permission requests to DSH's approval service.
 *
 * The case that matters most is the last one. An approval path that throws and
 * leaves the request unanswered reproduces the exact failure the bridge exists
 * to prevent: the agent sits waiting for an answer that never comes. There is
 * no error and no timeout — measured against a real agent, 240 s of silence.
 */

import { describe, expect, it } from 'vitest'
import { bridgePermissions, connectPermissions, toDecision } from '../src/approval.ts'
import type { PermissionRequest } from '../src/client.ts'

/** The permission request claude-agent-acp@0.76.0 emitted (2026-10-09). */
const REQUEST: PermissionRequest = {
  sessionId: 'ad5c2e8b-45e8-430e-a9f4-8eafaa37b127',
  toolName: 'Bash',
  title: "Write 'ok' to probe file",
  rawInput: { command: 'echo ok > /tmp/probe.txt' },
  options: [
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'reject', name: 'No', kind: 'reject_once' },
  ],
}

describe('folding DSH outcomes onto ACP decisions', () => {
  it('allows only on an explicit allow-once', () => {
    expect(toDecision('allowed-once')).toEqual({ outcome: 'allow' })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])('treats %s as a refusal', outcome => {
    expect(toDecision(outcome)).toEqual({ outcome: 'reject' })
  })

  it('treats an outcome it has never heard of as a refusal', () => {
    expect(toDecision('some-future-outcome')).toEqual({ outcome: 'reject' })
  })
})

describe('bridging a permission request', () => {
  it('passes the tool asking and the request id to the approval service', async () => {
    const asked: unknown[] = []
    await bridgePermissions(REQUEST, async request => {
      asked.push(request)
      return 'allowed-once'
    })
    expect(asked[0]).toMatchObject({ toolName: 'Bash' })
  })

  it('allows the tool when the user approves', async () => {
    const decision = await bridgePermissions(REQUEST, async () => 'allowed-once')
    expect(decision).toEqual({ outcome: 'allow' })
  })

  it('refuses when the user rejects', async () => {
    const decision = await bridgePermissions(REQUEST, async () => 'rejected')
    expect(decision).toEqual({ outcome: 'reject' })
  })

  it('still gives the user something to approve when the agent names no tool', async () => {
    const asked: { toolName: string }[] = []
    await bridgePermissions({ options: [] }, async request => {
      asked.push(request)
      return 'rejected'
    })
    expect(asked[0]!.toolName).toBe('tool')
  })

  it('fails closed when the approval service itself throws, so the turn is released', async () => {
    const decision = await bridgePermissions(REQUEST, async () => {
      throw new Error('approval.request() outside an open turn')
    })
    expect(decision).toEqual({ outcome: 'reject' })
  })

  it('never rejects — an approval request must always be answered', async () => {
    for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable', 'weird']) {
      await expect(bridgePermissions(REQUEST, async () => outcome)).resolves.toBeDefined()
    }
  })
})

describe('connectPermissions', () => {
  it('installs a handler on the client', async () => {
    const client: { onPermissionRequest: (request: PermissionRequest) => Promise<{ outcome: 'reject' }> } = {
      onPermissionRequest: async () => ({ outcome: 'reject' }),
    }
    connectPermissions(client, async () => 'allowed-once')
    await expect(client.onPermissionRequest(REQUEST)).resolves.toEqual({ outcome: 'allow' })
  })
})