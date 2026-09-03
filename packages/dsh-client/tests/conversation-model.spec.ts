import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RemoteDirectoryEntry, RemoteSessionView, RemoteTranscriptEntry } from '@threadharbor/protocol'
import { RemoteSessionId, RemoteTranscriptId } from '@threadharbor/protocol'
import {
  browsableDirectories, buildTranscriptNodes, conversationStage, isNearScrollBottom, mergeTranscriptEntries,
  permissionRequestId, preferredProjectBackend, shouldAutoApprovePermissions, toolDisclosurePresentation,
} from '../src/client/conversation-model.ts'

function entry(
  id: string,
  role: RemoteTranscriptEntry['role'],
  kind: RemoteTranscriptEntry['kind'],
  text: string,
): RemoteTranscriptEntry {
  return {
    transcriptId: RemoteTranscriptId(id),
    sessionId: RemoteSessionId('session'),
    seq: Number(id),
    role,
    kind,
    text,
    createdAt: '2026-08-29T00:00:00.000Z',
  }
}

function session(overrides: Partial<RemoteSessionView> = {}): RemoteSessionView {
  return {
    sessionId: RemoteSessionId('session'), projectId: 'project' as RemoteSessionView['projectId'],
    title: 'work', backend: 'codex', channelState: 'open', turnState: 'running',
    createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  }
}

describe('remote conversation view model', () => {
  it('keeps Claude ACP permission id 0 clickable', () => {
    expect(permissionRequestId({
      ...entry('1', 'permission', 'permission', '等待权限确认'),
      requestId: '0',
    })).toBe('0')
    expect(permissionRequestId({
      ...entry('2', 'permission', 'permission', '等待权限确认'),
      nativeFrame: { jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} },
    })).toBe('0')
  })

  it('keeps RemoteConversation hooks above every early return', () => {
    const source = readFileSync(new URL('../src/client/RemoteConversation.tsx', import.meta.url), 'utf8')
    const fn = source.slice(source.indexOf('export function RemoteConversation'))
    const earlyReturn = fn.indexOf('if (snapshot.panel !== undefined)')
    expect(earlyReturn).toBeGreaterThan(0)
    expect(fn.slice(earlyReturn)).not.toMatch(/\buse(Effect|LayoutEffect|Memo|State|Ref|SyncExternalStore)\(/)
  })

  it('auto-approves only the explicit auto approval choice', () => {
    expect(shouldAutoApprovePermissions('auto')).toBe(true)
    expect(shouldAutoApprovePermissions('ask')).toBe(false)
    expect(shouldAutoApprovePermissions(undefined)).toBe(false)
  })

  it('treats an already-open session as a live-channel join instead of a blocking attach', () => {
    const stage = conversationStage({
      session: session({ channelState: 'connecting', turnState: 'idle' }),
      entries: [],
      now: Date.parse('2026-08-29T00:00:00.000Z'),
    })
    expect(stage.label).toBe('正在接入实时通道')
    expect(stage.detail).toContain('WebSocket')
  })

  it('keeps running and completed tool calls collapsed to one status row by default', () => {
    expect(toolDisclosurePresentation(false, true)).toEqual({ initialOpen: false, status: '运行中' })
    expect(toolDisclosurePresentation(true, false)).toEqual({ initialOpen: false, status: '已完成' })
    expect(toolDisclosurePresentation(false, false)).toEqual({ initialOpen: false, status: '无结果' })
  })

  it('restores the last available Agent for a project and otherwise selects the first', () => {
    const oldSession = session({ sessionId: RemoteSessionId('old'), backend: 'grok' })
    const latestSession = session({ sessionId: RemoteSessionId('latest'), backend: 'claude' })
    expect(preferredProjectBackend(['grok', 'claude'], [oldSession, latestSession])).toBe('claude')
    expect(preferredProjectBackend(['grok', 'codex'], [oldSession, latestSession])).toBe('grok')
    expect(preferredProjectBackend(['codex', 'grok'], [])).toBe('codex')
    expect(preferredProjectBackend([], [latestSession])).toBe('')
  })

  it('only follows live output while the reader remains near the bottom', () => {
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 552, clientHeight: 400 })).toBe(true)
    expect(isNearScrollBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).toBe(false)
  })

  it('renders adjacent streamed assistant chunks in one message while preserving boundaries', () => {
    const merged = mergeTranscriptEntries([
      entry('1', 'user', 'message', '问题'),
      entry('2', 'assistant', 'reasoning', '先'),
      entry('3', 'assistant', 'reasoning', '想'),
      entry('4', 'assistant', 'message', '答'),
      entry('5', 'assistant', 'message', '案'),
      entry('6', 'system', 'status', '完成'),
      entry('7', 'assistant', 'message', '下一轮'),
    ])

    expect(merged.map(item => [item.role, item.kind, item.text])).toEqual([
      ['user', 'message', '问题'],
      ['assistant', 'reasoning', '先想'],
      ['assistant', 'message', '答案'],
      ['system', 'status', '完成'],
      ['assistant', 'message', '下一轮'],
    ])
  })

  it('assembles one tool call and its result into a single visual node', () => {
    const nodes = buildTranscriptNodes([
      entry('1', 'assistant', 'message', '我来查看。'),
      entry('2', 'tool', 'tool-call', 'read_file'),
      entry('3', 'tool', 'tool-result', 'file contents'),
      entry('4', 'assistant', 'message', '已完成。'),
    ])

    expect(nodes).toHaveLength(3)
    expect(nodes[1]).toMatchObject({
      kind: 'tool',
      title: 'read_file',
      entries: [
        { kind: 'tool-call', text: 'read_file' },
        { kind: 'tool-result', text: 'file contents' },
      ],
    })
  })

  it('collapses consecutive tool calls and results into one disclosure row', () => {
    const nodes = buildTranscriptNodes([
      entry('1', 'assistant', 'message', '开始处理。'),
      entry('2', 'tool', 'tool-call', 'read_file'),
      entry('3', 'tool', 'tool-result', 'file contents'),
      entry('4', 'tool', 'tool-call', 'apply_patch'),
      entry('5', 'tool', 'tool-result', 'done'),
      entry('6', 'assistant', 'message', '处理完成。'),
    ])

    expect(nodes).toHaveLength(3)
    expect(nodes[1]).toMatchObject({
      kind: 'tool',
      title: '连续工具调用 · 2 次',
      entries: [
        { kind: 'tool-call', text: 'read_file' },
        { kind: 'tool-result', text: 'file contents' },
        { kind: 'tool-call', text: 'apply_patch' },
        { kind: 'tool-result', text: 'done' },
      ],
    })
  })

  it('shows client-owned stages before the backend emits its first event', () => {
    const remoteSession = session()
    const base = {
      session: remoteSession, entries: [], now: 10_000,
      progress: { sessionId: 'session', phase: 'sending' as const, startedAt: 1_000, baselineSeq: -1 },
    }
    expect(conversationStage(base)).toMatchObject({ kind: 'sending', label: '正在发送消息', state: 'ongoing' })
    expect(conversationStage({ ...base, progress: { ...base.progress, phase: 'waiting' } }))
      .toMatchObject({ kind: 'waiting', label: '等待 Agent 响应' })
    expect(conversationStage({
      session: remoteSession,
      entries: [
        entry('1', 'assistant', 'message', '上一轮回复'),
        entry('2', 'user', 'message', '新问题'),
      ],
      now: Date.parse('2026-08-29T00:00:01.000Z'),
    })).toMatchObject({ kind: 'waiting', label: '等待 Agent 响应' })
    expect(conversationStage({ ...base, now: 32_000, progress: { ...base.progress, phase: 'waiting' } }))
      .toMatchObject({ kind: 'timeout', label: '等待响应超时', state: 'warning' })
    expect(conversationStage({
      ...base, progress: { ...base.progress, phase: 'failed', message: 'request timed out' },
    })).toMatchObject({ kind: 'timeout', label: '请求超时', state: 'error' })
  })

  it('derives thinking, tool, permission, reconnecting, and failure stages without generic running text', () => {
    expect(conversationStage({ session: session(), entries: [entry('1', 'assistant', 'reasoning', '分析')], now: 0 }))
      .toMatchObject({ kind: 'thinking', label: '思考中' })
    expect(conversationStage({ session: session(), entries: [entry('2', 'tool', 'tool-call', 'read_file')], now: 0 }))
      .toMatchObject({ kind: 'tool', label: '工具执行中', detail: 'read_file' })
    expect(conversationStage({ session: session({ turnState: 'waiting-permission' }), entries: [], now: 0 }))
      .toMatchObject({ kind: 'permission', state: 'warning' })
    expect(conversationStage({ session: session({ channelState: 'reconnecting' }), entries: [], now: 0 }))
      .toMatchObject({ kind: 'reconnecting', label: '连接异常，正在重试' })
    expect(conversationStage({ session: session({ turnState: 'failed' }), entries: [], now: 0 }))
      .toMatchObject({ kind: 'failed', label: '本轮执行失败' })
    expect(conversationStage({ session: session({ turnState: 'stopped' }), entries: [], now: 0 }))
      .toMatchObject({ kind: 'stopped', label: '用户主动停止', state: 'done', visible: true })
  })

  it('hides dot-directories from picker rows without changing explicit paths', () => {
    const entries: RemoteDirectoryEntry[] = [
      { name: '.config', path: '/home/me/.config', kind: 'directory' },
      { name: 'repo', path: '/home/me/repo', kind: 'directory' },
      { name: '.env', path: '/home/me/.env', kind: 'file' },
    ]
    expect(browsableDirectories(entries)).toEqual([
      { name: 'repo', path: '/home/me/repo', kind: 'directory' },
    ])
  })
})
