/**
 * 读 codex 自己的日志，判断它是否还在推进。
 *
 * 为什么需要第二只看门狗：codex 在回合中途压缩上下文时**一个 ACP 帧都不发**
 * （2026-10-27 实测：240k token 触发 MidTurn auto-compact，四分钟里线上零帧，
 * 插件按「静默」把回合杀掉，而它其实每隔 30 秒都在日志里报一次 compaction）。
 * 帧静默不等于 agent 静默，日志是同一时刻唯一还在跳的信号。
 *
 * 只读、只认这只外部会话的 thread（ACP session id 就是 codex 的 thread id），
 * 只在帧已经安静时才被调用。日志缺席、Node 没有 node:sqlite、表结构不认识——
 * 一律当「没有这层信号」处理，绝不影响回合本身。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 一行日志，字段只留判断需要的。 */
export type ProgressRow = {
  readonly id: number
  readonly at: number
  readonly target: string
  readonly body: string
}

/** 一次「还在推进」的读数；`key` 用于去重提示。 */
export type ProgressReading = {
  readonly at: number
  readonly key: string
  readonly label: string
}

/**
 * 一只会话的增量读取器。
 *
 * 首次 `read()` 之前游标已停在当时的末尾：打开会话时补读历史，会把十分钟前
 * 的旧行当成「刚刚还在动」，看门狗就永远不响。
 */
export type ProgressReader = { read(): readonly ProgressRow[] }

/** 按会话 id 拿读取器；返回 undefined 表示这层信号不可用。 */
export type ProgressSource = (sessionId: string) => ProgressReader | undefined

export type ProgressProbe = {
  /** 自上次调用以来的新读数；没有新行、全是噪音或信号不可用时 undefined。 */
  read(sessionId: string): ProgressReading | undefined
  close(): void
}

/**
 * 不算进展的日志目标。
 *
 * `codex_http_client` 是网络重试的碎念——2026-10-16 那次事故里它每几十秒打一行
 * 「tls handshake eof」打了十分钟，把死回合说得像活的。`feedback_tags` 是每条
 * 事件附带的标签行，真事件另有自己的行。连接建立/关闭同样不算干活的证据。
 */
const NOISE_TARGETS = new Set([
  'feedback_tags',
  'rmcp::service',
  'codex_core::shell_snapshot',
  'codex_core::client',
  'codex_core::session::session',
  'codex_models_manager::manager',
  'codex_models_manager::cache',
])

const NOISE_PREFIXES = [
  'codex_http_client',
  'codex_api::endpoint',
]

function isNoise(target: string): boolean {
  return NOISE_TARGETS.has(target) || NOISE_PREFIXES.some(prefix => target.startsWith(prefix))
}

/**
 * 一行日志说明 agent 在干什么，或者它只是碎念。
 *
 * 认不出的目标按「在活动」算：新增一种日志胜过把一段真进展当成静默——用户要
 * 的是别被误杀，不是给日志种类做白名单。
 */
export function classifyProgressRow(row: ProgressRow): { key: string; label: string } | undefined {
  if (isNoise(row.target)) return undefined
  if (row.body.includes('run_auto_compact') || row.body.includes('response.compaction')) {
    return { key: 'compaction', label: 'codex 正在压缩上下文' }
  }
  if (row.target === 'codex_core::tools::parallel') {
    return { key: 'tool', label: 'codex 正在执行工具' }
  }
  if (row.target === 'codex_core::stream_events_utils') {
    return { key: 'model', label: 'codex 正在生成输出' }
  }
  if (row.target.startsWith('codex_otel.agent_communication') || row.body.includes('inter_agent_communication')) {
    return { key: 'agent', label: 'codex 的子代理在活动' }
  }
  return { key: `log:${row.target}`, label: `codex 日志活动：${row.target}` }
}

/** A probe over an injected source; tests drive it with in-memory rows. */
export function createProgressProbe(source: ProgressSource): ProgressProbe {
  const readers = new Map<string, ProgressReader>()
  return {
    read(sessionId) {
      let reader = readers.get(sessionId)
      if (reader === undefined) {
        reader = source(sessionId)
        if (reader === undefined) return undefined
        readers.set(sessionId, reader)
      }
      let rows: readonly ProgressRow[]
      try {
        rows = reader.read()
      } catch {
        readers.delete(sessionId)
        return undefined
      }
      // 从新到旧找第一条有意义的行：最新那一行是噪音时，它前面一行仍可能
      // 说明 agent 在干活。
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!
        const reading = classifyProgressRow(row)
        if (reading !== undefined) return { at: row.at, ...reading }
      }
      return undefined
    },
    close() {
      readers.clear()
    },
  }
}

type SqliteStatement = {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement
  close(): void
}

type SqliteCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase

type LogRow = { id: number; ts: number; ts_nanos: number; target: string; feedback_log_body: string | null }

/**
 * codex 的日志库（`~/.codex/logs_2.sqlite`）作为来源。
 *
 * Node 22.5 起 `node:sqlite` 是内置模块，22.5 之前没有——用 getBuiltinModule
 * 探测而不是静态 import，宿主跑在旧 Node 上时这层信号直接缺席，插件照常工作。
 * 只读打开：绝不因为看进度而改动 codex 的库。
 */
function sqliteSource(): ProgressSource | undefined {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  const sqlite = getBuiltin?.('node:sqlite') as { DatabaseSync?: SqliteCtor } | undefined
  const DatabaseSync = sqlite?.DatabaseSync
  if (DatabaseSync === undefined) return undefined
  const home = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
  const path = join(home, 'logs_2.sqlite')
  if (!existsSync(path)) return undefined

  let db: SqliteDatabase | undefined
  const database = (): SqliteDatabase | undefined => {
    if (db !== undefined) return db
    try {
      db = new DatabaseSync(path, { readOnly: true })
    } catch {
      db = undefined
    }
    return db
  }
  return sessionId => {
    const handle = database()
    if (handle === undefined) return undefined
    try {
      const newest = handle.prepare('select max(id) as id from logs where thread_id = ?').get(sessionId) as
        | { id?: unknown }
        | undefined
      // 游标先停在现存末尾：历史行属于过去，不该拿来证明「现在还在动」。
      let cursor = typeof newest?.id === 'number' ? newest.id : 0
      const page = handle.prepare(
        'select id, ts, ts_nanos, target, feedback_log_body from logs where thread_id = ? and id > ? order by id desc limit 200',
      )
      return {
        read: () => {
          const rows = page.all(sessionId, cursor) as LogRow[]
          if (rows.length === 0) return []
          const newestRow = rows[0]!
          cursor = Math.max(cursor, newestRow.id)
          // 查询按新到旧，读数按时间顺序交出去（调用方从尾部找最新一条）。
          return rows.reverse().map(row => ({
            id: row.id,
            at: row.ts * 1000 + Math.floor((row.ts_nanos ?? 0) / 1_000_000),
            target: row.target,
            body: row.feedback_log_body ?? '',
          }))
        },
      }
    } catch {
      return undefined
    }
  }
}

/**
 * codex 进度探针；宿主环境里没有可用的日志源时返回 undefined。
 *
 * `source` 仅供测试注入——生产路径永远走只读 SQLite。
 */
export function codexProgressProbe(options?: { readonly source?: ProgressSource }): ProgressProbe | undefined {
  const source = options?.source ?? sqliteSource()
  if (source === undefined) return undefined
  return createProgressProbe(source)
}
