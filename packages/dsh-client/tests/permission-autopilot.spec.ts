import { describe, expect, it } from 'vitest'
import type { RemoteSessionView, RemoteTranscriptEntry } from '@threadharbor/protocol'
import { RemoteProjectId, RemoteSessionId, RemoteTranscriptId } from '@threadharbor/protocol'
import { permissionActionKey, scanAutoApprovals, sessionAutoApproves } from '../src/client/permission-autopilot.ts'

function session(overrides: Partial<RemoteSessionView> & { sessionId: string }): RemoteSessionView {
  return {
    projectId: RemoteProjectId('p'), title: 'work', backend: 'claude', channelState: 'open',
    turnState: 'waiting-permission', createdAt: 'a', updatedAt: 'b',
    ...overrides, sessionId: RemoteSessionId(overrides.sessionId),
  }
}

const BYPASS = [{
  id: 'mode', name: 'Mode', category: 'mode', currentValue: 'bypassPermissions', setter: 'mode' as const,
  options: [{ value: 'default', name: 'Default' }, { value: 'bypassPermissions', name: 'Bypass' }],
}]

function permission(sessionId: string, seq: number, id: number): RemoteTranscriptEntry {
  return {
    transcriptId: RemoteTranscriptId(`${sessionId}-${seq}`), sessionId: RemoteSessionId(sessionId), seq,
    role: 'permission', kind: 'permission', text: '等待权限确认', createdAt: 'c', requestId: String(id),
    nativeFrame: {
      jsonrpc: '2.0', id, method: 'session/request_permission',
      params: { toolCall: { title: 'git fetch' }, options: [
        { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
        { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
      ] },
    },
  }
}

describe('permission autopilot', () => {
  it('decides from either the browser preference or the backend mode', () => {
    expect(sessionAutoApproves(session({ sessionId: 's' }), { approvalChoice: 'auto' })).toBe(true)
    expect(sessionAutoApproves(session({ sessionId: 's' }), { permissionMode: 'bypass' })).toBe(true)
    expect(sessionAutoApproves(session({ sessionId: 's', configOptions: BYPASS }), undefined)).toBe(true)
    expect(sessionAutoApproves(session({ sessionId: 's' }), { approvalChoice: 'ask', permissionMode: 'edit' })).toBe(false)
  })

  it('answers a background session that is waiting, not only the one on screen', () => {
    const sessions = [
      session({ sessionId: 'active', turnState: 'idle' }),
      session({ sessionId: 'bg', latestTranscriptSeq: 4, configOptions: BYPASS }),
      session({ sessionId: 'manual', latestTranscriptSeq: 1 }),
    ]
    const transcript = [permission('bg', 4, 7), permission('manual', 1, 8)]
    const scan = scanAutoApprovals(sessions, transcript, () => ({ approvalChoice: 'ask' }))
    expect(scan.answers).toEqual([{
      sessionId: 'bg', requestId: '7', optionId: 'allow', key: permissionActionKey('bg', '7'),
    }])
    expect(scan.needsTranscript).toEqual([])
  })

  it('answers the request the gateway says is open, not the last permission row', () => {
    const sessions = [session({ sessionId: 'bg', latestTranscriptSeq: 6, configOptions: BYPASS, pendingRequestIds: ['7'] })]
    const answeredEarlier = permission('bg', 6, 9)
    const scan = scanAutoApprovals(sessions, [permission('bg', 4, 7), answeredEarlier], () => undefined)
    expect(scan.answers.map(answer => answer.requestId)).toEqual(['7'])
  })

  it('waits for the transcript to catch up instead of answering a stale card', () => {
    const sessions = [session({ sessionId: 'bg', latestTranscriptSeq: 9, configOptions: BYPASS })]
    // The only local permission card is an older request (seq 4 < latest 9).
    const scan = scanAutoApprovals(sessions, [permission('bg', 4, 7)], () => undefined)
    expect(scan.answers).toEqual([])
    expect(scan.needsTranscript).toEqual(['bg'])
    const empty = scanAutoApprovals([session({ sessionId: 'bg', configOptions: BYPASS })], [], () => undefined)
    expect(empty.answers).toEqual([])
    expect(empty.needsTranscript).toEqual(['bg'])
  })

  it('leaves AskUserQuestion-style prompts and non-waiting sessions alone', () => {
    const question: RemoteTranscriptEntry = {
      ...permission('bg', 2, 3),
      nativeFrame: { jsonrpc: '2.0', id: 3, method: 'elicitation/create', params: { message: 'pick one' } },
    }
    const scan = scanAutoApprovals(
      [session({ sessionId: 'bg', latestTranscriptSeq: 2 }), session({ sessionId: 'done', turnState: 'idle' })],
      [question, permission('done', 5, 9)],
      () => ({ approvalChoice: 'auto' }),
    )
    expect(scan.answers).toEqual([])
    expect(scan.needsTranscript).toEqual([])
  })
})
