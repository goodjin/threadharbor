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
/**
 * cursor 通知方法的可读格式化（字段结构来自官方文档 cursor.com/docs/cli/acp.md，
 * 2026-10-21 核对）。待办更新是过程计划的唯一来源；generate_image 报告图片产物。
 * `cursor/task` 不在此列：真机上它既是一张派发工具卡、又有原生
 * `subagent_spawned` 帧，再展示一条「任务完成」既重复又把派发时延说成完成
 * （durationMs 在派发帧上只有 0.1–1s）——归类为专用方法，由子代理卡片承担。
 */
const CURSOR_NOTIFICATION_FORMATTERS: Readonly<Record<string, {
  readonly kind: string
  format: (params: Record<string, unknown>) => string
}>> = {
  'cursor/update_todos': {
    kind: 'cursor 待办',
    format: params => {
      const todos = Array.isArray(params['todos']) ? params['todos'].map(recordOf) : []
      const merge = params['merge'] === true ? '合并' : '替换'
      const marks: Record<string, string> = { completed: '✓', in_progress: '▶', cancelled: '✗' }
      const items = todos.map(todo => {
        const status = typeof todo['status'] === 'string' ? todo['status'] : ''
        const mark = marks[status] ?? '○'
        const content = typeof todo['content'] === 'string' ? todo['content'] : ''
        return `${mark} ${content}`
      })
      return `待办（${merge}）：${items.join('  ')}`
    },
  },
  'cursor/generate_image': {
    kind: 'cursor 生成图片',
    format: params => {
      const description = typeof params['description'] === 'string' ? params['description'] : ''
      const filePath = typeof params['filePath'] === 'string' ? ` → ${params['filePath']}` : ''
      return `生成图片：${description}${filePath}`
    },
  },
}

const DEDICATED_METHODS = new Set([
  'session/request_permission',
  // cursor 的阻塞式提问与计划请求由各自的流程回答（client.ts 的扩展处理），
  // 不是「看不懂的输出」，不能进未知块。
  'cursor/ask_question',
  'cursor/create_plan',
  // 子代理派发有卡片（task 工具 + 原生 spawned 帧），不是未知输出。真机上
  // 它虽以请求形式到达（2026-10-21），factory 也已应答；通知形式按契约无需
  // 应答，同样不该在过程区留一块。
  'cursor/task',
])

/** 默认单块上限：超过就在同一连续段内切块，转录不会被一行巨物撑爆。 */
const DEFAULT_MAX_BYTES = 8192

/**
 * 协议记账帧：原生从不展示它们，实时铺在过程区只会把转录淹掉。
 *
 * 它们仍会被保存——但按种类汇总到回合末尾，一块一行种类名；这样「所有输出都
 * 可见」和「过程区保持原生观感」同时成立。
 */
const TELEMETRY_KINDS = new Set([
  'usage_update',
  'session_info_update',
  'available_commands_update',
  // cursor 的模式切换（agent/ask/...）：和遥测一样只在回合末汇总，过程区不留噪音。
  'current_mode_update',
])

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
  // cursor 的三种通知方法有可读格式（文档结构已知），其余厂商方法原样展示。
  const notification = CURSOR_NOTIFICATION_FORMATTERS[frame.method]
  if (notification !== undefined) {
    return { kind: notification.kind, format: 'text' as const, line: notification.format(recordOf(frame.params)) }
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
  /** 遥测帧按种类攒到回合末：种类 → 段起点 + 行。 */
  private readonly telemetry = new Map<string, { position: { readonly turn: number; readonly step: number }; lines: string[]; bytes: number }>()

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
    // 遥测帧：不进实时段、也不打断别人的连续段，只攒到回合末汇总。
    if (TELEMETRY_KINDS.has(classified.kind)) {
      const tally = this.telemetry.get(classified.kind)
      if (tally === undefined) {
        this.telemetry.set(classified.kind, { position, lines: [classified.line], bytes: Buffer.byteLength(classified.line) })
      } else {
        tally.lines.push(classified.line)
        tally.bytes += Buffer.byteLength(classified.line)
      }
      return undefined
    }
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

  /**
   * 回合末汇总：每种遥测帧一块，按首次出现的顺序。
   *
   * 调用后清空汇总（一个回合只发一次）。位置**盖写出时**的 turn/step：汇总块
   * 总在最后一段写出，日志只接纳与「当前打开的步骤」一致的 tool 事件——沿用
   * 首次出现的位置（更早的步骤）会让整份日志加载不了。
   */
  summary(position: { readonly turn: number; readonly step: number }): readonly RawOutputBlock[] {
    const blocks: RawOutputBlock[] = []
    for (const [kind, tally] of this.telemetry) {
      blocks.push({
        turn: position.turn,
        step: position.step,
        kind,
        format: 'json',
        content: [`（${String(tally.lines.length)} 帧）`, ...tally.lines].join('\n'),
        count: tally.lines.length,
      })
    }
    this.telemetry.clear()
    return blocks
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
