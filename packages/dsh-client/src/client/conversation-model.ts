/** Pure view-model helpers shared by the remote conversation UI and tests. */

import type { RemoteAgentBackend, RemoteDirectoryEntry, RemoteSessionView, RemoteTranscriptEntry } from '@threadharbor/protocol'

/** Restore the most recently created session backend for a project, with a stable first-option fallback. */
export function preferredProjectBackend(
  available: readonly RemoteAgentBackend[],
  projectSessions: readonly RemoteSessionView[],
): RemoteAgentBackend | '' {
  const previous = projectSessions.at(-1)?.backend
  return previous !== undefined && available.includes(previous) ? previous : available[0] ?? ''
}

/** Browser-owned prompt admission lifecycle, independent from backend transcript support. */
export interface PromptProgressView {
  readonly sessionId?: string
  readonly phase: 'connecting' | 'sending' | 'waiting' | 'reconnecting' | 'failed'
  readonly startedAt: number
  readonly baselineSeq: number
  readonly message?: string
}

/** One user-visible conversation stage rendered in both the header and transcript tail. */
export interface ConversationStage {
  readonly kind: 'idle' | 'connecting' | 'sending' | 'waiting' | 'thinking' | 'tool' | 'responding' | 'permission' | 'reconnecting' | 'timeout' | 'stopped' | 'failed'
  readonly label: string
  readonly detail: string
  readonly state: 'done' | 'ongoing' | 'warning' | 'error'
  readonly visible: boolean
}

/** Compact disclosure policy for a tool call in the transcript. */
export function toolDisclosurePresentation(hasResult: boolean, active: boolean): {
  readonly initialOpen: false
  readonly status: '已完成' | '运行中' | '无结果'
} {
  return {
    initialOpen: false,
    status: hasResult ? '已完成' : active ? '运行中' : '无结果',
  }
}

const FIRST_RESPONSE_TIMEOUT_MS = 30_000

function failureLabel(message: string | undefined): string {
  if (message !== undefined && /timeout|timed out|超时/i.test(message)) return '请求超时'
  if (message !== undefined && /fetch|network|connect|socket|tunnel|ECONN|连接/i.test(message)) return '连接失败'
  return '发送失败'
}

/** Derive a complete UI stage even when the backend has not emitted any native frame. */
export function conversationStage(input: {
  readonly session: RemoteSessionView
  readonly entries: readonly RemoteTranscriptEntry[]
  readonly progress?: PromptProgressView
  readonly error?: string
  readonly now: number
}): ConversationStage {
  const { session, error, now } = input
  const entries = input.entries.filter(entry => entry.sessionId === session.sessionId)
    .sort((left, right) => left.seq - right.seq)
  const progress = input.progress?.sessionId === session.sessionId ? input.progress : undefined

  if (progress?.phase === 'failed') {
    const label = failureLabel(progress.message)
    return { kind: label === '请求超时' ? 'timeout' : 'failed', label, detail: progress.message ?? '请求未成功送达远程 Agent。', state: 'error', visible: true }
  }
  if (session.channelState === 'connecting' || progress?.phase === 'connecting') {
    const creating = progress?.phase === 'connecting'
    return {
      kind: 'connecting',
      label: creating ? '正在连接 Agent' : '正在接入实时通道',
      detail: creating ? '正在创建远程会话并建立通信通道。' : '会话已打开，正在接入 WebSocket 推送。',
      state: 'ongoing', visible: true,
    }
  }
  if (session.channelState === 'reconnecting' || progress?.phase === 'reconnecting') {
    return { kind: 'reconnecting', label: '连接异常，正在重试', detail: progress?.message ?? error ?? '暂时无法读取远程状态。', state: 'warning', visible: true }
  }
  if (session.channelState === 'lost' || session.channelState === 'closed') {
    return { kind: 'failed', label: session.channelState === 'lost' ? '连接已丢失' : '会话已关闭', detail: error ?? '无法继续读取远程 Agent 状态。', state: 'error', visible: true }
  }
  if (progress?.phase === 'sending') {
    return { kind: 'sending', label: '正在发送消息', detail: '正在把请求提交到远程 Agent。', state: 'ongoing', visible: true }
  }
  if (session.turnState === 'failed') {
    return { kind: 'failed', label: '本轮执行失败', detail: error ?? '远程 Agent 未能完成本轮请求。', state: 'error', visible: true }
  }
  if (session.turnState === 'stopped') {
    return {
      kind: 'stopped',
      label: '用户主动停止',
      detail: '本轮已由你停止，可以继续发送新的请求。',
      state: 'done',
      visible: true,
    }
  }
  if (session.turnState === 'waiting-permission') {
    return { kind: 'permission', label: '等待你的确认', detail: '远程 Agent 需要权限后才能继续。', state: 'warning', visible: true }
  }
  if (session.turnState === 'running') {
    const lastUserSeq = entries.findLast(entry => entry.role === 'user')?.seq ?? -1
    const backendEntries = progress === undefined
      ? entries.filter(entry => entry.seq > lastUserSeq && entry.role !== 'user')
      : entries.filter(entry => entry.seq > progress.baselineSeq && entry.role !== 'user')
    const last = backendEntries.at(-1)
    if (last === undefined) {
      const lastUser = entries.findLast(entry => entry.role === 'user')
      const userStartedAt = lastUser === undefined ? Number.NaN : Date.parse(lastUser.createdAt)
      const startedAt = progress?.startedAt ?? (Number.isFinite(userStartedAt) ? userStartedAt : now)
      const elapsed = Math.max(0, now - startedAt)
      if (elapsed >= FIRST_RESPONSE_TIMEOUT_MS) {
        return {
          kind: 'timeout', label: '等待响应超时',
          detail: `已等待 ${Math.floor(elapsed / 1000)} 秒，Agent 可能仍在后台运行；可以继续等待或停止本轮。`,
          state: 'warning', visible: true,
        }
      }
      return { kind: 'waiting', label: '等待 Agent 响应', detail: '请求已送达，正在等待第一个后台事件。', state: 'ongoing', visible: true }
    }
    if (last.role === 'permission') {
      return { kind: 'permission', label: '等待你的确认', detail: '远程 Agent 需要权限后才能继续。', state: 'warning', visible: true }
    }
    if (last.kind === 'reasoning') {
      return { kind: 'thinking', label: '思考中', detail: 'Agent 正在分析请求。', state: 'ongoing', visible: true }
    }
    if (last.kind === 'tool-call') {
      return { kind: 'tool', label: '工具执行中', detail: last.text.trim() || 'Agent 正在调用远程工具。', state: 'ongoing', visible: true }
    }
    if (last.kind === 'tool-result') {
      return { kind: 'responding', label: '正在处理工具结果', detail: 'Agent 已收到工具结果，正在继续处理。', state: 'ongoing', visible: true }
    }
    return { kind: 'responding', label: '正在生成回复', detail: 'Agent 已开始返回内容。', state: 'ongoing', visible: true }
  }
  if (error !== undefined) {
    return { kind: 'reconnecting', label: '状态同步失败', detail: error, state: 'warning', visible: true }
  }
  return { kind: 'idle', label: '已就绪', detail: '可以发送新的请求。', state: 'done', visible: false }
}

/** Minimum scroll metrics needed to decide whether live output should remain pinned. */
export interface ScrollMetrics {
  readonly scrollHeight: number
  readonly scrollTop: number
  readonly clientHeight: number
}

/** Treat a small gap as still being at the bottom to avoid sub-pixel/layout jitter. */
export function isNearScrollBottom(metrics: ScrollMetrics, threshold = 48): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

/**
 * Combine adjacent streamed assistant deltas into one visual message.
 * User, permission, tool, and status entries remain independent interaction rows.
 */
export function mergeTranscriptEntries(
  entries: readonly RemoteTranscriptEntry[],
): readonly RemoteTranscriptEntry[] {
  const merged: RemoteTranscriptEntry[] = []
  for (const entry of entries) {
    const previous = merged.at(-1)
    if (entry.role === 'assistant'
      && previous?.role === 'assistant'
      && previous.kind === entry.kind) {
      merged[merged.length - 1] = { ...previous, text: previous.text + entry.text }
      continue
    }
    merged.push(entry)
  }
  return merged
}

/** One DSH-style display node: semantic messages stay singular while adjacent tool activity shares one disclosure. */
export type RemoteTranscriptNode =
  | { readonly kind: 'entry'; readonly id: string; readonly entry: RemoteTranscriptEntry }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly title: string
      readonly entries: readonly RemoteTranscriptEntry[]
    }

/**
 * Assemble the flat remote projection into stable visual nodes.
 * The gateway deliberately preserves backend-native frames; this browser layer only
 * correlates consecutive tool rows and streamed assistant deltas for presentation.
 */
export function buildTranscriptNodes(
  entries: readonly RemoteTranscriptEntry[],
): readonly RemoteTranscriptNode[] {
  const merged = mergeTranscriptEntries(entries)
  const nodes: RemoteTranscriptNode[] = []
  for (let index = 0; index < merged.length; index += 1) {
    const entry = merged[index]
    if (entry === undefined) continue
    if (entry.role !== 'tool') {
      nodes.push({ kind: 'entry', id: entry.transcriptId, entry })
      continue
    }
    const toolEntries = [entry]
    while (index + 1 < merged.length && merged[index + 1]?.role === 'tool') {
      const next = merged[index + 1]
      if (next === undefined) break
      toolEntries.push(next)
      index += 1
    }
    const calls = toolEntries.filter(candidate => candidate.kind === 'tool-call')
    const call = calls[0]
    nodes.push({
      kind: 'tool',
      id: entry.transcriptId,
      title: calls.length > 1 ? `连续工具调用 · ${calls.length} 次` : call?.text.trim() || '远程工具',
      entries: toolEntries,
    })
  }
  return nodes
}

/** Whether the composer approval dropdown should answer permission requests without a click. */
export function shouldAutoApprovePermissions(approvalChoice: string | undefined): boolean {
  return approvalChoice === 'auto'
}

/** JSON-RPC id for a permission card, including numeric `0` from Claude ACP. */
export function permissionRequestId(entry: RemoteTranscriptEntry): string | undefined {
  if (entry.requestId !== undefined && entry.requestId !== '') return entry.requestId
  const frame = entry.nativeFrame
  if (frame === undefined || frame === null || typeof frame !== 'object' || Array.isArray(frame)) return undefined
  const id = frame['id']
  if (typeof id === 'string' && id.trim() !== '') return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return undefined
}

/** Directory-picker rows omit dot-directories; a typed path is still accepted by fs.list. */
export function browsableDirectories(
  entries: readonly RemoteDirectoryEntry[],
): readonly RemoteDirectoryEntry[] {
  return entries.filter(entry => entry.kind === 'directory' && !entry.name.startsWith('.'))
}
