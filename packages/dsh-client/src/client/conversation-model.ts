/** Pure view-model helpers shared by the remote conversation UI and tests. */

import type {
  JsonValue, RemoteAgentBackend, RemoteChannelState, RemoteDirectoryEntry, RemoteSessionView,
  RemoteTranscriptEntry, RemoteTurnState,
} from '@threadharbor/protocol'

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
  readonly kind: 'idle' | 'connecting' | 'sending' | 'waiting' | 'thinking' | 'tool' | 'responding' | 'permission' | 'reconnecting' | 'timeout' | 'stopped' | 'failed' | 'transport'
  readonly label: string
  readonly detail: string
  readonly state: 'done' | 'ongoing' | 'warning' | 'error'
  readonly visible: boolean
}

/** Composer and banner gates derived from channel × turn × transport. */
export interface SessionActionGates {
  readonly canCompose: boolean
  readonly canSend: boolean
  readonly canStop: boolean
  readonly canReconnect: boolean
  readonly canResend: boolean
  readonly canChangePreferences: boolean
}

/** Channel banner and turn banner are independent; the header joins both labels. */
export interface ConversationPresentation {
  readonly turn: ConversationStage
  readonly channel: ConversationStage
  readonly actions: SessionActionGates
  readonly headerLabel: string
  readonly headerState: ConversationStage['state']
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

const IDLE_TURN: ConversationStage = {
  kind: 'idle', label: '已就绪', detail: '可以发送新的请求。', state: 'done', visible: false,
}
const OPEN_CHANNEL: ConversationStage = {
  kind: 'idle', label: '通道已连接', detail: '', state: 'done', visible: false,
}

function rankState(state: ConversationStage['state']): number {
  if (state === 'error') return 3
  if (state === 'warning') return 2
  if (state === 'ongoing') return 1
  return 0
}

function turnStage(input: {
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
      state: 'done', visible: true,
    }
  }
  if (session.turnState === 'waiting-permission') {
    const pending = entries.findLast(entry => entry.role === 'permission')
    const asking = pending !== undefined && parseChoicePrompt(pending)?.kind === 'question'
    return {
      kind: 'permission',
      label: asking ? '等待你的选择' : '等待你的确认',
      detail: asking ? '远程 Agent 在等你选择方案。点选项继续，或停止本轮。' : '远程 Agent 需要权限后才能继续。点选项或停止本轮。',
      state: 'warning', visible: true,
    }
  }
  if (session.turnState === 'running' || progress?.phase === 'waiting') {
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
      return { kind: 'permission', label: '等待你的确认', detail: '远程 Agent 需要权限后才能继续。点选项或停止本轮。', state: 'warning', visible: true }
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
  if (error !== undefined && session.channelState === 'open') {
    return { kind: 'failed', label: '状态同步失败', detail: error, state: 'warning', visible: true }
  }
  return IDLE_TURN
}

function channelStage(input: {
  readonly channelState: RemoteChannelState
  readonly creating: boolean
  readonly transportPhase?: 'loading' | 'ready' | 'reconnecting' | 'error'
  readonly error?: string
}): ConversationStage {
  if (input.transportPhase === 'reconnecting' && input.channelState !== 'connecting') {
    return {
      kind: 'transport',
      label: '实时通道断开，正在自动重连',
      detail: '浏览器到网关的连接已断开，正在后台重试。无需操作。',
      state: 'warning', visible: true,
    }
  }
  if (input.transportPhase === 'error') {
    return {
      kind: 'transport',
      label: '实时通道失败',
      detail: input.error ?? '浏览器无法连上网关。稍后会自动重试。',
      state: 'error', visible: true,
    }
  }
  if (input.channelState === 'connecting' || input.creating) {
    return {
      kind: 'connecting',
      label: input.creating ? '正在连接 Agent' : '正在接入实时通道',
      detail: input.creating ? '正在创建远程会话并建立通信通道。' : '会话已打开，正在接入 WebSocket 推送。',
      state: 'ongoing', visible: true,
    }
  }
  if (input.channelState === 'reconnecting') {
    return {
      kind: 'reconnecting',
      label: '会话通道中断',
      detail: input.error ?? '远端会话进程暂时不可用。点重新连接，系统会尝试在当前会话上恢复。',
      state: 'warning', visible: true,
    }
  }
  if (input.channelState === 'lost') {
    return {
      kind: 'failed',
      label: '连接已丢失',
      detail: input.error ?? '远程会话进程已停止。可以点「在当前会话重开」，对话记录会保留。',
      state: 'error', visible: true,
    }
  }
  if (input.channelState === 'closed') {
    return {
      kind: 'failed',
      label: '会话已关闭',
      detail: input.error ?? '无法继续读取远程 Agent 状态。',
      state: 'error', visible: true,
    }
  }
  return OPEN_CHANNEL
}

function sessionActionGates(input: {
  readonly channelState: RemoteChannelState
  readonly turnState: RemoteTurnState
  readonly transportPhase?: 'loading' | 'ready' | 'reconnecting' | 'error'
  readonly pending: boolean
  readonly child: boolean
}): SessionActionGates {
  const live = input.channelState === 'open' && (input.transportPhase === 'ready' || input.transportPhase === undefined)
  const turnBusy = input.turnState === 'running' || input.turnState === 'waiting-permission'
  const canCompose = !input.child && live
  return {
    canCompose,
    canSend: canCompose && !input.pending && !turnBusy,
    canStop: !input.child && turnBusy,
    canReconnect: input.channelState === 'reconnecting' || input.channelState === 'lost',
    canResend: canCompose && !input.pending && !turnBusy,
    canChangePreferences: !input.child && live && !input.pending,
  }
}

/** Channel and turn banners plus composer gates. Turn is never hidden by a reconnecting channel. */
export function conversationPresentation(input: {
  readonly session: RemoteSessionView
  readonly entries: readonly RemoteTranscriptEntry[]
  readonly progress?: PromptProgressView
  readonly error?: string
  readonly now: number
  readonly transportPhase?: 'loading' | 'ready' | 'reconnecting' | 'error'
  readonly pending?: boolean
}): ConversationPresentation {
  const creating = input.progress?.sessionId === input.session.sessionId && input.progress.phase === 'connecting'
  const channel = channelStage({
    channelState: input.session.channelState,
    creating,
    ...(input.transportPhase === undefined ? {} : { transportPhase: input.transportPhase }),
    ...(input.error === undefined ? {} : { error: input.error }),
  })
  const turn = turnStage(input)
  const actions = sessionActionGates({
    channelState: input.session.channelState,
    turnState: input.session.turnState,
    ...(input.transportPhase === undefined ? {} : { transportPhase: input.transportPhase }),
    pending: input.pending === true,
    child: input.session.parentSessionId !== undefined,
  })
  const headerParts = [
    ...(channel.visible ? [channel.label] : []),
    ...(turn.visible ? [turn.label] : []),
  ]
  return {
    turn, channel, actions,
    headerLabel: headerParts.length === 0 ? '已就绪' : headerParts.join(' · '),
    headerState: rankState(channel.state) >= rankState(turn.state) ? channel.state : turn.state,
  }
}

/** Turn-only stage for tests and compact callers. Channel banners live on conversationPresentation. */
export function conversationStage(input: {
  readonly session: RemoteSessionView
  readonly entries: readonly RemoteTranscriptEntry[]
  readonly progress?: PromptProgressView
  readonly error?: string
  readonly now: number
}): ConversationStage {
  return conversationPresentation(input).turn
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
    if (parsePlanItems(entry) !== undefined && previous !== undefined && parsePlanItems(previous) !== undefined) {
      merged[merged.length - 1] = entry
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

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function recordText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export interface ChoiceOption {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface ChoiceQuestion {
  readonly id: string
  readonly prompt: string
  readonly multiSelect: boolean
  readonly options: readonly ChoiceOption[]
}

export interface ChoicePrompt {
  readonly kind: 'permission' | 'question'
  readonly title: string
  readonly detail?: string
  readonly questions: readonly ChoiceQuestion[]
}

export interface PlanItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly priority?: 'high' | 'medium' | 'low'
}

export function nativeFrameMethod(entry: RemoteTranscriptEntry): string {
  const frame = recordObject(entry.nativeFrame)
  return typeof frame?.['method'] === 'string' ? frame['method'] : ''
}

/** Permission grants can follow the session auto-approve setting; AskUserQuestion cannot. */
export function isAutoApprovablePermission(entry: RemoteTranscriptEntry): boolean {
  if (entry.role !== 'permission') return false
  const method = nativeFrameMethod(entry)
  return method === '' || method === 'session/request_permission' || method === 'session/requestPermission'
}

export function parseChoicePrompt(entry: RemoteTranscriptEntry): ChoicePrompt | undefined {
  const frame = recordObject(entry.nativeFrame)
  const params = recordObject(frame?.['params'])
  const method = nativeFrameMethod(entry)
  if (method === 'elicitation/create') return parseElicitationPrompt(params, entry.text)
  if (entry.role === 'permission' || method === 'session/request_permission' || method === 'session/requestPermission') {
    return parsePermissionPrompt(params, entry.text)
  }
  return undefined
}

export function parsePlanItems(entry: RemoteTranscriptEntry): readonly PlanItem[] | undefined {
  const frame = recordObject(entry.nativeFrame)
  const params = recordObject(frame?.['params'])
  const update = recordObject(params?.['update'])
  const kind = typeof update?.['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (update === undefined || (kind !== 'plan' && kind !== 'plan_update')) return undefined
  const nested = recordObject(update['plan'])
  const rows = Array.isArray(update['entries']) ? update['entries']
    : Array.isArray(nested?.['entries']) ? nested['entries']
      : Array.isArray(nested?.['items']) ? nested['items']
        : []
  const items = rows.flatMap((row) => {
    const record = recordObject(row)
    const content = recordText(record?.['content'])
    if (content === undefined) return []
    const status = record?.['status']
    const priority = record?.['priority']
    return [{
      content,
      status: status === 'completed' || status === 'in_progress' ? status : 'pending',
      ...(priority === 'high' || priority === 'medium' || priority === 'low' ? { priority } : {}),
    } satisfies PlanItem]
  })
  return items.length === 0 ? undefined : items
}

export function choiceSubmitOutcome(prompt: ChoicePrompt, answers: Record<string, string | readonly string[]>): JsonValue {
  if (prompt.kind === 'permission') {
    const selected = answers[prompt.questions[0]?.id ?? 'optionId']
    const optionId = Array.isArray(selected) ? selected[0] : selected
    return { outcome: 'selected', optionId: optionId ?? '' }
  }
  const content: Record<string, JsonValue> = {}
  for (const question of prompt.questions) {
    const selected = answers[question.id]
    if (selected === undefined) continue
    content[question.id] = question.multiSelect
      ? [...(Array.isArray(selected) ? selected : [selected])]
      : Array.isArray(selected) ? selected[0] ?? '' : selected
  }
  return { action: 'accept', content }
}

export function choiceCancelOutcome(prompt: ChoicePrompt): JsonValue {
  return prompt.kind === 'question' ? { action: 'cancel' } : { outcome: 'cancelled' }
}

function parsePermissionPrompt(params: Record<string, unknown> | undefined, fallback: string): ChoicePrompt {
  const meta = recordObject(recordObject(params?.['_meta'])?.['permission'])
  const toolCall = recordObject(params?.['toolCall'])
  const title = recordText(params?.['title']) ?? recordText(meta?.['title']) ?? recordText(toolCall?.['title']) ?? fallback
  const detail = recordText(params?.['description']) ?? recordText(meta?.['description'])
  const options = (Array.isArray(params?.['options']) ? params['options'] : []).flatMap((candidate) => {
    const option = recordObject(candidate)
    const id = recordText(option?.['optionId'])
    if (id === undefined) return []
    const label = recordText(option?.['name']) ?? recordText(option?.['kind']) ?? id
    const description = recordText(recordObject(recordObject(option?.['_meta'])?.['permission'])?.['description'])
    return [{ id, label, ...(description === undefined ? {} : { description }) } satisfies ChoiceOption]
  })
  return {
    kind: 'permission',
    title: title === '' ? '等待权限确认' : title,
    ...(detail === undefined ? {} : { detail }),
    questions: options.length === 0 ? [] : [{ id: 'optionId', prompt: title, multiSelect: false, options }],
  }
}

function parseElicitationPrompt(params: Record<string, unknown> | undefined, fallback: string): ChoicePrompt {
  const title = recordText(params?.['message']) ?? fallback
  const schema = recordObject(params?.['requestedSchema'])
  const properties = recordObject(schema?.['properties']) ?? {}
  const questions = Object.entries(properties).flatMap(([id, raw]) => {
    const property = recordObject(raw)
    if (property === undefined) return []
    const prompt = recordText(property['title']) ?? recordText(property['description']) ?? id
    const multiSelect = property['type'] === 'array'
    const options = property['type'] === 'boolean'
      ? [{ id: 'true', label: '是' }, { id: 'false', label: '否' }]
      : enumOptions(property)
    if (options.length === 0) return []
    return [{ id, prompt, multiSelect, options } satisfies ChoiceQuestion]
  })
  return {
    kind: 'question',
    title: title === '' ? '需要你的选择' : title,
    questions,
  }
}

function enumOptions(schema: Record<string, unknown>): ChoiceOption[] {
  if (Array.isArray(schema['enum'])) {
    return schema['enum'].flatMap((value) => typeof value === 'string' ? [{ id: value, label: value }] : [])
  }
  const items = recordObject(schema['items'])
  const source: unknown[] = Array.isArray(schema['oneOf']) ? schema['oneOf']
    : Array.isArray(schema['anyOf']) ? schema['anyOf']
      : Array.isArray(items?.['enum']) ? items['enum']
        : Array.isArray(items?.['oneOf']) ? items['oneOf']
          : []
  return source.flatMap((candidate) => {
    if (typeof candidate === 'string') return [{ id: candidate, label: candidate }]
    const record = recordObject(candidate)
    if (record === undefined) return []
    const id = recordText(record['const']) ?? (Array.isArray(record['enum']) && typeof record['enum'][0] === 'string'
      ? record['enum'][0] : undefined)
    if (id === undefined) return []
    const label = recordText(record['title']) ?? id
    const description = recordText(record['description'])
    return [{ id, label, ...(description === undefined ? {} : { description }) }]
  })
}

/** Directory-picker rows omit dot-directories; a typed path is still accepted by fs.list. */
export function browsableDirectories(
  entries: readonly RemoteDirectoryEntry[],
): readonly RemoteDirectoryEntry[] {
  return entries.filter(entry => entry.kind === 'directory' && !entry.name.startsWith('.'))
}
