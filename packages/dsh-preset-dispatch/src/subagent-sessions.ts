/**
 * 外部 agent 的子代理 → DSH 子会话（只展示，不执行）。
 *
 * 外部 agent 派出的子代理运行在它自己的进程里；我们只在线上收到它的出生帧、
 * 正文/思考增量与终态帧。这里把收到的这些投影成一个真实 DSH 子会话：
 * 带父会话血缘、登记进父会话的后代目录、内容经实时流与持久消息展示。
 *
 * 两条语义边界是刻意的：
 * - **等真实终态**：只有终态帧才结束子会话；父回合先结束时它保持开放（用户
 *   选择的行为），不伪造结束。
 * - **无能力包零写入**：宿主没有组合子代理能力包时，不建会话、不写目录事件
 *   （未知事件会让会话日志加载不了）。
 */

import { randomUUID } from 'node:crypto'
import type { AcpDialect } from '@threadharbor/dsh-acp-agent'
import { RawOutputAggregator } from '@threadharbor/dsh-acp-agent'
import { AcpAssistantStream } from './stream.ts'

/** 子会话 id 前缀：与 DSH 自身 minted 的会话 id 区分开，且来源一眼可见。 */
const CHILD_PREFIX = 'acp-sub-'

/** 目录事件的模式：一次性子代理（不可续聊）。 */
const CATALOG_MODE = 'one-shot'

/** 目录事件格式版本（与宿主 subagent 包的当前版本一致）。 */
const CATALOG_VERSION = 0

/** 子代理消息的模型来源：它没有 DSH 模型，这个标识表明来源。 */
const PROVIDER = 'acp-subagent'

/** 子会话里的单回合计号。 */
const TURN = 1
const STEP = 1

/** Minimal host handle for one shadow child session. */
export type ChildSessionLike = {
  readonly id: string
  readonly header?: { readonly createdAt?: number }
  append(type: string, payload: unknown, intent?: unknown): { readonly seq: number }
  /** 事件计数，供合成流载荷的 session.seq 使用。 */
  readonly seq: number
}

/** What the builder needs from the host. */
export type SubagentSessionHost = {
  readonly available: boolean
  /** 建带血缘的子会话；宿主无能力包时返回 undefined（调用方据此跳过）。 */
  openChild(parentSessionId: string, childId: string): ChildSessionLike | undefined
  /** 往父会话日志追加一条事件（目录事件走这里）。 */
  appendParent(parentSessionId: string, type: string, payload: unknown): void
  /** 为子会话发一帧实时流（载荷形状由宿主适配）。 */
  emitChildStream(child: ChildSessionLike, frame: Record<string, unknown>): void
}

type ChildState = {
  readonly rawId: string
  readonly child: ChildSessionLike
  readonly stream: AcpAssistantStream
  readonly thought: string[]
  readonly text: string[]
  readonly aggregator: RawOutputAggregator
  settled: boolean
}

/** 一个外部回合里收到的子代理信息，投影成 DSH 子会话。 */
export class SubagentSessions {
  private readonly host: SubagentSessionHost
  private readonly dialect: AcpDialect
  private readonly states = new Map<string, ChildState>()
  /** 无 id 的出生帧留下的标签（grok）：等到首条子会话帧再建会话。 */
  private pending: { readonly label: string; readonly task: string } | undefined

  constructor(host: SubagentSessionHost, dialect: AcpDialect) {
    this.host = host
    this.dialect = dialect
  }

  /** 出生帧：有 id 立即建会话；无 id 记下标签等首次子会话帧。 */
  spawn(parentSessionId: string, childId: string | undefined, label: string, task: string): void {
    if (!this.host.available) return
    if (childId === undefined) {
      this.pending = { label, task }
      return
    }
    this.ensure(parentSessionId, childId, label, task)
  }

  /** 子会话正文/思考增量：懒建会话 + 实时流。 */
  chunk(parentSessionId: string, childSessionId: string, kind: 'thought' | 'message', text: string): void {
    if (!this.host.available || text === '') return
    const pending = this.pending
    const state = this.ensure(
      parentSessionId,
      childSessionId,
      pending?.label ?? childSessionId,
      pending?.task ?? '',
    )
    if (state === undefined) return
    this.pending = undefined
    // 收尾之后迟到的增量（子代理先报终态、帧后到）：流已关闭，丢弃即可——
    // 往已结束的流里推增量会抛，帧处理器不能被一条晚到帧打死。
    if (state.settled || state.stream.finished) return
    if (kind === 'thought') state.thought.push(text)
    else state.text.push(text)
    if (kind === 'thought') state.stream.reasoningDelta(text)
    else state.stream.textDelta(text)
  }

  /** 真实终态：落最后一段消息 + 结束子回合。 */
  terminal(parentSessionId: string, childSessionId: string, status: 'completed' | 'failed', output: string | undefined): void {
    if (!this.host.available) return
    const pending = this.pending
    const state = this.ensure(
      parentSessionId,
      childSessionId,
      pending?.label ?? childSessionId,
      pending?.task ?? '',
    )
    if (state === undefined || state.settled) return
    this.pending = undefined
    state.settled = true
    const content = [
      ...(state.thought.length > 0 ? [{ type: 'reasoning' as const, text: state.thought.join('') }] : []),
      ...(state.text.length > 0 ? [{ type: 'text' as const, text: state.text.join('') }] : []),
    ]
    const messageSeq = state.child.append('assistant/message', {
      turn: TURN,
      step: STEP,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content,
        source: { kind: 'model', provider: PROVIDER, model: this.dialect.id },
      },
      stream: state.stream.records(),
    }, { surfaceOp: 'append' }).seq
    state.child.append('step/end', { turn: TURN, step: STEP })
    state.child.append('turn/end', {
      turn: TURN,
      reason: status === 'completed'
        ? { kind: 'completed' }
        : { kind: 'error', error: { message: output ?? '子代理未完成', code: 'SUBAGENT_FAILED' } },
    })
    if (!state.stream.finished) state.stream.settle('assistant/message', () => messageSeq)
  }

  /** 父回合结束：只放弃实时流，子会话保持开放（不写 turn/end）。 */
  parentTurnEnd(parentSessionId: string): void {
    void parentSessionId
    for (const state of this.states.values()) {
      if (!state.settled && !state.stream.finished) state.stream.abandon()
    }
  }

  /** 该子会话的未知块聚合器（子会话帧里未映射的内容走它）。 */
  rawOutputOf(childSessionId: string): RawOutputAggregator | undefined {
    return this.stateOf(childSessionId)?.aggregator
  }

  private stateOf(rawOrPrefixed: string): ChildState | undefined {
    return this.states.get(rawOrPrefixed.startsWith(CHILD_PREFIX) ? rawOrPrefixed : CHILD_PREFIX + rawOrPrefixed)
  }

  private ensure(parentSessionId: string, rawId: string, label: string, task: string): ChildState | undefined {
    const prefixed = CHILD_PREFIX + rawId
    const existing = this.states.get(prefixed)
    if (existing !== undefined) return existing
    const child = this.host.openChild(parentSessionId, prefixed)
    if (child === undefined) return undefined
    child.append('turn/start', { turn: TURN })
    child.append('step/start', { turn: TURN, step: STEP })
    const prompt = task !== '' ? task : label
    if (prompt !== '') {
      child.append('user/message', {
        turn: TURN,
        message: {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        },
      }, { surfaceOp: 'append' })
    }
    this.host.appendParent(parentSessionId, 'subagent/catalog', {
      version: CATALOG_VERSION,
      childId: prefixed,
      childCreatedAt: child.header?.createdAt ?? Date.now(),
      mode: CATALOG_MODE,
      label,
    })
    let revision = 0
    const stream = new AcpAssistantStream({
      emit: frame => { this.host.emitChildStream(child, frame) },
      nextRevision: () => ++revision,
      sessionId: child.id,
      attempt: 1,
      turn: TURN,
      step: STEP,
    })
    stream.start()
    const state: ChildState = {
      rawId,
      child,
      stream,
      thought: [],
      text: [],
      aggregator: new RawOutputAggregator(),
      settled: false,
    }
    this.states.set(prefixed, state)
    return state
  }
}
