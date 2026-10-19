/**
 * 未映射帧的分块器：把没被投影成内容的帧聚成「未知输出块」。
 *
 * 外部 agent 的会话更新种类会继续增长（厂商私有方法、命令列表、用量、计划……），
 * 投影只认识其中一部分。看不懂的帧不能丢——用户要看到它说了什么——但也不能逐帧
 * 铺满转录。这里定两条规矩：只合并**连续同类**帧（界面时间顺序不能被聚合打乱），
 * 以及块不跨步骤（块的位置就是它所属步骤的起点）。
 *
 * 纯逻辑：不碰会话、不写日志，写出时机由调用方决定。
 */

import type { AcpFrame } from './acp-client.ts'

/** 一个已闭合的未知输出块，内容按「首行帧数 + 每帧一行」拼好。 */
export type RawOutputBlock = {
  readonly turn: number
  readonly step: number
  readonly kind: string
  readonly format: 'json' | 'text'
  /** 首行「（N 帧）」，其后每帧一行。 */
  readonly content: string
  readonly count: number
}

/** 一帧的归类结果：块、已映射（不在这里展示）或不是它的输出。 */
export type RawOutputClassification =
  | { readonly kind: string; readonly format: 'json' | 'text'; readonly line: string }
  | 'mapped'
  | undefined

/** 投影已经吸收的会话更新种类：再展示一次就是重复。 */
const MAPPED_KINDS = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'subagent_spawned',
  'subagent_state_update',
  'async_task_spawned',
  'async_task_progress',
  'async_task_state_update',
  'user_message_chunk',
])

/** 自带卡片/审批展示的请求：由各自的面板负责，不是未知输出。 */
const DEDICATED_METHODS = new Set(['session/request_permission', 'cursor/ask_question'])

/** 默认单块上限：超过就在同一连续段内切块，转录不会被一行巨物撑爆。 */
const DEFAULT_MAX_BYTES = 8192

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * 给一帧归类。
 *
 * 归类不看方言：私有方法包装里若带已映射的 `sessionUpdate` 种类，也算已映射——
 * 那种帧的内容已经进了正文/卡片，再进未知块就是重复展示。
 */
export function classifyRawOutput(
  frame: AcpFrame,
  context: { readonly childSession: boolean },
): RawOutputClassification {
  void context
  // 有 id 无方法 = 我们某个请求的应答。它是协议回话，不是对方的内容输出。
  if (frame.method === undefined) return undefined
  const update = recordOf(recordOf(frame.params)['update'])
  const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (kind !== '' && MAPPED_KINDS.has(kind)) return 'mapped'
  if (DEDICATED_METHODS.has(frame.method)) return undefined
  if (frame.method.startsWith('fs/') || frame.method.startsWith('terminal/')) {
    // 它请求我们读文件/跑终端：展示请求摘要（不含我们回给它的内容）。
    return {
      kind: frame.method,
      format: 'text',
      line: JSON.stringify({ method: frame.method, params: frame.params }),
    }
  }
  if (frame.method === 'session/update') {
    return { kind: kind === '' ? frame.method : kind, format: 'json', line: JSON.stringify(update) }
  }
  // 厂商私有方法与未知请求：原样展示，种类用方法名。
  return { kind: frame.method, format: 'json', line: JSON.stringify({ method: frame.method, params: frame.params }) }
}

type Run = {
  readonly kind: string
  readonly format: 'json' | 'text'
  readonly position: { readonly turn: number; readonly step: number }
  readonly lines: string[]
  bytes: number
}

/** 连续同类帧的累积器；一切写出动作由调用方按返回的块执行。 */
export class RawOutputAggregator {
  private readonly maxBytes: number
  private run: Run | undefined

  constructor(options?: { readonly maxBytes?: number }) {
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  }

  /**
   * 喂一帧。
   *
   * 返回值是「必须在本帧之前写入」的已闭合块：本帧打断了当前连续段（不同种类、
   * 已映射帧）或加入本帧会超过上限时。应答/审批帧既不闭段也不入块。
   */
  observe(
    frame: AcpFrame,
    position: { readonly turn: number; readonly step: number },
    context: { readonly childSession: boolean },
  ): RawOutputBlock | undefined {
    const classified = classifyRawOutput(frame, context)
    if (classified === undefined) return undefined
    if (classified === 'mapped') return this.close()
    if (this.run !== undefined && this.run.kind !== classified.kind) {
      const closed = this.close()
      this.start(classified, position)
      return closed
    }
    if (this.run === undefined) {
      this.start(classified, position)
      return undefined
    }
    const bytes = Buffer.byteLength(classified.line)
    if (this.run.bytes + bytes > this.maxBytes) {
      const closed = this.close()
      this.start(classified, position)
      return closed
    }
    this.run.lines.push(classified.line)
    this.run.bytes += bytes
    return undefined
  }

  /** 步骤/回合结束：闭合当前连续段（块用段起点的位置）。 */
  flush(position: { readonly turn: number; readonly step: number }): RawOutputBlock | undefined {
    void position
    return this.close()
  }

  private start(classified: { kind: string; format: 'json' | 'text'; line: string }, position: { turn: number; step: number }): void {
    this.run = {
      kind: classified.kind,
      format: classified.format,
      position,
      lines: [classified.line],
      bytes: Buffer.byteLength(classified.line),
    }
  }

  private close(): RawOutputBlock | undefined {
    const run = this.run
    if (run === undefined) return undefined
    this.run = undefined
    return {
      turn: run.position.turn,
      step: run.position.step,
      kind: run.kind,
      format: run.format,
      content: [`（${String(run.lines.length)} 帧）`, ...run.lines].join('\n'),
      count: run.lines.length,
    }
  }
}
