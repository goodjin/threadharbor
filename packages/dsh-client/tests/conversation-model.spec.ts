import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RemoteDirectoryEntry, RemoteSessionView, RemoteTranscriptEntry } from '@threadharbor/protocol'
import { RemoteSessionId, RemoteTranscriptId } from '@threadharbor/protocol'
import {
  browsableDirectories, buildTranscriptNodes, choiceCancelOutcome, choiceSubmitOutcome,
  conversationPresentation, conversationStage,
  isAutoApprovablePermission, isNearScrollBottom, mergeTranscriptEntries, parseChoicePrompt, parsePlanItems,
  autoApproveOptionId, pendingPermissionEntry, permissionRequestId, preferredProjectBackend,
  shouldAutoApprovePermissions, shouldPinPendingPermission, toolDisclosurePresentation,
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
  it('turns AskUserQuestion elicitations and permission grants into the same choice model', () => {
    const question = parseChoicePrompt({
      ...entry('3', 'permission', 'permission', '选哪种方案？'),
      nativeFrame: {
        jsonrpc: '2.0', id: 3, method: 'elicitation/create',
        params: {
          mode: 'form',
          message: '选哪种方案？',
          requestedSchema: {
            type: 'object',
            properties: {
              strategy: {
                type: 'string',
                title: '实现策略',
                enum: ['conservative', 'balanced', 'aggressive'],
              },
            },
          },
        },
      },
    })
    expect(question).toMatchObject({ kind: 'question', title: '选哪种方案？' })
    expect(question?.questions[0]?.options.map(option => option.id)).toEqual(['conservative', 'balanced', 'aggressive'])
    expect(choiceSubmitOutcome(question!, { strategy: 'balanced' })).toEqual({
      action: 'accept', content: { strategy: 'balanced' },
    })
    expect(choiceCancelOutcome(question!)).toEqual({ action: 'cancel' })
    expect(isAutoApprovablePermission({
      ...entry('3', 'permission', 'permission', '选哪种方案？'),
      nativeFrame: { jsonrpc: '2.0', id: 3, method: 'elicitation/create', params: { message: '选哪种方案？' } },
    })).toBe(false)

    const permission = parseChoicePrompt({
      ...entry('7', 'permission', 'permission', 'Allow shell?'),
      nativeFrame: {
        jsonrpc: '2.0', id: 7, method: 'session/request_permission',
        params: { title: 'Allow shell?', options: [{ optionId: 'once', name: 'Allow once' }] },
      },
    })
    expect(permission?.kind).toBe('permission')
    expect(choiceSubmitOutcome(permission!, { optionId: 'once' })).toEqual({
      outcome: 'selected', optionId: 'once',
    })
    expect(isAutoApprovablePermission({
      ...entry('7', 'permission', 'permission', 'Allow shell?'),
      nativeFrame: { jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} },
    })).toBe(true)
  })

  it('keeps the latest plan list and renders structured entries', () => {
    const first = {
      ...entry('8', 'system', 'status', '阅读鉴权'),
      nativeFrame: {
        jsonrpc: '2.0', method: 'session/update',
        params: { update: { sessionUpdate: 'plan', entries: [{ content: '阅读鉴权', status: 'pending', priority: 'high' }] } },
      },
    }
    const next = {
      ...entry('9', 'system', 'status', '阅读鉴权；补测试'),
      nativeFrame: {
        jsonrpc: '2.0', method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: '阅读鉴权', status: 'completed', priority: 'high' },
              { content: '补测试', status: 'in_progress', priority: 'medium' },
            ],
          },
        },
      },
    }
    expect(parsePlanItems(next)?.map(item => item.content)).toEqual(['阅读鉴权', '补测试'])
    expect(mergeTranscriptEntries([first, next])).toEqual([next])
  })

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
    expect(shouldAutoApprovePermissions('ask', 'bypass')).toBe(true)
    expect(shouldAutoApprovePermissions('ask', 'full-access')).toBe(true)
    expect(shouldAutoApprovePermissions('ask', 'edit')).toBe(false)
  })

  it('picks bypassPermissions when skip-confirm is on, and pins a scrolled-away card', () => {
    const permission = {
      ...entry('371', 'permission', 'permission', '等待权限确认'),
      requestId: '0',
      nativeFrame: {
        jsonrpc: '2.0', id: 0, method: 'session/request_permission',
        params: {
          options: [
            { optionId: 'bypassPermissions', name: 'Yes, and bypass permissions' },
            { optionId: 'auto', name: 'Yes, and use "auto" mode' },
            { optionId: 'plan', name: 'No, keep planning' },
          ],
        },
      },
    }
    const prompt = parseChoicePrompt(permission)
    expect(autoApproveOptionId(prompt, { permissionMode: 'bypass' })).toBe('bypassPermissions')
    expect(autoApproveOptionId(prompt, { approvalChoice: 'auto' })).toBe('auto')
    expect(pendingPermissionEntry([
      entry('370', 'assistant', 'message', '计划'),
      permission,
      entry('372', 'tool', 'tool-call', 'Edit'),
    ])).toEqual(permission)
    expect(shouldPinPendingPermission('waiting-permission', permission, 'native-tool')).toBe(true)
    expect(shouldPinPendingPermission('waiting-permission', permission, permission.transcriptId)).toBe(false)
    expect(shouldPinPendingPermission('running', permission, 'native-tool')).toBe(false)
    expect(conversationStage({
      session: session({ turnState: 'waiting-permission' }),
      entries: [permission, entry('372', 'tool', 'tool-call', 'Edit')],
      now: 0,
    })).toMatchObject({ kind: 'permission', label: '等待你的确认', visible: true })
  })

  it('treats an already-open session as a live-channel join instead of a blocking attach', () => {
    const view = conversationPresentation({
      session: session({ channelState: 'connecting', turnState: 'idle' }),
      entries: [],
      now: Date.parse('2026-08-29T00:00:00.000Z'),
    })
    expect(view.channel.label).toBe('正在接入实时通道')
    expect(view.channel.detail).toContain('WebSocket')
    expect(view.turn.visible).toBe(false)
  })

  it('shows one connecting banner while the first prompt waits for the hold', () => {
    const view = conversationPresentation({
      session: session({ channelState: 'connecting', turnState: 'idle' }),
      entries: [],
      now: 10_000,
      progress: { sessionId: 'session', phase: 'sending', startedAt: 1_000, baselineSeq: -1 },
    })
    expect(view.channel.label).toBe('正在连接 Agent')
    expect(view.channel.visible).toBe(true)
    expect(view.turn.visible).toBe(false)
    expect(view.headerLabel).toBe('正在连接 Agent')
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
    expect(conversationPresentation({
      session: session({ channelState: 'reconnecting', turnState: 'failed' }), entries: [], now: 0,
    })).toMatchObject({
      channel: { kind: 'reconnecting', label: '会话通道中断', visible: true },
      turn: { kind: 'failed', label: '本轮执行失败', visible: true },
      headerLabel: '会话通道中断 · 本轮执行失败',
      actions: { canReconnect: true, canSend: false, canStop: false, canCompose: false },
    })
    expect(conversationPresentation({
      session: session({ channelState: 'lost', turnState: 'idle' }), entries: [], now: 0,
    })).toMatchObject({
      channel: { kind: 'failed', label: '连接已丢失', detail: '远程会话进程已停止。可以点「在当前会话重开」，对话记录会保留。' },
      actions: { canReconnect: true, canCompose: false },
    })
    expect(conversationPresentation({
      session: session({ channelState: 'open', turnState: 'waiting-permission' }), entries: [], now: 0,
    }).actions).toMatchObject({ canStop: true, canSend: false, canCompose: true, canReconnect: false })
    expect(conversationPresentation({
      session: session({ channelState: 'open' }), entries: [], now: 0, transportPhase: 'reconnecting',
    })).toMatchObject({
      channel: { kind: 'transport', label: '实时通道断开，正在自动重连' },
      actions: { canReconnect: false, canSend: false, canCompose: false },
    })
    expect(conversationPresentation({
      session: session({ channelState: 'open', turnState: 'running' }),
      entries: [entry('1', 'assistant', 'message', '正在输出')],
      now: 0,
      transportPhase: 'error',
      error: 'Error: ws did not reach live phase in time',
    })).toMatchObject({
      channel: { visible: false },
      turn: { kind: 'responding', visible: true },
      actions: { canCompose: true, canSend: false, canStop: true },
    })
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
