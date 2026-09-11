/** Pure view-model helpers shared by the remote conversation UI and tests. */

import type {
  JsonValue, RemoteAgentBackend, RemoteChannelState, RemoteDirectoryEntry, RemoteSessionView,
  RemoteTranscriptEntry, RemoteTranscriptUsage, RemoteTurnState,
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
    return {
      kind: label === '请求超时' ? 'timeout' : 'failed',
      label,
      detail: progress.message ?? '请求未成功送达远程 Agent。可以点「在当前会话重开」再试。',
      state: 'error',
      visible: true,
    }
  }
  if (progress?.phase === 'sending') {
    return {
      kind: 'sending',
      label: '正在发送消息',
      detail: progress.message ?? '正在把请求提交到远程 Agent。',
      state: 'ongoing',
      visible: true,
    }
  }
  if (session.turnState === 'failed') {
    return {
      kind: 'failed',
      label: '本轮执行失败',
      detail: error ?? '远程 Agent 未能完成本轮请求。可以点「在当前会话重开」，或直接发送新的请求。',
      state: 'error',
      visible: true,
    }
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
    const pending = pendingPermissionEntry(entries)
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
  readonly progressPhase?: PromptProgressView['phase']
  readonly progressMessage?: string
  readonly transportPhase?: 'loading' | 'ready' | 'reconnecting' | 'error'
  readonly error?: string
}): ConversationStage {
  // A dropped transport is the live truth even while the gateway session row
  // still claims `connecting`: without this, a send interrupted by a socket
  // loss would sit on the eternal “正在创建远程会话” banner instead of telling
  // the user the channel is reconnecting. A failed prompt outranks it so the
  // user always sees why the message did not go through.
  if (input.transportPhase === 'reconnecting' && input.progressPhase !== 'failed') {
    return {
      kind: 'transport',
      label: '实时通道断开，正在自动重连',
      detail: input.progressMessage ?? '浏览器到网关的连接已断开，正在后台重试。无需操作。',
      state: 'warning', visible: true,
    }
  }
  if ((input.channelState === 'connecting' || input.creating) && input.progressPhase !== 'failed') {
    return {
      kind: 'connecting',
      label: input.creating ? '正在连接 Agent' : '正在接入实时通道',
      detail: input.creating
        ? (input.progressMessage ?? '正在创建远程会话并建立通信通道。')
        : '会话已打开，正在接入 WebSocket 推送。',
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
  readonly progress?: PromptProgressView
}): SessionActionGates {
  const transportDown = input.transportPhase === 'reconnecting' || input.transportPhase === 'loading'
  const live = input.channelState === 'open' && !transportDown
  const turnBusy = input.turnState === 'running' || input.turnState === 'waiting-permission'
  const canCompose = !input.child && live
  const sendFailed = input.progress?.phase === 'failed'
  return {
    canCompose,
    canSend: canCompose && !input.pending && !turnBusy,
    canStop: !input.child && turnBusy,
    canReconnect: !input.child && (
      input.channelState === 'reconnecting'
      || input.channelState === 'lost'
      || input.turnState === 'failed'
      || sendFailed
    ),
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
  const progress = input.progress !== undefined
    && (input.progress.sessionId === undefined || input.progress.sessionId === input.session.sessionId)
    ? input.progress
    : undefined
  const creating = progress !== undefined
    && (progress.phase === 'connecting'
      || (progress.phase === 'sending' && input.session.channelState === 'connecting'))
  const channel = channelStage({
    channelState: input.session.channelState,
    creating,
    ...(progress?.phase === undefined ? {} : { progressPhase: progress.phase }),
    ...(progress?.message === undefined ? {} : { progressMessage: progress.message }),
    ...(input.transportPhase === undefined ? {} : { transportPhase: input.transportPhase }),
    ...(input.error === undefined ? {} : { error: input.error }),
  })
  const turn = turnStage(input)
  const hideTurn = channel.visible && (channel.kind === 'connecting' || channel.kind === 'transport')
    && (turn.kind === 'sending' || turn.kind === 'waiting' || turn.kind === 'idle')
  const visibleTurn = hideTurn ? { ...turn, visible: false } : turn
  const actions = sessionActionGates({
    channelState: input.session.channelState,
    turnState: input.session.turnState,
    ...(input.transportPhase === undefined ? {} : { transportPhase: input.transportPhase }),
    pending: input.pending === true,
    child: input.session.parentSessionId !== undefined,
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  })
  const headerParts = [
    ...(channel.visible ? [channel.label] : []),
    ...(visibleTurn.visible ? [visibleTurn.label] : []),
  ]
  return {
    turn: visibleTurn, channel, actions,
    headerLabel: headerParts.length === 0 ? '已就绪' : headerParts.join(' · '),
    headerState: rankState(channel.state) >= rankState(visibleTurn.state) ? channel.state : visibleTurn.state,
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

/** Whether the composer should answer permission grants without a click.
 *  Claude's "跳过确认" is `permissionMode=bypass`; Codex "完全访问" is `full-access`.
 *  Those are distinct from AskUserQuestion, which still requires a click. */
export function shouldAutoApprovePermissions(
  approvalChoice: string | undefined,
  permissionMode?: string,
): boolean {
  return approvalChoice === 'auto'
    || permissionMode === 'bypass'
    || permissionMode === 'full-access'
}

/** Whether a permission option denies the request. Claude ACP lists `Deny`
 *  first (`reject_once`), so "first option" is never a safe default. */
function isRejectOption(option: ChoiceOption): boolean {
  if (option.kind !== undefined) return option.kind.startsWith('reject')
  return /^(reject|deny|cancel|no)\b/i.test(option.id) || /^(deny|reject|no\b)/i.test(option.label)
}

/** Pick the option an auto-approval should answer with: the mode the user
 *  chose (bypass / auto) when the prompt offers it, else a one-off allow
 *  (`allow_once`, no durable policy change), else a durable allow, else any
 *  non-denying option. Never a deny — returns `undefined` when denying is the
 *  only choice so the card stays for the user. */
export function autoApproveOptionId(
  prompt: ChoicePrompt | undefined,
  preferences: { readonly approvalChoice?: string; readonly permissionMode?: string } = {},
): string | undefined {
  const options = prompt?.questions[0]?.options ?? []
  if (options.length === 0) return undefined
  const preferred = preferences.permissionMode === 'bypass' || preferences.permissionMode === 'full-access'
    ? ['bypassPermissions']
    : preferences.approvalChoice === 'auto'
      ? ['auto', 'bypassPermissions']
      : []
  for (const id of preferred) {
    const match = options.find(option => option.id === id)
    if (match !== undefined) return match.id
  }
  const allowed = options.filter(option => !isRejectOption(option))
  return allowed.find(option => option.kind === 'allow_once')?.id
    ?? allowed.find(option => option.kind === 'allow_always')?.id
    ?? allowed[0]?.id
}

/** Session modes the backend itself runs without permission prompts. When
 *  the agent is in one of these, any prompt that still arrives (e.g. a plan
 *  exit) can be answered on the user's behalf. */
const AUTO_APPROVE_MODE_IDS: ReadonlySet<string> = new Set(['bypassPermissions', 'agent-full-access', 'full-access'])

/** Whether the backend-advertised permission mode already means "skip confirmations". */
export function configuredModeAutoApproves(
  configOptions: readonly { readonly id: string; readonly category?: string; readonly currentValue: string }[] | undefined,
): boolean {
  const mode = configOptions?.find(option => option.category === 'mode' || option.id === 'mode')
  return mode !== undefined && AUTO_APPROVE_MODE_IDS.has(mode.currentValue)
}

/** Latest permission row, used both for the waiting banner and the pinned card. */
export function pendingPermissionEntry(
  entries: readonly RemoteTranscriptEntry[],
): RemoteTranscriptEntry | undefined {
  return entries.findLast(entry => entry.role === 'permission')
}

/** Re-show the pending card at the tail when later output has scrolled it out of view. */
export function shouldPinPendingPermission(
  turnState: RemoteTurnState,
  pending: RemoteTranscriptEntry | undefined,
  lastNodeId: string | undefined,
): boolean {
  if (turnState !== 'waiting-permission' || pending === undefined) return false
  return lastNodeId !== pending.transcriptId
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
  /** ACP permission option kind (`allow_once`, `allow_always`, `reject_once`, `reject_always`). */
  readonly kind?: string
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
    const kind = recordText(option?.['kind'])
    return [{
      id, label,
      ...(description === undefined ? {} : { description }),
      ...(kind === undefined ? {} : { kind }),
    } satisfies ChoiceOption]
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

/**
 * Counts and durations the session stats strip can honestly derive from the
 * projected transcript alone. Every group whose data is not trustworthy is
 * left out of the rendered line (mirroring the DSH StatsLine no-data-drop
 * rule). Token/cache figures appear only when the gateway captured them from
 * the backend's native frames (gateway `run-usage.ts`) onto the round's
 * terminal status row; without a capture the groups stay absent.
 */
export interface ConversationStats {
  /** Submitted user rounds ("轮"): user transcript rows in the loaded window. */
  readonly turns: number
  /** Assistant activity segments ("步"): each uninterrupted run of assistant
   *  entries counts one step. Adjacent same-kind deltas are coalesced first
   *  (the same merge the transcript rows use), so one LLM iteration split
   *  across journal pages or reasoning/message kinds still counts once. */
  readonly steps: number
  /** Tool call→result pairs that both settled inside the loaded window. */
  readonly toolCalls: number
  /** Summed wall time between a tool call and its matching result; only pairs
   *  whose timestamps are ordered contribute. 0 when every pair shares a
   *  batch timestamp (e.g. a catch-up replay after a disconnect). */
  readonly toolMs: number
  /** Token usage of the most recent round whose terminal status row carried
   *  it; `undefined` when the backend reported nothing (UI drops those
   *  groups). */
  readonly usage?: RemoteTranscriptUsage
}

function entryTimestamp(entry: RemoteTranscriptEntry): number {
  const time = Date.parse(entry.createdAt)
  return Number.isFinite(time) ? time : Number.NaN
}

/**
 * Fold the session's projected transcript into display counts.
 * Rounds and steps ride the same coalescing the transcript rows use, so the
 * numbers match what is on screen; tool duration is summed over matched
 * call→result pairs in seq order. A call whose result never arrives (an
 * interrupted tool, or history that was rotated away) contributes neither a
 * call count nor a duration.
 */
export function deriveConversationStats(
  entries: readonly RemoteTranscriptEntry[],
): ConversationStats {
  const ordered = [...entries].sort((left, right) => left.seq - right.seq)
  const merged = mergeTranscriptEntries(ordered)
  let turns = 0
  let steps = 0
  let inAssistant = false
  for (const entry of merged) {
    if (entry.role === 'user') turns += 1
    if (entry.role === 'assistant') {
      if (!inAssistant) {
        inAssistant = true
        steps += 1
      }
    } else if (inAssistant) {
      inAssistant = false
    }
  }
  let toolCalls = 0
  let toolMs = 0
  let openCall: RemoteTranscriptEntry | undefined
  for (const entry of ordered) {
    if (entry.kind === 'tool-call') {
      openCall = entry
      continue
    }
    if (entry.kind !== 'tool-result' || openCall === undefined) continue
    toolCalls += 1
    const started = entryTimestamp(openCall)
    const finished = entryTimestamp(entry)
    if (Number.isFinite(started) && Number.isFinite(finished) && finished > started) {
      toolMs += finished - started
    }
    openCall = undefined
  }
  // Usage rides the round's terminal status row; when the loaded window
  // covers several rounds, the strip shows the most recent one's numbers.
  let usage: RemoteTranscriptUsage | undefined
  for (const entry of ordered) {
    if (entry.usage !== undefined && Object.keys(entry.usage).length > 0) usage = entry.usage
  }
  return { turns, steps, toolCalls, toolMs, ...(usage === undefined ? {} : { usage }) }
}

/**
 * Compact token count in the DSH stats wording: `1.2K`, `107K`, `1.7M` —
 * thousands/millions with at most one decimal, exact small counts verbatim.
 * @param count - non-negative token count.
 * @returns display string without the `tok` suffix.
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  const compact = (scaled: number): string => String(Math.round(scaled * 10) / 10)
  if (count >= 1_000_000) return `${compact(count / 1_000_000)}M`
  if (count >= 1_000) return `${compact(count / 1_000)}K`
  return String(count)
}

/** Cache-hit share of the billed prompt-side tokens, mirroring the DSH stats
 *  strip: integer percent, `99.95`-style precision only when a plain integer
 *  would round up to 100 while the true share is below it. */
export function formatCacheHitPercent(readTokens: number, billedInputTokens: number): string | null {
  if (!(readTokens > 0 && billedInputTokens > 0)) return null
  const share = (readTokens / billedInputTokens) * 100
  if (share >= 100) return '100'
  const integer = Math.round(share)
  if (integer < 100) return String(integer)
  const fixed = share.toFixed(2)
  return fixed.replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Compact duration in the DSH stats wording: `45.2秒` under a minute,
 * `2分3秒` from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatCompactDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}秒`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}分${whole % 60}秒`
}

/**
 * Assemble the pipe-separated display groups for the composer stats strip.
 * Follows the DSH StatsLine layout: one counts group, then one durations
 * group when a duration was measured, then cache-hit / token groups when the
 * latest round reported usage; groups with no data drop out whole. When the
 * loaded window opens mid-round (older history rotated away) the counts group
 * falls back to the step count alone rather than "0 轮".
 */
export function conversationStatsGroups(stats: ConversationStats): readonly string[] {
  const groups: string[] = []
  if (stats.steps > 0) {
    groups.push(stats.turns > 0 ? `${stats.turns} 轮 · ${stats.steps} 步` : `${stats.steps} 步`)
    if (stats.toolMs > 0) groups.push(`工具调用 ${formatCompactDuration(stats.toolMs)}`)
    const usage = stats.usage
    if (usage !== undefined) {
      const uncached = usage.inputTokens ?? 0
      const cachedRead = usage.cachedReadTokens ?? 0
      const cachedWrite = usage.cachedWriteTokens ?? 0
      const billedInput = uncached + cachedRead + cachedWrite
      const output = usage.outputTokens ?? 0
      if (billedInput > 0 || output > 0) {
        const cacheHit = formatCacheHitPercent(cachedRead, billedInput)
        if (cacheHit !== null) groups.push(`缓存命中 ${cacheHit}%`)
        groups.push(`输入 ${formatTokenCount(billedInput)} tok · 输出 ${formatTokenCount(output)} tok`)
      }
    }
  }
  return groups
}

/** Directory-picker rows omit dot-directories; a typed path is still accepted by fs.list. */
export function browsableDirectories(
  entries: readonly RemoteDirectoryEntry[],
): readonly RemoteDirectoryEntry[] {
  return entries.filter(entry => entry.kind === 'directory' && !entry.name.startsWith('.'))
}
