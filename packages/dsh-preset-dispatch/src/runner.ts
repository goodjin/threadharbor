/**
 * Driving one session's turns against a real ACP agent.
 *
 * The session is opened once and reused. `session/new` is expensive — codex and
 * grok both load a model catalogue and probe their environment during it — and a
 * DSH session is long-lived, so re-opening per turn would charge every turn a
 * setup the agent already paid.
 */

import type { AcpStepResult, StepDecisionLike, StepEndReason, TurnContext, TurnStreamHandle } from './dispatch.ts'
import { RAW_OUTPUT, UNDELIVERED } from './content-writer.ts'
import { baseIdOf } from './selection.ts'
import { RawOutputAggregator } from '@threadharbor/dsh-acp-agent'
import type { RawOutputBlock } from '@threadharbor/dsh-acp-agent'
import type { UndeliveredAttachment } from './content-writer.ts'
import { AcpSegmenter, projectToolCall, projectToolCallAnnouncement, projectToolCallAnnouncementCall, projectToolCallFrame, projectToolResultFrame, projectSpawnedResult, readSessionStatus, readSpawnedFrame, stillRunningText, systemNoteEvent } from '@threadharbor/dsh-acp-agent'
import { SubagentSessions } from './subagent-sessions.ts'
import type { SubagentSessionHost } from './subagent-sessions.ts'
import type { AcpDialect, AcpFrame, ProjectionEvent, SessionStatusSnapshot, ToolCall } from '@threadharbor/dsh-acp-agent'
import { randomUUID } from 'node:crypto'

/** The JSON-RPC surface this runner needs, kept narrow so it can be stood in for. */
export type AcpClientPort = {
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): void
  /**
   * Register the sink for frames as they arrive.
   *
   * Per frame, not per batch: a delta has to reach the UI while the agent is
   * still working. Replaying collected frames afterwards is exactly the
   * "wait, then it all appears" behaviour streaming exists to remove.
   */
  onFrame(handler: (frame: AcpFrame) => void): void

  /**
   * Called when a terminal produces new output (grok's bash delegation).
   * The runner maps terminalId → toolCallId by command match and synthesizes
   * a tool_call_update frame so the UI shows live output.
   */
  onTerminalOutput?: (handler: (terminalId: string, data: string) => void) => void
  /**
   * Called when a terminal process exits. The runner settles the tool card
   * with the exit code.
   */
  onTerminalExit?: (handler: (terminalId: string, exitCode: number) => void) => void

  /**
   * The agent's `authenticate` round-trip, when it has one.
   *
   * Cursor must authenticate (after an interactive `agent login`) between
   * `initialize` and `session/new`; the other agents have no such step, so the
   * port omits this and the runner skips it. Absent means "no authenticate".
   *
   * Takes the `initialize` reply because an agent's method id may be per-build
   * (qoder CN vs international) and only the agent's own `authMethods` list
   * knows it. Whether the step runs before `session/new` or waits for a
   * refusal is the runner's decision, read from the dialect.
   */
  authenticate?(initializeResult: unknown): Promise<unknown>
}

/** Where a turn's text and reasoning go as they arrive. */
export type TurnStreamPort = {
  textDelta(text: string): void
  reasoningDelta(text: string): void
  /** Seal preceding prose; return the next block index when the stream can expose it. */
  toolBoundary?(): number | void
}

/** How to reach an agent, and where its work happens. */
export type RunnerOptions = {
  readonly cwd: string
  /**
   * The DSH session this runner drives, when the opener knows it.
   *
   * The runner's own `sessionId` is the external conversation's; this one
   * names the host session, which is what host-side services (the question
   * card, notably) resolve an agent by.
   */
  readonly dshSessionId?: string
  /** Applied once, before the first turn; claude needs `default` to ask at all. */
  readonly modeId?: string
  readonly modelId?: string
  /**
   * How long to wait for the agent to open a session before giving up.
   *
   * An agent that accepts a connection and then says nothing — wrong secret,
   * wrong path, an agent that is up but wedged — would otherwise hold the
   * session open forever with nothing on screen and no way to tell that is what
   * is happening. Give up loudly instead.
   */
  readonly openTimeoutMs?: number
  /**
   * The frame dialect of the agent this runner drives, when known.
   *
   * With it, the runner writes each tool's opening card the moment the call's
   * first frame arrives — the card exists in the log while the agent still
   * works, and the turn-end write strips those already written. Without it
   * (or for a frame without a call id, which cannot be tracked to stay
   * single) the turn writes everything at its end, exactly as before.
   */
  readonly dialect?: AcpDialect
  /**
   * 外部子代理的影子子会话（只展示、不执行）。
   *
   * 宿主没组合子代理能力包时端口缺席或 `available:false`，泵内所有子会话
   * 动作归零——写一条宿主不认的目录事件会让会话日志加载不了。
   */
  readonly subagents?: SubagentSessionHost
  /**
   * A conversation handed over from another session, keyed by session.
   *
   * A switch into this preset continues in a new DSH session, and this
   * runner's external conversation starts empty — the takeover sends only the
   * new turn's user text. The handed-over text rides the first model request
   * here, ahead of it, which is the whole of the handover: the agent reads the
   * prior conversation and then the question. Taken on the first attempt and
   * put back if that attempt failed to deliver, so a failed turn never
   * silently continues without the history it was promised.
   */
  readonly primer?: {
    take(sessionId: string): string | undefined
    restore(sessionId: string, text: string): void
  }
  /**
   * This session's earlier conversation, read from the host's own transcript.
   *
   * An external conversation starts empty even when the DSH session's record
   * does not — a host restart forgets the connection but not the log — so the
   * first request of a fresh external conversation carries the transcript
   * ahead of the question, framed as previous conversation. Consulted only on
   * the session's first open, and only when no handover primer exists: the
   * handover is the fresher copy of the same conversation. Never put back —
   * unlike a primer it is read from the host, so a retry can simply take it
   * again — and when the agent then refuses the prompt, the turn ends naming
   * the refusal rather than dying with the agent's bare error.
   */
  readonly replay?: {
    take(sessionId: string): string | undefined
  }
  /**
   * The current turn's stop signal, when the host can stop the turn.
   *
   * Consulted once per turn, before the prompt goes out — the listener has to
   * exist before the user can stop. On abort the runner tells the agent
   * `session/cancel` and discards whatever still arrives; the turn ends
   * aborted no matter what the agent then replies. Absent (or resolving to
   * nothing for this turn) means the turn cannot be stopped, and runs exactly
   * as before.
   */
  readonly abort?: () => AbortSignal | undefined
  /**
   * The model list the agent reported with this session, as the dialect read
   * it off the `session/new` reply.
   *
   * The model picker serves what the agent serves, and only an opened session
   * can answer that — so every open reports, an empty list included: an agent
   * that serves nothing must be able to say so, and swallowing the report
   * would leave a stale answer standing. Absent means nobody listens; the
   * open proceeds exactly as before.
   */
  readonly onModels?: (models: readonly { id: string; name: string; description?: string }[]) => void
  /**
   * The external session id a previous host generation journaled for this DSH
   * session, when one is remembered.
   *
   * A dialect whose capabilities declare `supportsSessionResume` gets one
   * `session/resume` attempt against that id before any `session/new` — the
   * agent-side conversation is then reattached as-is, and the first prompt
   * carries no text replay (the agent still has the history; riding the
   * transcript would read it to the agent twice). A resume that fails for any
   * reason falls through to the ordinary open, replay included — an agent that
   * dropped its sessions must not take the DSH session down with it. Absent,
   * or naming an id for a dialect without the capability, means open exactly
   * as before.
   */
  readonly resumeOf?: (dshSessionId: string) => string | undefined
}

/** Long enough for a cold process to start, short enough to not strand a turn. */
const DEFAULT_OPEN_TIMEOUT_MS = 60_000

type UserText = { readonly role?: unknown; readonly content?: unknown }

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * The config option's accepted values, with aliases for a stale pick.
 *
 * A session can carry a model id from an older catalog: cursor stored plain
 * `grok-4.7` before its live option value became
 * `grok-4.7[context=256k,reasoning_effort=high,fast=true]`. Exact values win;
 * option names and the base before `[` cover those older ids. A pick that
 * matches none of them is no longer in the list the agent just advertised.
 */
function configValueAliases(reply: unknown, configId: string | undefined): Map<string, string> | undefined {
  if (configId === undefined) return undefined
  const options = recordOf(reply)['configOptions']
  if (!Array.isArray(options)) return undefined
  const selector = options.map(recordOf).find(option => option['id'] === configId)
  const entries = recordOf(selector)['options']
  if (!Array.isArray(entries)) return undefined
  const aliases = new Map<string, string>()
  for (const entry of entries) {
    const value = recordOf(entry)['value']
    if (typeof value === 'string') aliases.set(value, value)
  }
  for (const entry of entries) {
    const option = recordOf(entry)
    const value = option['value']
    if (typeof value !== 'string') continue
    const name = option['name']
    if (typeof name === 'string' && !aliases.has(name)) aliases.set(name, value)
    const bracket = value.indexOf('[')
    if (bracket > 0) {
      const base = value.slice(0, bracket)
      if (!aliases.has(base)) aliases.set(base, value)
    }
  }
  return aliases.size === 0 ? undefined : aliases
}

function resolveConfigValue(aliases: Map<string, string> | undefined, modelId: string): string | undefined {
  if (aliases === undefined) return modelId
  const direct = aliases.get(modelId)
  if (direct !== undefined) return direct
  const bracket = modelId.indexOf('[')
  return bracket > 0 ? aliases.get(modelId.slice(0, bracket)) : undefined
}

/**
 * The model ids the same reply advertised, or undefined when it named none.
 *
 * `set_model` has no selector names or values to alias against — its argument
 * is the exact wire id — so this set is the whole test of whether a session's
 * pick still exists on the agent's side. A reply that named no models leaves
 * the pick unjudged rather than rejected.
 */
function reportedModelIds(reply: unknown, dialect: AcpDialect | undefined): ReadonlySet<string> | undefined {
  if (dialect === undefined) return undefined
  const models = dialect.readModels(reply)
  return models.length === 0 ? undefined : new Set(models.map(model => model.id))
}

/**
 * The model the agent is on right now, as the reply reported it.
 *
 * `session/new` answers with `models.currentModelId` — the model the agent
 * would run on when nobody tells it otherwise. For an agent that serves one
 * id per effort (codex) that id carries the agent's own default effort
 * (`gpt-6-astra[medium]`, live probe 2026-10-23), which is the honest answer
 * to a pick that named the base alone.
 */
function reportedCurrentModelId(reply: unknown): string | undefined {
  const current = recordOf(recordOf(reply)['models'])['currentModelId']
  return typeof current === 'string' && current !== '' ? current : undefined
}

/**
 * The agent's own reasoning-effort selector, when it published one.
 *
 * An agent whose model ids carry no effort (grok) takes the effort through
 * this option instead: `reasoning_effort`, category `thought_level` (live
 * probe 2026-10-23).
 */
function reportedEffortOption(
  reply: unknown,
): { readonly configId: string; readonly values: ReadonlySet<string> } | undefined {
  const options = recordOf(reply)['configOptions']
  if (!Array.isArray(options)) return undefined
  const option = options
    .map(recordOf)
    .find(entry => entry['category'] === 'thought_level' || entry['id'] === 'reasoning_effort')
  if (option === undefined) return undefined
  const configId = option['id']
  if (typeof configId !== 'string' || configId === '') return undefined
  const values = new Set<string>()
  const entries = option['options']
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const value = recordOf(entry)['value']
      if (typeof value === 'string') values.add(value)
    }
  }
  return { configId, values }
}

function textOf(content: unknown): string {
  const entry = recordOf(content)
  if (typeof entry['text'] === 'string') return entry['text']
  const nested = recordOf(entry['content'])
  return typeof nested['text'] === 'string' ? nested['text'] : ''
}

/** The message an error carries, however it was shaped. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Pull the user-authored text out of a step decision's messages. */
export function promptText(messages: readonly unknown[]): string {
  const parts: string[] = []
  for (const message of messages as readonly UserText[]) {
    if (message.role !== undefined && message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') { parts.push(content); continue }
    if (!Array.isArray(content)) continue
    for (const block of content as { type?: unknown; text?: unknown }[]) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** An image block as the ACP `session/prompt` payload carries it. */
export type PromptImage = {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}

/** What one turn's prompt is made of, after the capability table has spoken. */
export type PromptContent = {
  /** The user-authored text, as `promptText` assembles it. */
  readonly text: string
  /** Image blocks cleared to ride the prompt, in message order. */
  readonly images: readonly PromptImage[]
  /**
   * Blocks held back from the prompt, in the order they were met.
   *
   * An image lands here when the agent's capability table declines it; every
   * other non-text block (a file, a resource) lands here always — none is sent
   * to any agent today. The runner hands the list to the writer, which turns it
   * into the row that tells the user the attachment did not arrive.
   */
  readonly undelivered: readonly UndeliveredAttachment[]
}

/**
 * Pull the user-authored content out of a step decision's messages, routed by
 * the capability table.
 *
 * A dialect that does not declare `acceptsImageContent` reads as "cannot":
 * sending what we cannot verify the agent takes is the one outcome this routing
 * exists to prevent, so an unknown (or absent) dialect never carries images.
 * Text is extracted exactly as `promptText` does, so a text-only turn builds
 * the same prompt as before.
 */
export function promptContent(messages: readonly unknown[], dialect: AcpDialect | undefined): PromptContent {
  const parts: string[] = []
  const images: PromptImage[] = []
  const undelivered: UndeliveredAttachment[] = []
  const acceptsImages = dialect?.capabilities.acceptsImageContent === true
  for (const message of messages as readonly UserText[]) {
    if (message.role !== undefined && message.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string') { parts.push(content); continue }
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      const type = typeof block?.['type'] === 'string' ? block['type'] : ''
      if (type === 'text') {
        if (typeof block['text'] === 'string') parts.push(block['text'])
        continue
      }
      if (type === 'image') {
        if (acceptsImages && typeof block['data'] === 'string' && typeof block['mimeType'] === 'string') {
          images.push({ type: 'image', data: block['data'], mimeType: block['mimeType'] })
        } else {
          undelivered.push({
            kind: 'image',
            ...(typeof block['mimeType'] === 'string' ? { mimeType: block['mimeType'] } : {}),
          })
        }
        continue
      }
      // Any other block kind — a file, a resource — is held back wholesale
      // (spec §8.1): no agent is sent one today, so it takes the same
      // undelivered road as a declined image. A block without a recognizable
      // type is skipped, exactly as the text-only extraction always skipped it.
      if (type !== '') {
        undelivered.push({
          kind: 'file',
          ...(typeof block['mimeType'] === 'string' ? { mimeType: block['mimeType'] } : {}),
        })
      }
    }
  }
  return { text: parts.join('\n'), images, undelivered }
}

/**
 * Map the agent's own stopping reason onto the loop's vocabulary.
 *
 * Only an ordinary end is `completed`. Anything else is reported under its own
 * kind so the turn closes as what actually happened rather than as a success.
 */
function toEndReason(stopReason: unknown): StepEndReason {
  switch (stopReason) {
    case 'end_turn':
    case undefined:
      return { kind: 'completed' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'cancelled':
      return { kind: 'aborted', reason: 'the agent reported the turn cancelled' }
    default:
      return { kind: 'blocked', reason: stopReason }
  }
}

/** The prefix the client puts on every JSON-RPC error reply before it reaches here. */
const ACP_ERROR_PREFIX = 'acp error: '
/**
 * The marker every connection-family failure carries: our transports, client
 * and handshake all phrase their reasons with the `acp ` prefix (see
 * `failureEndOf` for the inventory). An error without it is not about the
 * connection, and must not borrow its reconnect advice.
 */
const CONNECTION_PREFIX = 'acp '

/**
 * An agent refusal about authorization, not about the transport.
 *
 * The JSON-RPC error reply carries no structured class this side can read, so
 * the classification reads the reply's own text for the authorization
 * vocabulary the agents document (cursor's login requirement, claude's
 * permission errors, codex's auth updates). Anything matching ends the turn
 * with the approval hint; a JSON-RPC error without the signal keeps the raw
 * string — the spec's third bucket.
 */
const PERMISSION_SIGNAL = /auth|permission|login|unauthorized|forbidden|denied/i

/**
 * Map a turn failure onto the error end the loop records, with copy the
 * turn-error row can show as advice rather than as a raw string.
 *
 * The row renders `error.message` verbatim, so this is where the spec's
 * mapping lives: a dead or never-established connection points at resending
 * (the next turn opens a fresh session on its own); an authorization refusal
 * points at approving or logging in; anything else stays the agent's own
 * words. Every message keeps the original detail — a hint without the cause
 * is a dead end for diagnosis.
 */
export function failureEndOf(error: unknown): StepEndReason {
  const detail = messageOf(error)
  if (detail.startsWith(ACP_ERROR_PREFIX)) {
    if (PERMISSION_SIGNAL.test(detail)) {
      return {
        kind: 'error',
        error: {
          code: 'ACP_PERMISSION',
          message: `外部 agent 需要授权：${detail}。完成 agent 登录或在审批中放行后，重新发送即可。`,
        },
      }
    }
    return { kind: 'error', error: { code: 'ACP_ERROR', message: detail } }
  }
  // Every connection-family failure our own stack raises names itself with the
  // `acp ` prefix — the spawn/exit lines (`acp agent … could not run / exited`),
  // the socket close text (`acp agent connection closed: …`), the client's own
  // close (`acp connection closed`), the handshake deadline (`acp agent did
  // not answer within …`) and the missing session id (`acp session/new
  // returned no sessionId`). Anything else reaching this point is not a
  // connection failure at all — a bug inside the turn's own handling — and
  // must not wear the reconnect hint: the label has to tell the truth about
  // the cause even when the detail already would let someone diagnose it.
  if (detail.startsWith(CONNECTION_PREFIX)) {
    return {
      kind: 'error',
      error: {
        code: 'ACP_CONNECTION',
        message: `外部 agent 连接已断开：${detail}。重新发送这条消息即可重试，下一次会自动连接新的外部会话。`,
      },
    }
  }
  return {
    kind: 'error',
    error: {
      code: 'ACP_INTERNAL',
      message: `回合处理出错：${detail}`,
    },
  }
}

/** 本段实时写卡的登记：已写卡的公告/卡片与已实时落结果的 callId（投影后键）。 */
type LiveCards = {
  readonly turn: number
  readonly step: number
  readonly write: TurnContext['write']
  /** Call ids whose opening card already went to the log this segment. */
  readonly written: Set<string>
  /** Call ids whose result already went to the log this segment. */
  readonly settled: Set<string>
  /**
   * Call ids whose result is on the log with streamed output but no terminal
   * exit yet. The result waits at whichever content last arrived; a second
   * append would be rejected, so later output refines it in place.
   */
  readonly streamed: Set<string>
  /** Raw wire id → the folded call, so multi-frame tools keep their partial input. */
  readonly tools: Map<string, ToolCall>
  /**
   * grok `tool_index` → the last call id seen at that index, for delta frames
   * that carry only an index. Lets the streamed argument fragments fold onto the
   * call the first delta frame opened.
   */
  readonly deltaToolByIndex: Map<number, string>
}

/**
 * steps 路径全程持有的一条 spawned 运行（子代理/异步任务）。
 *
 * 段落边界由内容帧给出，spawned 卡片不切段——所以一张卡的出生帧、子代输出流
 * 和收尾帧可以落进三个不同的段。整回合投影靠「所有帧在一个列表里」折叠出这
 * 条生命周期；分段之后泵必须自己持有它：出生帧建档，子会话帧累积输出，收尾
 * 帧落定并即时写结果。日志覆盖情况逐项记账，收段时只补缺的那一半。
 */
type SpawnedTrack = {
  readonly callId: string
  /** The child session whose frames feed this run's output. */
  readonly childSessionId: string
  /** 折叠中的调用：output 随子会话帧累积，status 随收尾帧落定。 */
  readonly call: ToolCall
  settled: boolean
  /** 卡片是否已在日志（实时写出，或出生段收段补对）。 */
  cardOnLog: boolean
  /** 结果是否已在日志（收尾实时写出、出生段补对，或末段合成）。 */
  resultOnLog: boolean
  /** 出生帧是否还在当前未收的段里（每次收段清零，出生即置位）。 */
  openInSegment: boolean
}

export class AcpTurnRunner {
  private sessionId: string | undefined
  private dshSessionId: string | undefined
  private opening: Promise<string> | undefined
  /**
   * The last open reattached a journaled external session (`session/resume`)
   * rather than opening a fresh one. One turn's worth of state: the first
   * prompt after a resume must not ride the text replay, and any later open
   * (a different DSH session, a dropped connection) starts the question over.
   */
  private resumedLastOpen = false
  /**
   * 帧队列：observe 只入队，泵从队首消费。
   *
   * 队列随 prompt 生命周期清空（beginPrompt）——两次回合之间到达的帧属于无主
   * 回合，与旧 `turnFrames = []` 一样在下一个 prompt 发出时丢弃。
   */
  private readonly queue: AcpFrame[] = []
  /** 当前段的帧；run 路径不分段，它就是整个回合的帧。 */
  private frames: AcpFrame[] = []
  /**
   * 本回合的驱动方式：`run` 是网关路径（无段概念，入队后立即泵空，实时行为
   * 与逐帧 observe 相同）；`steps` 是接管路径（泵由当次 runSteps 调用驱动，
   * 按段推进）。随 prompt 生命周期设置。
   */
  private promptMode: 'run' | 'steps' | undefined
  /**
   * 当前段的分段器。仅 steps 路径创建——网关没有段概念，回合末一次投影。
   * 随 prompt 生命周期重建：段状态（哪些调用还开着）不能跨回合携带。
   */
  private segmenter: AcpSegmenter | undefined
  /**
   * spawned 运行（子代理/异步任务）的全程跟踪，仅 steps 路径创建。
   *
   * spawned 卡片不参与切段（分段器有意忽略），跨段就归这里管：出生帧建档并
   * 实时开卡，子会话帧把输出累积进档，收尾帧即时落结果；收段时只补日志上还
   * 缺的卡/结果，末段才对仍未收尾的合成 [still running]。run() 路径不需要——
   * 整回合的帧在一个列表里，投影自己折叠得出来。
   */
  private spawnedRuns: Map<string, SpawnedTrack> | undefined
  /**
   * Child session id → the spawned run its frames belong to.
   *
   * The map above is keyed by the card id; for a delegation cursor publishes
   * twice, the card id is the dispatching tool call's, not the child session's
   * (the native spawned frame is the join). Child text frames name the child
   * session, so they need this second index.
   */
  private readonly spawnedByChild = new Map<string, SpawnedTrack>()
  /**
   * The folded `task` tool calls cursor dispatched subagents from, keyed by
   * their single-line call id. The native `subagent_spawned` frame carries only
   * a truncated task and a generic agent name; the tool call has the full
   * prompt and the description the user saw. `_meta.cursor.toolCallId` joins
   * the two, and this is what makes the join possible when the frame arrives.
   */
  private readonly subagentTools = new Map<string, ToolCall>()
  /**
   * Call ids whose opening card already reached the log this prompt.
   *
   * `liveCards.written` is per segment; a spawned run's birth frame can land in
   * a later segment than the tool call that opened its card (cursor publishes
   * the two in one burst today, but the pump must not depend on it). This
   * prompt-level set tells the birth record its card is already there, so the
   * segment close does not write the same card again.
   */
  private readonly writtenCards = new Set<string>()
  private readonly proseBoundaries = new Map<string, number>()
  /**
   * 外部 agent 自己的委托运行（子代理 / 后台任务）里还开着的那几个。
   *
   * 这份账本与 `spawnedRuns` 不同：后者只在 steps 路径存在，服务于「跨段补卡」；
   * 这一份两条路径都在记，只回答一个问题——**外部 agent 现在是不是在等自己的
   * 子代理**。网关的总上限据此让路：子代理还在跑的时候把主回合按超时收尾，
   * 等于把「还在干活」说成「卡住了」（2026-10-20 会话 7165a323：codex 派出
   * 5 个子代理后等了将近 27 分钟，总上限到点把主回合按 ACP_TIMEOUT 收尾，
   * 5 个子代理的结果全部丢失，界面上主会话报超时、子会话还在跑）。
   */
  private readonly delegatedRuns = new Set<string>()
  private stream: TurnStreamPort | undefined
  /** Set when this turn's stop signal fired; everything after it is dropped. */
  private aborted = false
  /** 应答已落定（成功或失败）——末段的闭合条件之一。 */
  private promptSettled = false
  /** 应答给出的停止原因；应答失败时无意义。 */
  private replyStop: unknown
  /** 应答的失败；分类在 promptEnd 里做，与 run() 同一映射。 */
  private promptFailure: unknown
  /** 本回合的 prompt 携带了历史回灌（首段职责记录，随 prompt 生命周期）。 */
  private replayRode = false
  /** 组装 prompt 时被挡下的附件；随首段的落盘写成未送达公告。 */
  private undelivered: readonly UndeliveredAttachment[] = []
  /** 未送达公告只随首段写一次。 */
  private noticeWritten = false
  /** 段活动（帧入队 / 中止 / 应答落定）的唤醒回调；无人等待时是空操作。 */
  private wake: (() => void) | undefined
  /**
   * The segment in flight, for writing a tool card as its first frame arrives.
   *
   * Bound for one runSteps call (one segment) or for run()'s whole turn: a
   * frame can reach the log as mid-segment only while this binding owns the
   * write, and frames arriving between calls stay queued untouched — the next
   * call writes their cards under its own step number.
   */
  private liveCards: LiveCards | undefined

  /**
   * Maps a terminalId (from `terminal/create`) to the toolCallId of the
   * `run_terminal_command` that spawned it. Populated when the client fires
   * `onTerminalOutput` — the runner finds the matching tool call by command
   * string in `liveCards.tools` and records the binding.
   */
  private readonly terminalToTool = new Map<string, string>()

  /** 子代理影子会话：端口缺席时整个能力不存在（零写入）。 */
  private readonly subagents: SubagentSessions | undefined
  /** 当前外部回合对应的 DSH 会话 id（子会话目录事件写在它名下）。 */
  private parentSessionId: string | undefined
  /** 未映射帧的连续段聚合器（每个 prompt 重建）。 */
  private rawOutput: RawOutputAggregator | undefined
  /**
   * 外部 agent 最后上报的状态（active/idle/压缩/模式……）。
   *
   * 状态帧不产出内容，但超时消息要说清「停的时候它在干什么」；压缩上下文时
   * codex 一个帧都不发，这个快照是当时唯一的现场。每个 prompt 重开。
   */
  private lastStatus: SessionStatusSnapshot | undefined
  /** 已实时提示过的状态键：同一状态重复上报只提醒一次。 */
  private statusNoted: string | undefined

  private readonly client: AcpClientPort
  private readonly options: RunnerOptions
  /**
   * The config-option id carrying this agent's model selector, read off the
   * latest `session/new` reply by the dialect (`modelVia: 'config_option'`).
   * Undefined for prompt_param dialects and for a reply that named no selector.
   */
  private modelConfigId: string | undefined
  /**
   * The selector's accepted values and aliases, read off the same reply that
   * named the config-option id. Translates a stale session pick (cursor's
   * plain `grok-4.7`) into the value the live agent advertises.
   */
  private modelConfigValues: Map<string, string> | undefined
  /**
   * The model ids the current session's reply advertised. `set_model` takes an
   * exact wire id, so a pick outside this set is either stale (the agent's list
   * moved on) or a bare base that is missing an effort suffix. Undefined when
   * the reply named no models: then there is nothing to judge against.
   */
  private modelWireIds: ReadonlySet<string> | undefined
  /**
   * The modelId last applied to the current external session via
   * `session/set_config_option`. Keyed to the session, not the turn: the
   * agent keeps the selection across turns, so an unchanged pick must not
   * re-travel the wire before every prompt.
   */
  private appliedModelId: string | undefined
  /**
   * The reasoning effort applied alongside that model. The effort is part of
   * the pick — the same model at another effort is another write — so it is
   * remembered separately.
   */
  private appliedEffort: string | undefined
  /**
   * The model the agent is on, as the reply reported it
   * (`models.currentModelId`). For an agent that serves one id per effort
   * (codex) that is the agent's own default, base and effort together, and
   * the honest answer to a pick that named the base alone.
   */
  private currentModelId: string | undefined
  /**
   * The agent's own reasoning-effort selector, when it published one. An
   * agent whose model ids carry no effort (grok) takes the effort here.
   */
  private effortOption: { readonly configId: string; readonly values: ReadonlySet<string> } | undefined

  constructor(client: AcpClientPort, options: RunnerOptions) {
    this.client = client
    this.options = options
    this.subagents = options.subagents !== undefined && options.dialect !== undefined
      ? new SubagentSessions(options.subagents, options.dialect)
      : undefined
    // Registered once, here, rather than at the start of each turn: a frame
    // arriving between turns must not be dropped, and a handler installed
    // mid-turn misses whatever arrived before it.
    this.client.onFrame(frame => this.observe(frame))
    // Terminal streaming: grok delegates shell execution to the client. When
    // output arrives, map terminalId → toolCallId by command match and
    // synthesize a tool_call_update frame so the UI shows live output.
    if (client.onTerminalOutput !== undefined) {
      client.onTerminalOutput((terminalId: string, data: string) => this.handleTerminalOutput(terminalId, data))
    }
    if (client.onTerminalExit !== undefined) {
      client.onTerminalExit((terminalId: string, exitCode: number) => this.handleTerminalExit(terminalId, exitCode))
    }
  }

  /** Take one frame: keep it queued; the pump does everything else. */
  private observe(frame: AcpFrame): void {
    // 中止后到达的帧一律丢弃: the agent had not processed the cancel yet and
    // kept talking. Those frames belong to a turn nobody is reading, and
    // projecting them would resurrect text under a turn that ended aborted.
    if (this.aborted) return
    this.queue.push(frame)
    if (this.promptMode === 'run') {
      // 网关路径：入队后立即泵空。同一 tick 内逐帧处理，实时行为与旧的逐帧
      // observe 逐字节相同——流增量、开卡、实时结果的调用点原样搬进泵内。
      while (this.queue.length > 0) this.pumpNext()
      return
    }
    // 接管路径：泵由当次 runSteps 调用驱动（段闭合前不能越过边界），这里只
    // 唤醒等待中的泵。
    this.wakeup()
  }

  /**
   * 泵走队首一帧：归档进当前段，再做实时动作（开卡 → 实时结果 → 流增量）。
   *
   * 返回 true 表示该帧宣告上一段闭合、自身属于新段（分段器的契约）：调用方
   * 必须先收掉旧段，且不消费这一帧——它留在队首，由下一次 runSteps 调用在
   * 新段里处理（它的流增量与开卡都归新段）。只在绑定了分段器的 steps 路径
   * 可能返回 true；run 路径没有分段器，永不闭段。
   */
  private pumpNext(): boolean {
    const frame = this.queue[0]!
    // 子会话帧（子代理流）不进父泵的流与切段：steps 路径把它的文本累积进
    // spawned 档案（投影时折进子代理卡片的结果），且不归档进段帧——投影与泵
    // 在此约定一致，子代文本永远不会出现在父段的段消息或流里。run 路径照旧
    // 归档，整回合投影自会按 childSessions 路由。判定只有一次会话 id 比较；
    // params 不带会话 id 的帧（应答帧）视作父会话。
    const frameSessionId = recordOf(recordOf(frame)['params'])['sessionId']
    if (typeof frameSessionId === 'string' && frameSessionId !== this.sessionId) {
      this.queue.shift()
      // 影子子会话：子会话帧的正文/思考增量进它的实时流（两条路径都走这里）。
      this.routeChildSubagent(frame, frameSessionId)
      if (this.spawnedRuns !== undefined) {
        this.trackChildChunk(frame, frameSessionId)
        return false
      }
      this.frames.push(frame)
      return false
    }
    // 边界只在段里已有帧时成立：分段器的 anySettled 只能来自本段已消费的工具
    // 帧，空段边界按状态机不可达——防御性兜底按普通帧消费，绝不收一段空的。
    if (this.segmenter?.observe(frame) === true && this.frames.length > 0) return true
    this.queue.shift()
    this.frames.push(frame)
    // 状态帧先读：它要的提示必须落在本帧可能带来的卡片之前，且即便这帧没有
    // 任何内容可展示，状态也要更新（超时消息靠它说清最后在干什么）。
    this.observeStatus(frame)
    // 未映射帧先归聚合器：它返回的块必须在本帧自己的写入之前落盘，顺序才对。
    this.observeRawOutput(frame)
    // 出生帧建影子子会话、终态帧收尾；与 spawned 卡片记账互不干扰。
    this.routeSubagentFrame(frame)
    this.trackDelegatedFrame(frame)
    const spawned = this.spawnedRuns === undefined ? undefined : this.trackSpawnedFrame(frame)
    this.writeToolFrame(frame)
    if (spawned !== undefined && this.liveCards?.written.has(spawned.callId) === true) spawned.cardOnLog = true
    const stream = this.stream
    if (stream === undefined) return false
    // Held locally so nothing can clear it while this frame is being pushed.
    this.pushToStream(frame, stream)
    return false
  }

  /** The dialect-gated update a frame carries, the way accumulate reads it. */
  private frameUpdateOf(frame: AcpFrame): Record<string, unknown> | undefined {
    const dialect = this.options.dialect
    if (dialect === undefined) return undefined
    return dialect.frameUpdate === undefined
      ? (frame.method === 'session/update' ? recordOf(recordOf(frame.params)['update']) : undefined)
      : dialect.frameUpdate(frame)
  }

  /** 喂一帧给未知输出聚合器；段被打断时先把闭合块写掉。 */
  private observeRawOutput(frame: AcpFrame): void {
    const aggregator = this.rawOutput
    const live = this.liveCards
    if (aggregator === undefined || live === undefined) return
    const block = aggregator.observe(frame, { turn: live.turn, step: live.step }, { childSession: false })
    if (block !== undefined) this.writeRawOutput(block)
  }

  /**
   * 状态帧 → 快照 +（必要时）一条实时提示。
   *
   * 只对值得说的状态写提示：普通 active/idle 每个回合都有，铺进转录就是噪音；
   * 等待审批、模式切换、内部错误这些变化才是用户需要立刻知道的。写失败不抛：
   * 一条提示写不进去，不能连快照一起丢——超时消息读的是快照。
   */
  private observeStatus(frame: AcpFrame): void {
    const reading = readSessionStatus(frame)
    if (reading === undefined) return
    this.lastStatus = { ...reading, at: Date.now() }
    if (!reading.notable || reading.key === this.statusNoted) return
    const live = this.liveCards
    if (live === undefined) return
    try {
      live.write([systemNoteEvent(live.turn, live.step, reading.label)])
      this.statusNoted = reading.key
    } catch {
      // 下次同状态再试；帧流与回合不受影响。
    }
  }

  /** 写一块未知输出：经内容写入器展开成公告+卡片+结果（写失败不打死帧处理器）。 */
  private writeRawOutput(block: RawOutputBlock): void {
    const live = this.liveCards
    if (live === undefined) return
    try {
      live.write([{ type: RAW_OUTPUT, payload: block }])
    } catch {
      // 日志拒绝这一块时丢弃它；帧流与回合不能因此中断。
    }
  }

  /** 回合末把遥测帧按种类汇总成块写掉（每回合一次，位置用写出时的步骤）。 */
  private writeRawSummary(turn: TurnContext, position: { readonly turn: number; readonly step: number }): void {
    const blocks = this.rawOutput?.summary(position) ?? []
    for (const block of blocks) {
      try {
        turn.write([{ type: RAW_OUTPUT, payload: block }])
      } catch {
        // 写失败只丢这一块；回合收尾不受影响。
      }
    }
  }

  /**
   * 子代理出生帧/终态帧 → 影子子会话。
   *
   * 出生帧没有子会话 id 时（grok 实测）也要把标签记下来：首次子会话帧再建
   * 会话。终态只认 `subagent_state_update` 的 settled 帧——`async_task` 不建
   * 子会话（规格明确）。
   */
  private routeSubagentFrame(frame: AcpFrame): void {
    const sessions = this.subagents
    const parentId = this.parentSessionId
    const dialect = this.options.dialect
    if (sessions === undefined || parentId === undefined || dialect === undefined) return
    const update = this.frameUpdateOf(frame)
    if (update === undefined) return
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind === 'subagent_spawned') {
      const id = typeof update['subagentSessionId'] === 'string' ? update['subagentSessionId'] : undefined
      // cursor publishes the delegation as a `task` tool call too; that call
      // carries the full prompt and the agent name the user saw, while the
      // frame's `task` is truncated. Join on `_meta.cursor.toolCallId`.
      const linkedId = dialect.spawnToolCallId?.(update)
      const linked = linkedId === undefined ? undefined : this.subagentTools.get(linkedId)
      const args = recordOf(linked?.arguments)
      const task = typeof args['prompt'] === 'string'
        ? args['prompt']
        : typeof update['task'] === 'string' ? update['task'] : ''
      const firstLine = task.split('\n')[0]?.trim() ?? ''
      const agent = typeof args['agent'] === 'string' && args['agent'] !== '' ? args['agent'] : undefined
      const label = agent
        ?? (typeof update['name'] === 'string' ? update['name']
          : firstLine !== '' ? firstLine
            : typeof update['description'] === 'string' ? update['description']
              : id ?? '')
      sessions.spawn(parentId, id, label, task)
      return
    }
    if (kind === 'subagent_state_update') {
      const reading = readSpawnedFrame(dialect, update)
      if (reading === undefined || reading.kind !== 'state' || !reading.settled) return
      sessions.terminal(parentId, reading.callId, reading.status ?? 'failed', reading.output)
    }
  }

  /** 子会话帧：工具调用帧落成子会话真工具卡；未映射的进子会话未知块，正文/思考增量进实时流。 */
  private routeChildSubagent(frame: AcpFrame, childSessionId: string): void {
    const sessions = this.subagents
    const parentId = this.parentSessionId
    if (sessions === undefined || parentId === undefined) return
    // 工具调用帧先落子会话的工具卡（宿主 ui-tool 渲染富视图），不当未知输出。
    const update = this.frameUpdateOf(frame)
    const kind = typeof update?.['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'tool_call_delta_chunk') {
      sessions.toolFrame(parentId, childSessionId, frame)
      return
    }
    // 未映射内容先归子会话自己的聚合器（写进子会话日志，不串到父会话）。
    sessions.rawOutputFrame(parentId, childSessionId, frame)
    if (update === undefined) return
    if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') return
    const text = textOf(update['content'])
    if (text.length === 0) return
    sessions.chunk(parentId, childSessionId, kind === 'agent_thought_chunk' ? 'thought' : 'message', text)
  }

  /**
   * spawned 生命周期的逐帧记账（steps 路径）：出生帧建档、进度帧改写可见输出、
   * 收尾帧落定并即时写结果。返回出生帧的档案（供调用方回填 cardOnLog）。
   */
  private trackSpawnedFrame(frame: AcpFrame): SpawnedTrack | undefined {
    const runs = this.spawnedRuns
    const dialect = this.options.dialect
    if (runs === undefined || dialect === undefined) return undefined
    const update = this.frameUpdateOf(frame)
    if (update === undefined) return undefined
    const reading = readSpawnedFrame(dialect, update)
    if (reading === undefined) return undefined
    if (reading.kind === 'spawn') {
      // cursor's native spawn names the `task` tool call it was dispatched
      // from. That call already opened the card (full prompt, agent name), so
      // the run reuses its id and this frame only starts the lifecycle.
      const linkedId = dialect.spawnToolCallId?.(update)
      const linked = linkedId === undefined ? undefined : this.subagentTools.get(linkedId)
      const callId = linked?.callId ?? reading.call.callId
      const childSessionId = reading.call.callId
      // 同一出生帧只建一次档，与 foldSubagentUpdate 的去重一致。
      if (runs.has(callId)) return undefined
      const call = linked === undefined
        ? reading.call
        // The tool's own terminal frame fires at dispatch time; the run is not
        // over until the native state frame says so, so the card starts open.
        : { ...linked, name: 'subagent', status: undefined } satisfies ToolCall
      const record: SpawnedTrack = {
        callId,
        childSessionId,
        call,
        settled: false,
        cardOnLog: this.writtenCards.has(callId),
        resultOnLog: false,
        openInSegment: true,
      }
      runs.set(record.callId, record)
      this.spawnedByChild.set(childSessionId, record)
      return record
    }
    const record = runs.get(reading.callId) ?? this.spawnedByChild.get(reading.callId)
    if (record === undefined) return undefined
    if (reading.kind === 'progress') {
      if (reading.summary !== undefined) record.call.output = reading.summary
      return undefined
    }
    if (reading.output !== undefined && (!reading.fillOnlyEmpty || record.call.output === '')) {
      record.call.output = reading.output
    }
    if (reading.settled && !record.settled) {
      record.settled = true
      if (reading.status !== undefined) record.call.status = reading.status
      this.writeSpawnedResult(record)
    }
    return undefined
  }

  /**
   * 外部 agent 自己的委托运行还开着几个。
   *
   * 网关的总上限读这个数：外部 agent 在等自己的子代理时，这一回合不按超时收尾
   * ——子代理还在跑，报超时就是把「还在干活」说成「卡住了」。
   */
  liveDelegatedRuns(): number {
    return this.delegatedRuns.size
  }

  /** 外部对话的 id（ACP session id，codex 里就是 thread id）；未开会话时 undefined。 */
  externalSessionId(): string | undefined {
    return this.sessionId
  }

  /** 当前 prompt 最后收到的 agent 状态；还没收到状态帧时 undefined。 */
  lastStatusSnapshot(): SessionStatusSnapshot | undefined {
    return this.lastStatus
  }

  /**
   * 逐帧记账：委托运行出生时记一笔，收尾时销掉。
   *
   * 与 `trackSpawnedFrame` 读同一批帧，但只留「还开着没有」这一件事——补卡、
   * 累积输出那些是 steps 路径的事，这里两条路径都要。
   */
  private trackDelegatedFrame(frame: AcpFrame): void {
    const dialect = this.options.dialect
    if (dialect === undefined) return
    const update = this.frameUpdateOf(frame)
    if (update === undefined) return
    const reading = readSpawnedFrame(dialect, update)
    if (reading === undefined) return
    if (reading.kind === 'spawn') {
      this.delegatedRuns.add(reading.call.callId)
      return
    }
    if (reading.kind === 'state' && reading.settled) {
      this.delegatedRuns.delete(reading.callId)
    }
  }

  /** 子会话帧：文本累积进 spawned 档案的输出（accumulate 的子代路由同款）。 */
  private trackChildChunk(frame: AcpFrame, childSessionId: string): void {
    const record = this.spawnedByChild.get(childSessionId)
    if (record === undefined) return
    const update = this.frameUpdateOf(frame)
    if (update === undefined) return
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind !== 'agent_message_chunk') return
    const text = textOf(update['content'])
    if (text.length > 0) record.call.output += text
  }

  /**
   * 收尾帧到达即写 spawned 结果：卡片已在日志才配对（实时写或出生段补对），
   * 否则留给出生段收段时补对——孤儿结果日志不认。写失败不抛：帧处理器还要
   * 驱动流与切段。
   */
  private writeSpawnedResult(record: SpawnedTrack): void {
    const live = this.liveCards
    if (live === undefined) return
    if (!(record.cardOnLog || live.written.has(record.callId))) return
    if (record.resultOnLog || live.settled.has(record.callId)) return
    try {
      live.write([projectSpawnedResult(record.call, { turn: live.turn, step: live.step })])
    } catch {
      return
    }
    live.settled.add(record.callId)
    record.resultOnLog = true
  }

  /** Wake a runSteps call waiting for segment activity; nobody waiting is a no-op. */
  private wakeup(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /**
   * Wait until a frame is queued, the stop fires, or the prompt settles.
   *
   * The caller re-checks every condition after each wake, so a wake that fires
   * while it is mid-drain is simply a no-op. The check and the wait are one
   * synchronous block — nothing can slip in between on a single thread.
   */
  private waitForActivity(): Promise<void> {
    return new Promise(resolve => { this.wake = resolve })
  }

  /**
   * 开始一个外部 prompt 的生命周期：清队列、重建段状态与中止旗标。
   *
   * 队列里的残余帧在这里丢弃（两次回合之间的帧属于无主回合）；分段器只随
   * steps 路径创建——网关没有段概念，回合末一次投影。
   */
  private beginPrompt(mode: 'run' | 'steps'): void {
    this.queue.length = 0
    this.frames = []
    this.promptMode = mode
    this.segmenter = mode === 'steps' && this.options.dialect !== undefined
      ? new AcpSegmenter(this.options.dialect)
      : undefined
    this.spawnedRuns = mode === 'steps' && this.options.dialect !== undefined ? new Map() : undefined
    this.spawnedByChild.clear()
    this.subagentTools.clear()
    this.writtenCards.clear()
    this.proseBoundaries.clear()
    // 委托运行的账本随 prompt 重开：上一回合的子代理属于上一回合。
    this.delegatedRuns.clear()
    this.aborted = false
    this.promptSettled = false
    this.replyStop = undefined
    this.promptFailure = undefined
    this.replayRode = false
    this.undelivered = []
    this.noticeWritten = false
    // 未映射帧的连续段从空开始：每次 prompt 一段新记录，块不跨回合。
    this.rawOutput = new RawOutputAggregator()
    // 状态快照也随 prompt 重开：上一回合结束时的 idle 不是这一回合的现场，
    // 超时消息若读到它，会把「还没开始说话」说成「说完话了」。
    this.lastStatus = undefined
    this.statusNoted = undefined
  }

  /**
   * Commit one opening announcement/card, then its terminal result as it arrives.
   * Raw wire ids retain partial-frame state; normalized ids deduplicate durable
   * events. Failed appends remain eligible for the final projection to retry.
   */
  private writeToolFrame(frame: AcpFrame): void {
    const live = this.liveCards
    const dialect = this.options.dialect
    if (live === undefined || dialect === undefined) return
    const update = recordOf(recordOf(frame.params)['update'])
    const sessionUpdate = update['sessionUpdate']
    const isWholeTool = frame.method === 'session/update'
      && (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
    const isDeltaTool = dialect.foldToolDelta !== undefined
      && sessionUpdate === 'tool_call_delta_chunk'
      && (frame.method === 'session/update' || (typeof dialect.frameUpdate === 'function' && dialect.frameUpdate(frame) !== undefined))
    const rawId = update['toolCallId'] ?? update['tool_call_id']
    // A delta fragment names its call by id on the first frame and by index
    // after; resolve the same way the projection does so the fragments fold
    // onto one call.
    const deltaIndex = typeof update['tool_index'] === 'number' ? update['tool_index'] : undefined
    const resolvedId = typeof rawId === 'string'
      ? rawId
      : isDeltaTool && deltaIndex !== undefined ? live.deltaToolByIndex.get(deltaIndex) : undefined
    const isTool = isWholeTool || isDeltaTool
    const carried = isTool && resolvedId !== undefined ? live.tools.get(resolvedId) : undefined
    let nativeSubagent = false
    let foldedCall: ToolCall | undefined
    if (isTool && resolvedId !== undefined) {
      const deltaFold = dialect.foldToolDelta
      const folded = isDeltaTool && deltaFold !== undefined
        ? (deltaFold(carried, update) ?? dialect.foldTool(carried, update))
        : dialect.foldTool(carried, update)
      foldedCall = folded
      // First frame of a call seals prose BEFORE the announcement/card. Updates
      // and terminal results for an existing call must not split later prose.
      if (carried === undefined) {
        const beforeBlock = this.stream?.toolBoundary?.()
        if (typeof beforeBlock === 'number') this.proseBoundaries.set(resolvedId, beforeBlock)
      }
      live.tools.set(resolvedId, folded)
      if (deltaIndex !== undefined) live.deltaToolByIndex.set(deltaIndex, resolvedId)
      // 子代理经**工具调用**派发时（cursor 的 `task` 工具，2026-10-21 真机抓帧：
      // kind "other" + rawInput._toolName "task"），也要开一个影子子会话——否则
      // 界面上只有一张卡片，子会话列表里没有它（ACP 草案的 subagent_spawned 帧
      // 那条路由 routeSubagentFrame 负责，两条路现在都有子会话）。
      //
      // cursor 同时发原生子代理帧时，这条工具调用只是派发凭据：子会话由
      // routeSubagentFrame 按子会话 id 建，卡片由原生帧落定。记下它供出生帧
      // 关联全量 prompt/代理名，但不再自己建子会话——否则同一个子代理会多出
      // 一个空的影子会话。工具调用在派发瞬间就报 completed，结果也不能在这里
      // 落：那时子代理才刚开工。
      this.trackSubagentTool(folded)
      nativeSubagent = dialect.capabilities.nativeSubagentFrames === true && folded.name === 'subagent'
      // A placeholder frame announces the call before its arguments exist
      // (cursor's pending edit, codex's read). The card is immutable, so
      // writing it now would freeze `{}` in place of the real input. Wait for
      // the frame that carries them; the terminal frame always qualifies, so
      // a call that genuinely has no arguments still gets its card.
      if (folded.status !== 'completed' && folded.status !== 'failed'
        && Object.keys(recordOf(folded.arguments)).length === 0) return
    }
    // The native spawn of a delegation the `task` tool call already opened:
    // that call's card is the run's card, so a second one would show the same
    // subagent twice.
    if (!isTool && update['sessionUpdate'] === 'subagent_spawned') {
      const linkedId = dialect.spawnToolCallId?.(update)
      if (linkedId !== undefined && this.subagentTools.has(linkedId)) return
    }
    const options = { turn: live.turn, step: live.step, dialect, ...(carried === undefined ? {} : { carried }) }
    // A delta frame carries only a fragment, so re-folding from it would lose the
    // accumulated arguments and the index-resolved id; write from the folded call
    // the loop already holds instead.
    const event = isDeltaTool && foldedCall !== undefined
      ? projectToolCall(foldedCall, options)
      : projectToolCallFrame(frame, options)
    if (event === undefined) return
    const callId = recordOf(event.payload)['callId']
    if (typeof callId !== 'string') return
    if (!live.written.has(callId)) {
      let announcement = isDeltaTool && foldedCall !== undefined
        ? projectToolCallAnnouncementCall(foldedCall, options)
        : projectToolCallAnnouncement(frame, options)
      // Adapter-private replay metadata preserves the exact stream boundary.
      // Text chunks and durable tool events travel on different channels, so
      // timestamps (or arrival order) alone cannot reliably place a same-tick tool.
      const beforeBlock = resolvedId === undefined ? undefined : this.proseBoundaries.get(resolvedId)
      if (announcement !== undefined && beforeBlock !== undefined) {
        const payload = recordOf(announcement.payload)
        const message = recordOf(payload['message'])
        announcement = { ...announcement, payload: { ...payload, message: { ...message,
          source: { ...recordOf(message['source']), replayState: { response: { threadharborAcpBoundary: { version: 1, beforeBlock } } } },
        } } }
      }
      try {
        live.write(announcement === undefined ? [event] : [announcement, event])
      } catch {
        // A rejected append stays eligible for the turn-end projection.
        return
      }
      live.written.add(callId)
      this.writtenCards.add(callId)
    }
    if (live.settled.has(callId)) return
    // The dispatch call's terminal frame is not the run's end: the native
    // state frame settles this card (trackSpawnedFrame → writeSpawnedResult).
    if (nativeSubagent) return
    const result = projectToolResultFrame(frame, options)
    if (result === undefined) return
    try {
      live.write([result])
    } catch {
      // Retry through the turn-end projection if this result was not committed.
      return
    }
    live.settled.add(callId)
  }

  /**
   * Map a terminalId to a toolCallId by finding the most recent run_terminal_command
   * (or bash) call that hasn't settled yet. Called on first output from a new terminalId.
   */
  private resolveTerminalTool(terminalId: string): string | undefined {
    const existing = this.terminalToTool.get(terminalId)
    if (existing !== undefined) return existing
    const live = this.liveCards
    if (live === undefined) return undefined
    // Search liveCards.tools for a bash or run_terminal_command call.
    // The grok dialect's foldTool keeps the native name; the projection
    // maps it to 'bash' via toolNameMap, but liveCards.tools stores the
    // folded call with the native name.
    let bestId: string | undefined
    for (const [id, call] of live.tools) {
      if ((call.name === 'bash' || call.name === 'run_terminal_command') && !live.settled.has(id)) {
        bestId = id
      }
    }
    if (bestId !== undefined) {
      this.terminalToTool.set(terminalId, bestId)
    }
    return bestId
  }

  /**
   * Handle streaming output from a terminal: accumulate output into the call
   * and refresh its result so the UI updates live.
   *
   * We construct the result event directly rather than going through
   * projectToolResultFrame, because that function gates on completed/failed
   * status and we want to stream partial output while the call is still running.
   * The writer turns the first write into the call's one result and every later
   * one into a content-only replacement: a second result append is what makes a
   * session refuse to load at all.
   */
  private handleTerminalOutput(terminalId: string, data: string): void {
    if (this.aborted) return
    const toolCallId = this.resolveTerminalTool(terminalId)
    if (toolCallId === undefined) return
    const live = this.liveCards
    if (live === undefined) return
    const call = live.tools.get(toolCallId)
    if (call === undefined) return
    call.output = (call.output ?? '') + data
    this.writeTerminalResult(live, toolCallId, call)
  }

  /**
   * Put the call's accumulated output on its result, opening one when needed.
   *
   * The result waits for the card: a result the log never saw announced is the
   * orphan that makes the file unloadable, and the exit path writes the pair in
   * order when the opening frame is still held back.
   *
   * @returns whether the write reached the log.
   */
  private writeTerminalResult(live: LiveCards, toolCallId: string, call: ToolCall): boolean {
    if (!live.written.has(toolCallId)) return false
    const event = projectToolResultFrame(
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: this.sessionId ?? '',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: call.output ?? '' } }],
          },
        },
      },
      { turn: live.turn, step: live.step, dialect: this.options.dialect!, carried: call },
    )
    if (event === undefined) return false
    try {
      live.write([event])
    } catch {
      // A rejected append stays eligible for the turn-end projection.
      return false
    }
    live.streamed.add(toolCallId)
    return true
  }

  /**
   * Handle terminal process exit: land the final output, then settle the card.
   *
   * The provider's own completed update arrives after this and must not land a
   * second result, so the call is marked settled here — the provider's frame is
   * a duplicate the log would reject.
   */
  private handleTerminalExit(terminalId: string, exitCode: number): void {
    if (this.aborted) return
    const toolCallId = this.resolveTerminalTool(terminalId)
    if (toolCallId === undefined) return
    const live = this.liveCards
    if (live === undefined) return
    const call = live.tools.get(toolCallId)
    if (call === undefined) return
    call.status = 'completed'
    if (live.written.has(toolCallId)) {
      if (!this.writeTerminalResult(live, toolCallId, call)) return
      live.settled.add(toolCallId)
    } else {
      // The card never opened: the placeholder waited for input that never
      // came. The completed frame opens it and lands card + result in order,
      // and marks the call settled itself.
      this.writeToolFrame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: this.sessionId ?? '',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: call.output ?? '' } }],
          },
        },
      })
    }
    this.terminalToTool.delete(terminalId)
  }

  /**
   * A subagent dispatched through a TOOL CALL rather than through the draft's
   * frames: open a shadow child session for it, and close it when the call
   * settles.
   *
   * cursor 的子代理派发就是这么来的（真机抓帧 2026-10-21）：一条 `kind: "other"`
   * 的工具调用，`rawInput._toolName` 是 "task"，任务在 `prompt`，代理名在
   * `description`。dialect 把它认成 `subagent` 卡片。
   *
   * 当同一个派发还会发原生子代理帧时（`nativeSubagentFrames`），这条调用只
   * 登记下来供出生帧关联全量 prompt 与代理名：子会话与卡片都由原生帧负责，
   * 这里再建一个只会多出一个永远不会收到子代帧的影子会话。
   *
   * @param folded - the folded tool call; its single-line id is the join key.
   */
  private trackSubagentTool(folded: ToolCall): void {
    if (folded.name !== 'subagent') return
    if (this.options.dialect?.capabilities.nativeSubagentFrames === true) {
      this.subagentTools.set(folded.callId, folded)
      return
    }
    const sessions = this.subagents
    const parentId = this.parentSessionId
    if (sessions === undefined || parentId === undefined) return
    const args = recordOf(folded.arguments)
    const task = typeof args['prompt'] === 'string' ? args['prompt'] : ''
    const label = typeof args['agent'] === 'string' && args['agent'] !== '' ? args['agent'] : 'subagent'
    if (folded.status === 'completed' || folded.status === 'failed') {
      sessions.terminal(parentId, folded.callId, folded.status === 'completed' ? 'completed' : 'failed', folded.output)
      return
    }
    sessions.spawn(parentId, folded.callId, label, task)
  }

  /** Feed one frame's text to the live stream. */
  private pushToStream(frame: AcpFrame, stream: NonNullable<typeof this.stream>): void {
    const update = recordOf(recordOf(recordOf(frame)['params'])['update'])
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') return
    const text = textOf(update['content'])
    if (text.length === 0) return
    if (kind === 'agent_thought_chunk') stream.reasoningDelta(text)
    else stream.textDelta(text)
  }

  /**
   * Run one turn.
   *
   * Failures propagate on purpose: the replacement step lets them reach the
   * loop's own error handling, which closes the turn as an error. Returning
   * something empty instead would show the user an agent that merely had nothing
   * to say.
   */
  /**
   * Run one turn, and own everything its answer produces.
   *
   * The write lives here rather than in the caller on purpose: the stream's
   * closing frame can only be emitted after the durable message exists, and it
   * has to carry that message's sequence number. Split across two places, the
   * two can be reordered, and the result is a frame pointing at a message that
   * was never written.
   */
  async run(decision: StepDecisionLike, turn: TurnContext): Promise<AcpStepResult> {
    // Whether this run opens the external conversation, decided before `open`
    // settles: a different session asking, or no external session yet (first
    // turn, or the last attempt failed), means the transcript has not been
    // replayed into it. Only that first request carries the history — a later
    // request would read it to the agent a second time.
    const firstOpen = this.dshSessionId !== turn.sessionId || this.sessionId === undefined
    let sessionId: string
    try {
      sessionId = await this.open(turn.sessionId)
    } catch (error: unknown) {
      // An agent that never opened (missing binary, handshake timeout, refused
      // login) is the reconnect case just as much as one that died mid-turn:
      // the turn ends as a classified error instead of a thrown raw one.
      return { frames: [], end: failureEndOf(error) }
    }
    // 网关路径整回合一个 prompt：清残余、按 run 模式重建（无分段器）。observe
    // 从此入队即泵空，帧的实时处理与旧的逐帧 observe 相同。
    this.beginPrompt('run')
    this.parentSessionId = turn.sessionId
    // Bound before the prompt goes out: a tool frame only arrives once the
    // agent has the question, but the binding must not be able to lose the
    // race with it. Held in a local too — the field is cleared the moment the
    // prompt settles, and the turn-end write below still needs the written
    // record to know which cards not to write a second time.
    //
    // A turn context with no position (the in-place gateway answers with one
    // when it knows the open turn, and without one when it does not) gets no
    // live-card binding. These cards are live-stream bookkeeping only — the
    // turn-end write below is what reaches the session log — so skipping them
    // costs visibility, not the answer, and a fabricated 0/0 here is exactly
    // what used to make the log unloadable.
    const liveCards = this.options.dialect === undefined || turn.position === undefined ? undefined : {
      turn: turn.position.turn,
      step: turn.position.step,
      write: turn.write,
      written: new Set<string>(),
      settled: new Set<string>(),
      streamed: new Set<string>(),
      tools: new Map<string, ToolCall>(),
      deltaToolByIndex: new Map<number, string>(),
    }
    this.liveCards = liveCards
    // Registered before the prompt goes out: the stop lands while the agent is
    // still working, and a listener added afterwards would never hear it.
    const detachStop = this.watchStop(sessionId)
    const stream = turn.openStream?.()
    this.stream = stream
    stream?.start()

    // The handed-over conversation rides ahead of this turn's question, on the
    // first request only. Taken before the request and put back if the request
    // failed: a retry that re-sends it would double the history, but a retry
    // without it would silently drop the conversation — and that is the one
    // outcome a handover must never produce.
    const handedOver = this.options.primer?.take(turn.sessionId)
    // The host transcript rides the first request too, but only when no
    // handover exists — the handover is the fresher copy of the same
    // conversation, and carrying both would read the history twice. A resumed
    // open needs neither: the agent still has the conversation it kept.
    const replayed = handedOver === undefined && firstOpen && !this.resumedLastOpen
      ? this.options.replay?.take(turn.sessionId)
      : undefined
    const { text: question, images, undelivered } = promptContent(decision.messages, this.options.dialect)
    // 未送达公告走段收尾的统一通道（run 路径即回合末），与 runSteps 同一写法。
    this.undelivered = undelivered
    const text = handedOver !== undefined
      ? `${handedOver}\n\n${question}`
      : replayed !== undefined
        ? `【之前对话】\n${replayed}\n\n【当前问题】\n${question}`
        : question
    const params: Record<string, unknown> = {
      sessionId,
      // The images ride after the text, in the order the messages carried them;
      // when the capability table declines them this list is text-only, and the
      // held-back ones are reported below instead.
      prompt: [{ type: 'text', text }, ...images],
    }
    // The session's own selection outranks the configured default: it is what
    // the user picked for this conversation. Config-option dialects get it
    // applied ahead of the prompt — inside the same try, so a refused pick is
    // classified exactly like a refused prompt instead of dying unhandled.
    const modelId = turn.modelId ?? this.options.modelId
    // The effort the picker chose belongs to the pick: the agent that serves
    // one id per effort wants it inside that id.
    const effort = turn.reasoningEffort
    if (modelId !== undefined && !this.modelAppliedOutOfBand()) {
      params['modelId'] = modelId
    }

    let reply: unknown
    let failure: unknown
    try {
      if (modelId !== undefined && this.modelAppliedOutOfBand()) {
        await this.applyModel(sessionId, modelId, effort)
      }
      // The question is on its way now, and only now: a refusal above (a stale
      // model pick, a failed handshake) never delivered it. A caller anchoring
      // its state to delivery advances here, so the failed-before-send turn is
      // asked again in full while a sent-then-failed one is not duplicated.
      turn.promptDelivered?.()
      reply = await this.client.request('session/prompt', params)
    } catch (error: unknown) {
      // Remember it and settle the listeners; the classification below turns
      // it into the end the turn-error row can show as advice.
      failure = error
    } finally {
      // A listener must not outlive its turn, or a later turn would inherit
      // this one's stop and end aborted before it began. The same goes for
      // the mid-turn card writer: frames trailing the reply belong to the
      // turn-end write, not to a mid-turn one racing it.
      detachStop()
      this.liveCards = undefined
    }
    const stopReason = (reply as { stopReason?: unknown } | null)?.stopReason

    this.stream = undefined

    if (failure !== undefined) {
      // The handover goes back first: a retry must keep the history.
      if (handedOver !== undefined) this.options.primer?.restore(turn.sessionId, handedOver)
      // A stop outranks the replay rejection too: if the user stopped the turn
      // AND the prompt then rejected (the dying connection's error reply), the
      // turn is what the user made it — stopped — and the frames it sent before
      // the stop must still be written. Fall through to the shared tail, which
      // ends aborted and produces/writes them, rather than dying here with the
      // replay reason and orphaning the pre-stop content.
      if (replayed !== undefined && !this.aborted) {
        // The transcript rode this very prompt, so it is the likeliest reason
        // the agent refused it — a first request suddenly oversized or in a
        // shape the agent does not take. End the turn naming that instead of
        // dying with the agent's bare error: the user keeps their question on
        // the record and reads why the answer never came, rather than watching
        // the turn vanish into an opaque failure. Not classified further — any
        // failure of a prompt that carried the replay says so here.
        stream?.abandon()
        return {
          frames: [...this.frames],
          end: {
            kind: 'error',
            error: {
              message: `历史回灌被拒绝：${messageOf(failure)}`,
              code: 'REPLAY_REJECTED',
            },
          },
        }
      }
      // Everything else falls through to the shared tail: the frames the agent
      // sent before failing are produced and written like any turn's, and the
      // end names the failure class with copy the row can show as advice.
    }

    // The stop outranks whatever the agent replied — or whatever failure raced
    // out of the dying connection: once the turn was stopped and the agent told
    // to cancel, the turn is what the user made it — stopped.
    const end = this.aborted
      ? abortedEnd()
      : failure !== undefined
        ? failureEndOf(failure)
        : toEndReason(stopReason)
    // The turn's frames, snapshotted before the close (closing the segment
    // archives them — the next segment starts empty, and there is no next
    // segment on this path).
    const frames = [...this.frames]
    // Produce after the run, write after that, and only then announce the end:
    // the closing frame carries the message's sequence number, and pointing at
    // a message that is not written yet shows the user text that then vanishes.
    // Cards already written mid-turn are stripped here, and so are the results
    // the terminal frames already filed live; anything the mid-turn writer
    // could not track (a frame with no call id, a call whose live write
    // failed) still rides the turn-end write as before. Same tail the segment
    // path closes every segment with — one projection, one write, one settle.
    this.closeSegment(turn, stream, liveCards, end, undefined, true)
    // 父回合结束：子代理会话只放弃实时流，保持开放等它自己的真实终态。
    this.subagents?.parentTurnEnd(turn.sessionId)
    return {
      frames,
      end,
      ...(stream === undefined ? {} : { stream: stream.records() }),
    }
  }

  /**
   * 按段驱动一个外部回合：每次调用消费一个闭合段，一段一个 DSH 步骤。
   *
   * 返回 null 表示「回合还没结束」——原生循环会补上下一步的边界再调一次，
   * 届时 first=false。段边界由分段器宣告：工具批次全部收尾后的第一条新内容
   * 帧闭合上一段，且该帧归新段（留在队首由下一次调用处理）。首段调用
   * （first=true）独占回合级职责：开外部会话、重建段状态、挂停止监听、历史
   * 回灌、组装并发送 prompt；后续调用只绑本段的实时登记、开本段的流、泵帧、
   * 收段。用户消息与模型选择不归这里——接管分支（dispatch）自己写。
   *
   * 末段（应答落定 / 中止 / 失败）才返回真实结束原因，优先级与 run() 一致：
   * 中止 > 失败分类 > 应答停止原因。中止把已到的内容当末段写掉，之后的帧照旧
   * 丢弃；应答半路被拒同理，按分类错误收场。
   */
  async runSteps(decision: StepDecisionLike, turn: TurnContext, options: { readonly first: boolean }): Promise<StepEndReason | null> {
    if (options.first) {
      // Whether this run opens the external conversation, decided before `open`
      // settles: a different session asking, or no external session yet, means
      // the transcript has not been replayed into it. Only that first request
      // carries the history.
      const firstOpen = this.dshSessionId !== turn.sessionId || this.sessionId === undefined
      let sessionId: string
      try {
        sessionId = await this.open(turn.sessionId)
      } catch (error: unknown) {
        // 外部会话没开成（缺二进制、握手超时、拒绝登录）：与 run() 同一条分类
        // 路径，回合以错误收场，无段落事件。
        return failureEndOf(error)
      }
      this.beginPrompt('steps')
    this.parentSessionId = turn.sessionId
      // Registered before the prompt goes out: the stop lands while the agent
      // is still working, and a listener added afterwards would never hear it.
      // 解除随应答落定（成功或失败），不得跨段存活。
      const detachStop = this.watchStop(sessionId)
      // The handed-over conversation rides ahead of this turn's question, on
      // the first request only. Taken before the request and put back if the
      // request failed.
      const handedOver = this.options.primer?.take(turn.sessionId)
      const replayed = handedOver === undefined && firstOpen && !this.resumedLastOpen
        ? this.options.replay?.take(turn.sessionId)
        : undefined
      this.replayRode = replayed !== undefined
      const { text: question, images, undelivered } = promptContent(decision.messages, this.options.dialect)
      // 未送达公告随首段落盘（组装 prompt 的那次调用才知道挡下了什么）。
      this.undelivered = undelivered
      const text = handedOver !== undefined
        ? `${handedOver}\n\n${question}`
        : replayed !== undefined
          ? `【之前对话】\n${replayed}\n\n【当前问题】\n${question}`
          : question
      const params: Record<string, unknown> = {
        sessionId,
        prompt: [{ type: 'text', text }, ...images],
      }
      const modelId = turn.modelId ?? this.options.modelId
      const effort = turn.reasoningEffort
      if (modelId !== undefined && !this.modelAppliedOutOfBand()) {
        params['modelId'] = modelId
      }
      // prompt 不在本次调用里等完：应答落定只是末段的闭合条件之一，段边界才是
      // 本次调用的返回时机。落定后续接只做三件事——记录结果、解除监听、唤醒泵。
      // 协议写路径的方言把选型应用串在 prompt 前面：同一个 promise，落定/失败
      // 与 prompt 共用同一条通路，选型被拒不会卡死泵。promptDelivered 挂在
      // request 之前、选型成功之后：没送出的问题不算送达。
      const sendPrompt = (): Promise<unknown> => {
        turn.promptDelivered?.()
        return this.client.request('session/prompt', params)
      }
      const asking = modelId !== undefined && this.modelAppliedOutOfBand()
        ? this.applyModel(sessionId, modelId, effort).then(sendPrompt)
        : sendPrompt()
      void asking.then(
        reply => {
          this.promptSettled = true
          this.replyStop = (reply as { stopReason?: unknown } | null)?.stopReason
          detachStop()
          this.wakeup()
        },
        error => {
          this.promptSettled = true
          this.promptFailure = error
          // The handover goes back first: a retry must keep the history.
          if (handedOver !== undefined) this.options.primer?.restore(turn.sessionId, handedOver)
          detachStop()
          this.wakeup()
        },
      )
    }
    return this.pumpSegment(turn)
  }

  /**
   * 泵到本段闭合：从队首逐帧处理（流增量 → 开卡 → 实时结果），直到分段器
   * 宣告边界、中止旗标竖起、或应答落定且队列清空。
   *
   * 每次调用开自己的流（turn.openStream 的新 attempt，计数器全程递增）与自己的
   * 实时登记——段与段之间到达的帧留着不动，由下一次调用在本段的步骤号下处理。
   */
  private async pumpSegment(turn: TurnContext): Promise<StepEndReason | null> {
    // 同 run() 的绑定规则：没有方言或没有位置就没有实时登记——开卡/实时结果
    // 只剩段末投影这一条路，答案不受影响。
    const liveCards = this.options.dialect === undefined || turn.position === undefined ? undefined : {
      turn: turn.position.turn,
      step: turn.position.step,
      write: turn.write,
      written: new Set<string>(),
      settled: new Set<string>(),
      streamed: new Set<string>(),
      tools: new Map<string, ToolCall>(),
      deltaToolByIndex: new Map<number, string>(),
    }
    this.liveCards = liveCards
    const stream = turn.openStream?.()
    this.stream = stream
    stream?.start()
    try {
      while (true) {
        while (this.queue.length > 0) {
          if (this.pumpNext()) {
            // 边界帧属于新段：留在队首，下一次调用在它自己的段里处理。
            // 中间段的 end 只是类型占位——投影只读 frames/stream，回合的真实
            // 结束原因只随末段返回。
            this.closeSegment(turn, stream, liveCards, { kind: 'completed' }, this.spawnedCloseBookkeeping(turn, false))
            return null
          }
        }
        if (this.aborted || this.promptSettled) {
          const end = this.promptEnd()
          if (this.promptFailure !== undefined && this.replayRode && !this.aborted) {
            // 历史回灌被拒：与 run() 同款——流作废、不落任何事件。
            stream?.abandon()
            this.subagents?.parentTurnEnd(turn.sessionId)
            return end
          }
          // 空末段：上一次闭合之后、应答/中止之前什么都没到——没有事件可写，
          // 结束原因走返回值（公告或 spawned 收尾待写时不算空，见下）。
          if (this.frames.length === 0 && !this.noticePending() && !this.spawnedTailPending()) {
            stream?.abandon()
            if (turn.position !== undefined) this.writeRawSummary(turn, turn.position)
            this.subagents?.parentTurnEnd(turn.sessionId)
            return end
          }
          this.closeSegment(turn, stream, liveCards, end, this.spawnedCloseBookkeeping(turn, true), true)
          this.subagents?.parentTurnEnd(turn.sessionId)
          return end
        }
        // 段未闭合、应答未落定：等下一帧、中止或应答（observe / watchStop /
        // 应答续延唤醒）。
        await this.waitForActivity()
      }
    } finally {
      this.liveCards = undefined
      this.stream = undefined
    }
  }

  /** 末段收尾时是否还有 spawned 运行等着合成结果（空末段也要写它再收）。 */
  private spawnedTailPending(): boolean {
    const runs = this.spawnedRuns
    if (runs === undefined) return false
    for (const record of runs.values()) {
      if (!record.resultOnLog) return true
    }
    return false
  }

  /** 首段的未送达公告是否还没落盘：公告待写时，空段也要写一次再收。 */
  private noticePending(): boolean {
    return !this.noticeWritten && this.undelivered.length > 0
  }

  /** 本 prompt 的真实结束原因，优先级与 run() 一致：中止 > 失败分类 > 应答停止原因。 */
  private promptEnd(): StepEndReason {
    if (this.aborted) return abortedEnd()
    if (this.promptFailure !== undefined) {
      if (this.replayRode) {
        // The transcript rode this very prompt, so it is the likeliest reason
        // the agent refused it. Not classified further — any failure of a
        // prompt that carried the replay says so here.
        return {
          kind: 'error',
          error: {
            message: `历史回灌被拒绝：${messageOf(this.promptFailure)}`,
            code: 'REPLAY_REJECTED',
          },
        }
      }
      return failureEndOf(this.promptFailure)
    }
    return toEndReason(this.replyStop)
  }

  /**
   * 段收尾的 spawned 侧账：给 closeSegment 的剥离名单，加上日志上还缺的
   * 卡/结果补写事件。
   *
   * - 出生段补对：卡片不在日志上（实时写失败）且出生帧在本段——收段时按档案
   *   补 卡+此刻结果（已收尾给真输出，未收尾给 still running）。投影自身的
   *   spawned 事件已被剥离，不会双写。
   * - 末段收尾：对结果仍不在日志上的运行合成收尾——已收尾的给档案里的真输出，
   *   仍未收尾的合成 [still running]（此刻才允许，回合都要收场了）。卡不在
   *   日志时连卡一起补（防御：正常路径出生段已补过）。
   */
  private spawnedCloseBookkeeping(turn: TurnContext, final: boolean): {
    readonly ids: ReadonlySet<string>
    readonly pending: ReadonlySet<string>
    readonly tail: readonly ProjectionEvent[]
  } | undefined {
    const runs = this.spawnedRuns
    if (runs === undefined) return undefined
    const position = turn.position
    const tail: ProjectionEvent[] = []
    // A native delegation's `task` call can close its segment before the
    // spawned frame arrives (the dispatch call settles at dispatch time).
    // Until then its card/result belong to the run, not to the segment
    // projection — otherwise a premature result lands on the log. At the final
    // segment no birth can arrive any more, so an unpaired dispatch call is
    // projected normally instead of being dropped.
    const pendingNative = new Set<string>()
    if (!final) {
      for (const callId of this.subagentTools.keys()) {
        if (!runs.has(callId)) pendingNative.add(callId)
      }
    }
    if (position !== undefined) {
      for (const record of runs.values()) {
        if (!record.openInSegment || record.cardOnLog) continue
        tail.push(...this.spawnedBirthPair(record, position))
        record.cardOnLog = true
        record.resultOnLog = true
      }
      if (final) {
        for (const record of runs.values()) {
          if (record.resultOnLog) continue
          if (!record.cardOnLog) {
            tail.push(...this.spawnedBirthPair(record, position))
            record.cardOnLog = true
          }
          tail.push(projectSpawnedResult(
            record.settled ? record.call : { ...record.call, output: stillRunningText(record.call.output) },
            { turn: position.turn, step: position.step },
          ))
          record.resultOnLog = true
        }
      }
    }
    for (const record of runs.values()) record.openInSegment = false
    return { ids: new Set([...runs.keys(), ...pendingNative]), pending: pendingNative, tail }
  }

  /** 出生段收段时的补对：卡 + 此刻结果。公告由段消息自带的那块承担——未实时写的 id 的块会留在段消息里，且先于补卡。 */
  private spawnedBirthPair(record: SpawnedTrack, position: { readonly turn: number; readonly step: number }): readonly ProjectionEvent[] {
    const dialect = this.options.dialect
    if (dialect === undefined) return []
    // The record's call, not the birth frame: a delegation cursor dispatched
    // through a `task` call reuses that call's id/arguments here.
    const options = { turn: position.turn, step: position.step, dialect }
    const card = projectToolCall(record.call, options)
    const result = projectSpawnedResult(
      record.settled ? record.call : { ...record.call, output: stillRunningText(record.call.output) },
      position,
    )
    return [card, result]
  }

  /**
   * 收段：投影、落盘、收流。
   *
   * 投影先于写、写先于收流：闭合帧携带消息的序号，指向一条还没写的消息会让
   * 用户看到文字又消失。已实时写过的卡与结果在此剥离；未送达公告只随首段
   * 落盘（它在段事件之前展开，永不触碰消息的序号）。收完段帧清空——下一段
   * 从空段开始。run 路径的回合末也走这里：无条件 produce+write，回合末残余
   * 的补写语义保持现状；「空段不产事件」是 steps 路径末段的规则，由调用方
   * 在此之前把守。steps 路径传入 spawned 剥离名单时，投影自身的 spawned
   * 事件一律剥离——spawned 生命周期归泵持有，缺什么由泵的补写事件给出。
   */
  private closeSegment(
    turn: TurnContext,
    stream: TurnStreamHandle | undefined,
    liveCards: LiveCards | undefined,
    end: StepEndReason,
    spawned?: { readonly ids: ReadonlySet<string>; readonly pending?: ReadonlySet<string>; readonly tail: readonly ProjectionEvent[] },
    final = false,
  ): void {
    const position = turn.position
    // 段结束先封未知块：块不跨步骤，且必须排在段消息之前（消息是这一步的
    // 最后一条 assistant 消息，视图只保留它）。这里直接走 turn.write：run() 的
    // finally 在本调用之前已清空 liveCards，块不能依赖那个绑定。
    const live = liveCards
    if (live !== undefined) {
      const flushed = this.rawOutput?.flush({ turn: live.turn, step: live.step })
      if (flushed !== undefined) {
        try {
          turn.write([{ type: RAW_OUTPUT, payload: flushed }])
        } catch {
          // 日志拒绝这一块时丢弃它；段自己的写入与收流不受影响。
        }
      }
    }
    // 遥测汇总只在回合末写：中途闭段就倒出来会把过程区重新弄脏，而且卡片必须
    // 排在段消息之前（消息是这一步的最后一条 assistant 消息，视图只保留它）。
    if (final && live !== undefined) this.writeRawSummary(turn, { turn: live.turn, step: live.step })
    const notice = !this.noticeWritten && this.undelivered.length > 0 && position !== undefined
      ? [{
        type: UNDELIVERED,
        payload: {
          turn: position.turn,
          step: position.step,
          attachments: this.undelivered,
        },
      }]
      : []
    if (notice.length > 0) this.noticeWritten = true
    const result: AcpStepResult = {
      frames: [...this.frames],
      end,
      ...(stream === undefined ? {} : { stream: stream.records() }),
    }
    const produced = turn.produce(result)
    const filtered = liveCards === undefined ? produced : withoutLiveWritten(produced, liveCards)
    const owned = spawned === undefined ? filtered : withoutSpawnedRuns(filtered, spawned.ids)
    const events = [
      ...notice,
      // A pending native delegation's card is not written in this segment, so
      // its tool-call block must not be announced here either.
      ...(spawned?.pending === undefined ? owned : withoutAnnouncedIds(owned, spawned.pending)),
      ...(spawned?.tail ?? []),
    ]
    const seq = turn.write(events)
    if (stream === undefined) return
    if (seq === undefined) stream.abandon()
    else stream.settle('assistant/message', () => seq)
    // 段已归档：清空段帧，下一段（下一次调用的泵）从空段开始。边界帧从不在这
    // 里——它还留在队首，正等着归入新段。
    this.frames = []
  }

  /**
   * Listen for this turn's stop, so the agent is told and its late frames are
   * discarded.
   *
   * Returns the detacher, called when the prompt settles. Absent option, or
   * one that resolves to nothing for this turn, means no stop wiring — the
   * turn runs exactly as before.
   */
  private watchStop(sessionId: string): () => void {
    const signal = this.options.abort?.()
    if (signal === undefined) return () => {}
    const onStop = (): void => {
      this.aborted = true
      // 唤醒按段等待中的泵：中止要立刻把当前段当末段收掉。run 路径无人等待，
      // 是空操作。
      this.wakeup()
      // The host's stop does not reach the external process on its own;
      // without this notice the agent would keep generating into a turn
      // nobody is reading.
      try {
        this.client.notify('session/cancel', { sessionId })
      } catch {
        // A connection that died under the stop cannot be told; the turn
        // still ends aborted, and the next turn opens a fresh session.
      }
      this.closeOpenCards()
    }
    // Stopped before we listened: a turn opened onto a signal that had
    // already fired counts as stopped from its first moment.
    if (signal.aborted) onStop()
    else signal.addEventListener('abort', onStop, { once: true })
    return () => { signal.removeEventListener('abort', onStop) }
  }

  /**
   * Close every live card the stop leaves open, now, from the stop handler.
   *
   * The turn's final write is the other candidate for this job, but it runs
   * only when the prompt settles — and the stop's owner may end the turn
   * without the run: the in-place gateway settles its chunk stream from its
   * own watchdog, the loop closes the step, and a result arriving after that
   * boundary is either refused or lands outside every open step. The abort
   * listener runs synchronously before any of that, so this is the one place
   * guaranteed to still be inside the step. Results written here are marked
   * settled, which the turn-end strip already knows to honor.
   */
  private closeOpenCards(): void {
    const live = this.liveCards
    if (live === undefined) return
    const events: ProjectionEvent[] = []
    for (const callId of live.written) {
      if (live.settled.has(callId)) continue
      live.settled.add(callId)
      // A streamed card already shows its output; the abort note refines that
      // same result instead of replacing the only evidence of what ran.
      const streamed = live.streamed.has(callId) ? live.tools.get(callId)?.output ?? '' : ''
      const text = streamed.length === 0
        ? '外部 agent 回合被中止，这个调用没有等到结果。'
        : `${streamed}\n\n外部 agent 回合被中止，这个调用没有等到结果。`
      events.push({
        type: 'tool/result',
        payload: {
          turn: live.turn,
          step: live.step,
          message: {
            id: randomUUID(),
            role: 'tool',
            content: [{ type: 'text', text }],
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError: true,
          },
          error: { name: 'tool', code: 'aborted', reason: 'the turn was stopped before the call reported an end' },
        },
      })
    }
    if (events.length === 0) return
    try {
      live.write(events)
    } catch {
      // The log refused the closing writes; the turn-end strip still marks
      // them settled, and the frames after the stop never reach the log.
    }
  }

  /**
   * Open once per DSH session, and remember — including when the first attempt
   * failed.
   *
   * Keyed by the session that asked, so two conversations in the same preset do
   * not end up sharing one external conversation.
   */
  private open(dshSessionId: string): Promise<string> {
    if (this.dshSessionId !== undefined && this.dshSessionId !== dshSessionId) {
      // A different session asking: its own external conversation.
      return this.freshOpen(dshSessionId)
    }
    this.dshSessionId = dshSessionId
    return this.openingNow()
  }

  private async freshOpen(dshSessionId: string): Promise<string> {
    this.dshSessionId = dshSessionId
    this.sessionId = undefined
    return this.openingNow()
  }

  private openingNow(): Promise<string> {
    if (this.sessionId !== undefined) return Promise.resolve(this.sessionId)
    const ms = this.options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    let stage = 'initialize'
    this.opening ??= withDeadline(
      this.doOpen(value => { stage = value }),
      ms,
      () => `acp agent did not answer within ${String(ms)}ms（等待 ${stage}）`
        + (stage === 'authenticate' ? '；请检查外部 agent 的登录状态' : ''),
    ).then(
      sessionId => { this.sessionId = sessionId; this.opening = undefined; return sessionId },
      error => { this.opening = undefined; throw error },
    )
    return this.opening
  }

  private async doOpen(onStage: (stage: string) => void): Promise<string> {
    const capabilities = this.options.dialect?.capabilities
    const initializeResult = await this.client.request('initialize', {
      protocolVersion: 1,
      // `subagents` opts into the ACP subagent draft (#1992): adapters that
      // implement it (codex-acp, claude-agent-acp) then report subagent and
      // async-task lifecycle as native frames instead of folding the whole
      // run into one opaque tool call. Agents without the draft ignore the
      // field, so grok is unaffected.
      //
      // The released @agentclientprotocol/sdk STRIPS the draft field off
      // clientCapabilities at initialize (measured 2026-10-20: with only this
      // spelling, both adapters still surfaced delegations as ordinary tool
      // calls). The adapters' documented fallback is the `_meta.jetbrains.air`
      // extension — version 1 plus a capability list — which the schema
      // passes through, so both spellings ride the handshake: the meta one
      // works today, the canonical one wins once the SDK ships it.
      //
      // Cursor reads neither of those: it checks `clientCapabilities.subagents
      // || clientCapabilities._meta.subagents` (bundle 2026.10.01). Measured
      // 2026-10-21: only `_meta.subagents` turns on its spawn/state frames and
      // the parent's post-child resume; the top-level field alone is dropped
      // by the SDK before Cursor sees it. Sent for the dialects that read it.
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        subagents: {},
        _meta: {
          ...(capabilities?.metaSubagents === true ? { subagents: {} } : {}),
          jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] } },
        },
      },
    })
    this.client.notify('initialized', {})
    const authenticate = this.client.authenticate
    // Cursor must authenticate before session/new. Qoder must not: once its CLI
    // is logged in session/new succeeds without the round-trip, and its
    // authenticate intermittently stalls (measured 2026-10-20). Qoder opens
    // first and authenticates only when session/new refuses for lack of login.
    const onDemand = this.options.dialect?.authenticateOnDemand === true
    if (authenticate !== undefined && !onDemand) {
      onStage('authenticate')
      await authenticate(initializeResult)
    }
    const openSession = () => this.client.request('session/new', {
      cwd: this.options.cwd,
      mcpServers: [],
    })
    // A journaled external session gets one reattach attempt first: when it
    // works, the conversation continues exactly as the agent kept it — same
    // history, same model selection state — and the first prompt rides no text
    // replay. Anything else (no journal, dialect not measured for resume,
    // agent-side session gone) opens fresh through the ordinary path below.
    this.resumedLastOpen = false
    const journaled = this.dshSessionId !== undefined && this.options.dialect?.capabilities.supportsSessionResume === true
      ? this.options.resumeOf?.(this.dshSessionId)
      : undefined
    if (journaled !== undefined) {
      onStage('session/resume')
      try {
        const resumed = await this.client.request('session/resume', {
          sessionId: journaled,
          cwd: this.options.cwd,
          mcpServers: [],
        })
        this.resumedLastOpen = true
        this.appliedModelId = undefined
        this.appliedEffort = undefined
        this.modelConfigId = this.options.dialect?.modelConfigId?.(resumed)
        this.modelConfigValues = configValueAliases(resumed, this.modelConfigId)
        this.modelWireIds = reportedModelIds(resumed, this.options.dialect)
        this.currentModelId = reportedCurrentModelId(resumed)
        this.effortOption = reportedEffortOption(resumed)
        if (this.options.dialect !== undefined && this.options.onModels !== undefined) {
          this.options.onModels(this.options.dialect.readModels(resumed))
        }
        if (this.options.modeId !== undefined) {
          onStage('session/set_mode')
          await this.client.request('session/set_mode', { sessionId: journaled, modeId: this.options.modeId })
        }
        return journaled
      } catch {
        // The agent-side session is gone or refuses (its own retention, a CLI
        // update, another machine). Fall through: a fresh open plus the text
        // replay is the degraded-but-working path, and has been all along.
      }
    }
    onStage('session/new')
    let rawReply: unknown
    try {
      rawReply = await openSession()
    } catch (error) {
      if (authenticate === undefined || !onDemand || this.options.dialect?.sessionNeedsAuthenticate?.(error) !== true) {
        throw error
      }
      onStage('authenticate')
      await authenticate(initializeResult)
      onStage('session/new')
      rawReply = await openSession()
    }
    const reply = rawReply as { sessionId?: unknown } | null
    if (typeof reply?.sessionId !== 'string') {
      throw new Error('acp session/new returned no sessionId')
    }
    // A fresh session knows no model selection, whatever the last one had.
    this.appliedModelId = undefined
    this.appliedEffort = undefined
    this.modelConfigId = this.options.dialect?.modelConfigId?.(reply)
    this.modelConfigValues = configValueAliases(reply, this.modelConfigId)
    this.modelWireIds = reportedModelIds(reply, this.options.dialect)
    this.currentModelId = reportedCurrentModelId(reply)
    this.effortOption = reportedEffortOption(reply)
    // The picker serves what the agent reported; the dialect knows where the
    // list lives. Reported even when empty — an agent that serves nothing must
    // be able to replace whatever was believed before.
    if (this.options.dialect !== undefined && this.options.onModels !== undefined) {
      this.options.onModels(this.options.dialect.readModels(reply))
    }
    if (this.options.modeId !== undefined) {
      onStage('session/set_mode')
      await this.client.request('session/set_mode', { sessionId: reply.sessionId, modeId: this.options.modeId })
    }
    return reply.sessionId
  }

  /**
   * Apply a picked modelId the protocol's own way, once per actual change.
   *
   * `config_option` writes the model selector the agent advertised in
   * `session/new`; `set_model` calls the agent's legacy model method with the
   * picker's combined id, for an agent whose config-option selector rejects
   * those ids. Both are out-of-band writes ahead of the prompt, whose own
   * modelId param neither path's agents read. A failure propagates: a turn
   * that ran on a model the user did not pick is worse than a turn that ends
   * saying why the pick did not land.
   *
   * The reasoning effort the picker chose rides along: it is part of the pick,
   * and an agent that serves one id per effort wants it joined onto the model
   * id, while an agent that keeps the effort in its own option takes it there.
   */
  private async applyModel(sessionId: string, modelId: string, effort: string | undefined): Promise<void> {
    if (modelId === this.appliedModelId && effort === this.appliedEffort) return
    const via = this.options.dialect?.modelVia
    if (via === 'set_model') {
      const wireId = this.setModelWireId(modelId, effort)
      if (wireId === undefined) {
        throw new Error(this.setModelRefusal(modelId, effort))
      }
      await this.client.request('session/set_model', { sessionId, modelId: wireId })
    } else if (via === 'config_option' && this.modelConfigId !== undefined) {
      const value = resolveConfigValue(this.modelConfigValues, modelId)
      // An id that matches no value, name or base is not in the list the agent
      // just reported: the catalog moved on and the session's pick is gone.
      // Sending it only buys the agent's opaque `Invalid model value` and kills
      // the turn at its first request; end locally with the fix instead — the
      // fresh report already reached the catalog, so the user re-picks from it.
      if (value === undefined) {
        throw new Error(
          `模型 ${modelId} 已不在 agent 当前提供的模型列表中，请重新选择模型`,
        )
      }
      await this.client.request('session/set_config_option', {
        sessionId,
        configId: this.modelConfigId,
        value,
      })
      await this.applyEffortOption(sessionId, effort)
    } else {
      return
    }
    this.appliedModelId = modelId
    this.appliedEffort = effort
  }

  /**
   * The wire id to write for a `set_model` agent, or undefined when the pick
   * cannot be served.
   *
   * The picker sends a base plus an effort, because that is how the catalog
   * presents a model that advertises efforts. An agent that serves one id per
   * effort (codex) wants them joined again: `gpt-6-astra` + `xhigh` is
   * `gpt-6-astra[xhigh]`. A pick with no effort asks for the provider default,
   * which for such an agent is the model it reported as current — codex
   * publishes that as `gpt-6-astra[medium]` (live probe 2026-10-23) — and
   * only when that model is the one that was picked.
   */
  private setModelWireId(modelId: string, effort: string | undefined): string | undefined {
    const ids = this.modelWireIds
    // The agent named no models: there is nothing to judge the pick against.
    if (ids === undefined) return modelId
    // Exactly what the agent serves.
    if (ids.has(modelId)) return modelId
    const base = baseIdOf(modelId)
    // A suffixed id the agent does not serve: stale, nothing to compose.
    if (base !== modelId) return undefined
    if (effort !== undefined) {
      const suffixed = `${base}[${effort}]`
      return ids.has(suffixed) ? suffixed : undefined
    }
    const current = this.currentModelId
    if (current !== undefined && baseIdOf(current) === base && ids.has(current)) return current
    return undefined
  }

  /**
   * Why a pick could not be written, in the words the user can act on.
   *
   * codex advertises one entry per effort (`gpt-6-astra[low]`) and its
   * set_model rejects the bare base (live probe 2026-10-22: -32603
   * "Unsupported format ... Expected: modelId[effort]"). A bare pick whose base
   * is still served is not stale — it is missing the effort, and only the user
   * can choose one.
   */
  private setModelRefusal(modelId: string, effort: string | undefined): string {
    const ids = this.modelWireIds
    const base = baseIdOf(modelId)
    if (effort !== undefined) {
      return `模型 ${base}[${effort}] 已不在 agent 当前提供的模型列表中，请重新选择模型`
    }
    if (ids !== undefined && base === modelId && [...ids].some(id => baseIdOf(id) === base)) {
      return `模型 ${modelId} 需要先选择推理档位（agent 只接受带档位的模型 id）`
    }
    return `模型 ${modelId} 已不在 agent 当前提供的模型列表中，请重新选择模型`
  }

  /**
   * Write the picked effort through the agent's own effort selector, when it
   * published one. grok serves bare model ids and a separate `reasoning_effort`
   * option (live probe 2026-10-23), so the effort the user picked has to
   * reach that option — it cannot ride inside the model id.
   */
  private async applyEffortOption(sessionId: string, effort: string | undefined): Promise<void> {
    if (effort === undefined) return
    const option = this.effortOption
    // The agent carries the effort inside the model id, or published no
    // effort selector at all: there is nothing to write it to.
    if (option === undefined) return
    if (!option.values.has(effort)) {
      throw new Error(`推理档位 ${effort} 不在 agent 当前提供的档位列表中，请重新选择`)
    }
    await this.client.request('session/set_config_option', {
      sessionId,
      configId: option.configId,
      value: effort,
    })
  }

  /** True when the pick travels before the prompt instead of inside it. */
  private modelAppliedOutOfBand(): boolean {
    const via = this.options.dialect?.modelVia
    return via === 'config_option' || via === 'set_model'
  }
}

/**
 * Fail a handshake that never finishes.
 *
 * The timer is cleared on whichever side wins, so a turn that finished normally
 * does not leave a pending rejection behind to surface in an unrelated place.
 */
function withDeadline<T>(work: Promise<T>, ms: number, message: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(message())) }, ms)
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * The call id a tool/result answers, read off the PROJECTED payload.
 *
 * The id lives in `message.toolCallId` — the folded id the card carried and
 * the end-of-turn result carries, so the live settle and the turn-end strip
 * key on exactly the same string ("exactly once" by construction).
 */
function resultCallIdOf(event: ProjectionEvent): string | undefined {
  const message = recordOf(recordOf(event.payload)['message'])
  const callId = message['toolCallId']
  return typeof callId === 'string' ? callId : undefined
}

/** 回合被宿主停止时的结束原因——run 与 runSteps 共用同一文案。 */
function abortedEnd(): StepEndReason {
  return { kind: 'aborted', reason: 'the turn was stopped; the agent was asked to cancel' }
}

/**
 * The projection with the calls already written live removed.
 *
 * The live path files a one-block announcement before each card and the result
 * the moment a terminal frame arrives; those would be doubles here. An
 * unsettled id keeps its result, which is exactly the fallback the live write
 * counts on when its own write failed. Shared by run()'s turn-end write and
 * every segment close — one filter, one notion of "already on the log".
 */
function withoutLiveWritten(produced: readonly ProjectionEvent[], liveCards: LiveCards): readonly ProjectionEvent[] {
  return produced.flatMap(event => {
    if (event.type === 'assistant/message') return withoutAnnouncedToolBlocks(event, liveCards.written)
    if (event.type === 'tool/result') {
      const toolCallId = resultCallIdOf(event)
      // A streamed result is already on the log: the provider's late outcome
      // frame refines it in place, and a projected second result would be a
      // duplicate append the log refuses.
      return toolCallId !== undefined && (liveCards.settled.has(toolCallId) || liveCards.streamed.has(toolCallId))
        ? []
        : [event]
    }
    if (event.type !== 'tool/call') return [event]
    const callId = recordOf(event.payload)['callId']
    return typeof callId === 'string' && liveCards.written.has(callId) ? [] : [event]
  })
}

/**
 * steps 路径：spawned 运行的投影事件一律剥离。
 *
 * spawned 生命周期归泵全程持有——卡片实时写、收尾实时落结果、缺什么收段时由
 * 泵的补写事件给出。投影自身的 spawned 循环以「本段帧里有出生帧」为前提，跨
 * 段后它既看不见收尾帧也看不见子代输出，留下的只能是错误的 [still running]
 * 或凭空蒸发的结果——所以不管写没写过，一律剥离、由泵说了算。
 */
function withoutSpawnedRuns(events: readonly ProjectionEvent[], ids: ReadonlySet<string>): readonly ProjectionEvent[] {
  if (ids.size === 0) return events
  return events.filter(event => {
    if (event.type === 'tool/call') {
      const callId = recordOf(event.payload)['callId']
      return !(typeof callId === 'string' && ids.has(callId))
    }
    if (event.type === 'tool/result') {
      const callId = resultCallIdOf(event)
      return callId === undefined || !ids.has(callId)
    }
    return true
  })
}

/**
 * Strip the tool-call blocks of the given calls from assistant messages.
 *
 * The counterpart of `withoutLiveWritten` for calls whose card is deferred to
 * a later segment: the card event is stripped from this segment, so the block
 * that announces it must go too, or the step advertises a call it never files.
 */
function withoutAnnouncedIds(events: readonly ProjectionEvent[], ids: ReadonlySet<string>): readonly ProjectionEvent[] {
  if (ids.size === 0) return events
  return events.flatMap(event => event.type === 'assistant/message' ? withoutAnnouncedToolBlocks(event, ids) : [event])
}

/**
 * The end-of-turn message with the calls already announced live removed.
 *
 * The live path files a one-block announcement before each card, so those
 * `tool-call` blocks are already in the log; leaving them in the step's message
 * too would register the same call twice, which the log rejects. Only the
 * blocks for calls written live are dropped — a call whose live write failed
 * keeps its block here, so its card (filed at turn end) still has an
 * announcement ahead of it. A message left with nothing but dropped blocks is
 * removed entirely; the answer text, if any, is kept.
 */
function withoutAnnouncedToolBlocks(event: ProjectionEvent, written: ReadonlySet<string>): ProjectionEvent[] {
  if (event.type !== 'assistant/message') return [event]
  const payload = event.payload as Record<string, unknown>
  const message = payload['message'] as Record<string, unknown> | undefined
  const content = message?.['content']
  if (!Array.isArray(content)) return [event]
  const kept = content.filter(block => {
    const b = block as { type?: unknown; id?: unknown }
    if (b?.type !== 'tool-call') return true
    return !(typeof b.id === 'string' && written.has(b.id))
  })
  if (kept.length === content.length) return [event]
  if (kept.length === 0) return []
  return [{ ...event, payload: { ...payload, message: { ...(message as Record<string, unknown>), content: kept } } }]
}