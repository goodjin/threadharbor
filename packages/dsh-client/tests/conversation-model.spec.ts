import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RemoteDirectoryEntry, RemoteSessionView, RemoteTranscriptEntry } from '@threadharbor/protocol'
import { RemoteSessionId, RemoteTranscriptId } from '@threadharbor/protocol'
import {
  browsableDirectories, buildTranscriptNodes, choiceCancelOutcome, choiceSubmitOutcome,
  conversationPresentation, conversationStage, conversationStatsGroups, deriveConversationStats,
  formatCacheHitPercent, formatCompactDuration, formatTokenCount,
  isAutoApprovablePermission, isNearScrollBottom, mergeTranscriptEntries, parseChoicePrompt, parsePlanItems,
  autoApproveOptionId, configuredModeAutoApproves, pendingPermissionEntry, permissionRequestId, preferredProjectBackend,
  shouldAutoApprovePermissions, shouldPinPendingPermission, toolDisclosurePresentation,
  toolGlyphKind,
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

  it('finds the pending card by request id even when later rows buried it', () => {
    const asked = { ...entry('200', 'permission', 'permission', '任务 2 的分支从哪里创建？'), requestId: '1' }
    const later = entry('201', 'tool', 'tool-call', 'grep foo')
    const older = { ...entry('199', 'permission', 'permission', '旧问题'), requestId: '0' }
    expect(pendingPermissionEntry([older, asked, later], ['1'])?.transcriptId).toBe('200')
    // Ids provided but nothing local matches yet → no card, not a stale one.
    expect(pendingPermissionEntry([older, later], ['1'])).toBeUndefined()
    // Older gateway without ids keeps the "last permission row" behaviour.
    expect(pendingPermissionEntry([older, asked, later])?.transcriptId).toBe('200')
  })

  it('never auto-answers a Claude tool prompt with Deny, even though Deny is listed first', () => {
    const prompt = parseChoicePrompt({
      ...entry('109', 'permission', 'permission', '等待权限确认'),
      requestId: '0',
      nativeFrame: {
        jsonrpc: '2.0', id: 0, method: 'session/request_permission',
        params: {
          toolCall: { title: 'git fetch origin dev' },
          options: [
            { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
            { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
            { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
          ],
        },
      },
    })
    expect(prompt?.questions[0]?.options.map(option => option.kind)).toEqual(['reject_once', 'allow_once', 'allow_always'])
    // "跳过确认" offers no bypassPermissions option here → one-off allow, no durable rule.
    expect(autoApproveOptionId(prompt, { permissionMode: 'bypass' })).toBe('allow')
    expect(autoApproveOptionId(prompt, { approvalChoice: 'auto' })).toBe('allow')
    expect(autoApproveOptionId(prompt)).toBe('allow')
    const denyOnly = parseChoicePrompt({
      ...entry('110', 'permission', 'permission', '等待权限确认'),
      nativeFrame: { jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: {
        options: [{ kind: 'reject_once', name: 'Deny', optionId: 'reject' }],
      } },
    })
    expect(autoApproveOptionId(denyOnly, { permissionMode: 'bypass' })).toBeUndefined()
    // Older adapters omit `kind`; fall back to the id / label.
    const unkinded = parseChoicePrompt({
      ...entry('111', 'permission', 'permission', '等待权限确认'),
      nativeFrame: { jsonrpc: '2.0', id: 2, method: 'session/request_permission', params: {
        options: [{ name: 'Deny', optionId: 'deny' }, { name: 'Yes', optionId: 'yes' }],
      } },
    })
    expect(autoApproveOptionId(unkinded, { permissionMode: 'bypass' })).toBe('yes')
    expect(configuredModeAutoApproves([{ id: 'mode', category: 'mode', currentValue: 'bypassPermissions' }])).toBe(true)
    expect(configuredModeAutoApproves([{ id: 'mode', category: 'mode', currentValue: 'default' }])).toBe(false)
    expect(configuredModeAutoApproves(undefined)).toBe(false)
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

  it('surfaces the current session-start stage message on the connecting banner', () => {
    const view = conversationPresentation({
      session: session({ channelState: 'connecting', turnState: 'idle' }),
      entries: [],
      now: 10_000,
      progress: {
        sessionId: 'session', phase: 'sending', startedAt: 1_000, baselineSeq: -1,
        message: '正在初始化 Agent 连接',
      },
    })
    expect(view.channel.label).toBe('正在连接 Agent')
    expect(view.channel.detail).toContain('正在初始化 Agent 连接')
    expect(view.channel.state).toBe('ongoing')
    expect(view.turn.visible).toBe(false)
  })

  it('shows the reconnect banner instead of an eternal create banner while the socket is down', () => {
    const view = conversationPresentation({
      session: session({ channelState: 'connecting', turnState: 'idle' }),
      entries: [],
      now: 10_000,
      transportPhase: 'reconnecting',
      progress: {
        sessionId: 'session', phase: 'sending', startedAt: 1_000, baselineSeq: -1,
        message: '通道已断开，正在等待重连后自动重发。',
      },
    })
    expect(view.channel).toMatchObject({
      kind: 'transport',
      label: '实时通道断开，正在自动重连',
      state: 'warning',
      visible: true,
    })
    expect(view.channel.detail).toContain('自动重发')
    expect(view.turn.visible).toBe(false)
    expect(view.headerLabel).toBe('实时通道断开，正在自动重连')
  })

  it('surfaces a failed prompt instead of the connecting banner', () => {
    const view = conversationPresentation({
      session: session({ channelState: 'connecting', turnState: 'idle' }),
      entries: [],
      now: 10_000,
      progress: {
        sessionId: 'session', phase: 'failed', startedAt: 1_000, baselineSeq: -1,
        message: 'request timed out',
      },
    })
    expect(view.channel.kind).not.toBe('connecting')
    expect(view.turn).toMatchObject({ kind: 'timeout', label: '请求超时', state: 'error', visible: true })
    expect(view.headerLabel).toContain('请求超时')
  })

  it('keeps running and completed tool calls collapsed to one status row by default', () => {
    expect(toolDisclosurePresentation(false, true)).toEqual({ initialOpen: false, status: '运行中' })
    expect(toolDisclosurePresentation(true, false)).toEqual({ initialOpen: false, status: '已完成' })
    expect(toolDisclosurePresentation(false, false)).toEqual({ initialOpen: false, status: '无结果' })
  })

  it('maps tool row titles onto the DSH session icon families', () => {
    expect(toolGlyphKind('Read package.json')).toBe('read')
    expect(toolGlyphKind('read_file src/main.ts')).toBe('read')
    expect(toolGlyphKind('list_directory /tmp')).toBe('read')
    expect(toolGlyphKind('Edit src/app.ts')).toBe('edit')
    expect(toolGlyphKind('write_file notes.txt')).toBe('edit')
    expect(toolGlyphKind('Apply patch')).toBe('edit')
    expect(toolGlyphKind('Bash npm test')).toBe('code')
    expect(toolGlyphKind('run_shell_command ls')).toBe('code')
    expect(toolGlyphKind('web_search DeepSeek')).toBe('web')
    expect(toolGlyphKind('web_fetch https://example.com')).toBe('web')
    expect(toolGlyphKind('grep TODO')).toBe('search')
    expect(toolGlyphKind('google_web_search')).toBe('web')
    expect(toolGlyphKind('TodoWrite')).toBe('plan')
    expect(toolGlyphKind('Task 启动子代理')).toBe('agent')
    expect(toolGlyphKind('skill 回复润色')).toBe('skill')
    expect(toolGlyphKind('save_memory 用户偏好')).toBe('data')
    expect(toolGlyphKind('连续工具调用 · 3 次')).toBe('code')
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
    expect(conversationStage({ ...base, now: 20_000, progress: { ...base.progress, phase: 'waiting' } }))
      .toMatchObject({ kind: 'waiting', label: '等待 Agent 响应' })
    // A slow first frame reads as model work (large-context prefill or
    // extended thinking), not as a failure: ongoing state, no reopen offer.
    expect(conversationStage({ ...base, now: 32_000, progress: { ...base.progress, phase: 'waiting' } }))
      .toMatchObject({ kind: 'thinking', label: '模型正在读取长上下文 / 思考中', state: 'ongoing' })
    expect(conversationStage({
      session: remoteSession,
      entries: [
        entry('1', 'assistant', 'message', '上一轮回复'),
        entry('2', 'user', 'message', '新问题'),
      ],
      now: Date.parse('2026-08-29T00:02:30.000Z'),
    })).toMatchObject({
      kind: 'thinking', label: '模型正在读取长上下文 / 思考中', state: 'ongoing',
      detail: expect.stringContaining('已等待 150 秒'),
    })
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
      session: session({ channelState: 'open', turnState: 'failed' }), entries: [], now: 0,
    }).actions).toMatchObject({ canReconnect: true, canSend: true, canCompose: true })
    expect(conversationPresentation({
      session: session({ channelState: 'open', turnState: 'idle' }),
      progress: { sessionId: 'session', phase: 'failed', startedAt: 0, baselineSeq: -1, message: 'connect ENOENT /tmp/h.sock' },
      entries: [], now: 0,
    }).actions).toMatchObject({ canReconnect: true, canSend: true })
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

  it('counts rounds and coalesced assistant steps from the projected transcript', () => {
    const entries = [
      entry('1', 'user', 'message', '修复测试失败'),
      entry('2', 'assistant', 'message', '我来查看'),
      entry('3', 'assistant', 'message', '失败原因如下'), // same run as seq 2 (split journal pages)
      entry('4', 'tool', 'tool-call', 'bash'),
      entry('5', 'tool', 'tool-result', 'bash 完成'),
      entry('6', 'assistant', 'reasoning', '先分析'),
      entry('7', 'assistant', 'message', '问题在于超时'), // reasoning + message, still one run
      entry('8', 'tool', 'tool-call', 'web_search'),
      entry('9', 'tool', 'tool-result', 'web_search 完成'),
      entry('10', 'assistant', 'message', '已修复'),
      entry('11', 'user', 'message', '再跑一次'),
      entry('12', 'assistant', 'message', '测试通过'),
    ]
    // Deliberately shuffled: derivation sorts by seq before counting.
    const shuffled = [...entries].reverse()
    expect(deriveConversationStats(shuffled)).toMatchObject({ turns: 2, steps: 4, toolCalls: 2 })
    expect(deriveConversationStats(entries)).toEqual({ turns: 2, steps: 4, toolCalls: 2, toolMs: 0 })
  })

  it('sums wall time only for matched tool call→result pairs with ordered timestamps', () => {
    const at = (seq: number, role: RemoteTranscriptEntry['role'], kind: RemoteTranscriptEntry['kind'],
      text: string, offsetMs: number): RemoteTranscriptEntry => ({
        ...entry(String(seq), role, kind, text),
        createdAt: new Date(Date.parse('2026-08-29T00:00:00.000Z') + offsetMs).toISOString(),
      })
    const stats = deriveConversationStats([
      at(1, 'user', 'message', '执行任务', 0),
      at(2, 'assistant', 'message', '开始', 10),
      at(3, 'tool', 'tool-call', 'bash', 1_000),
      at(4, 'tool', 'tool-result', 'bash 完成', 2_300), // +1.3s
      at(5, 'assistant', 'message', '继续', 2_400),
      at(6, 'tool', 'tool-call', 'ls', 3_000),
      at(7, 'tool', 'tool-result', 'ls 完成', 3_000), // same batch timestamp → no duration
      at(8, 'tool', 'tool-call', 'interrupted', 4_000), // never returns → ignored
      at(9, 'assistant', 'message', '收尾', 4_100),
    ])
    expect(stats).toEqual({ turns: 1, steps: 3, toolCalls: 2, toolMs: 1_300 })
  })

  it('renders stats groups the same shape as the DSH StatsLine and drops empty groups', () => {
    expect(conversationStatsGroups({ turns: 2, steps: 4, toolCalls: 2, toolMs: 1_300 }))
      .toEqual(['2 轮 · 4 步', '工具调用 1.3秒'])
    expect(conversationStatsGroups({ turns: 1, steps: 1, toolCalls: 1, toolMs: 0 }).join(' | '))
      .toBe('1 轮 · 1 步')
    // No measurable data → the strip renders nothing at all.
    expect(conversationStatsGroups({ turns: 1, steps: 0, toolCalls: 0, toolMs: 0 })).toEqual([])
    // Window opened mid-round after older history was rotated away.
    expect(conversationStatsGroups({ turns: 0, steps: 3, toolCalls: 1, toolMs: 0 })).toEqual(['3 步'])
  })

  it('formats compact durations with the DSH zh wording', () => {
    expect(formatCompactDuration(700)).toBe('0.7秒')
    expect(formatCompactDuration(15_000)).toBe('15秒')
    expect(formatCompactDuration(123_000)).toBe('2分3秒')
  })

  it('keeps the most recent round usage and renders cache/token groups only when reported', () => {
    const withUsage = (seqText: string, usage: Record<string, number>): RemoteTranscriptEntry => ({
      ...entry(seqText, 'system', 'status', '远程轮次完成'),
      usage,
    })
    const stats = deriveConversationStats([
      entry('1', 'user', 'message', '第一问'),
      entry('2', 'assistant', 'message', '回答一'),
      withUsage('3', { inputTokens: 10_000, outputTokens: 50, cachedReadTokens: 7_000 }),
      entry('4', 'user', 'message', '第二问'),
      entry('5', 'assistant', 'message', '回答二'),
      withUsage('6', { inputTokens: 5_000, outputTokens: 40, cachedReadTokens: 0 }),
    ])
    expect(stats.usage).toEqual({ inputTokens: 5_000, outputTokens: 40, cachedReadTokens: 0 })
    expect(conversationStatsGroups({ turns: 2, steps: 2, toolCalls: 0, toolMs: 0, usage: stats.usage }))
      .toEqual(['2 轮 · 2 步', '输入 5K tok · 输出 40 tok'])
  })

  it('renders cache-hit and token groups in the DSH wording', () => {
    const groups = conversationStatsGroups({
      turns: 1, steps: 1, toolCalls: 0, toolMs: 0,
      usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 900, cachedWriteTokens: 0, totalTokens: 1_005 },
    })
    expect(groups.join(' | ')).toBe('1 轮 · 1 步 | 缓存命中 90% | 输入 1K tok · 输出 5 tok')
    // Just under a full hit keeps decimal precision like the official strip.
    expect(formatCacheHitPercent(9_995, 10_000)).toBe('99.95')
    expect(formatCacheHitPercent(10_000, 10_000)).toBe('100')
    expect(formatCacheHitPercent(0, 10_000)).toBeNull()
    expect(formatTokenCount(107_000)).toBe('107K')
    expect(formatTokenCount(1_700)).toBe('1.7K')
    expect(formatTokenCount(34)).toBe('34')
    expect(formatTokenCount(1_750_000)).toBe('1.8M')
  })
})
