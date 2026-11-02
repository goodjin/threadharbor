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

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
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
export type ProgressRowClassifier = (row: ProgressRow) => { key: string; label: string } | undefined

export function createProgressProbe(
  source: ProgressSource,
  classify: ProgressRowClassifier = classifyProgressRow,
): ProgressProbe {
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
        const reading = classify(row)
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

// ---------------------------------------------------------------------------
// qoder: 读它自己的会话段日志，判断它是否还在推进。
//
// 为什么需要第二只看门狗（qoder 这一版）：codex 在回合中途压缩上下文时一个 ACP
// 帧都不发；qoder 执行长工具（下载/构建/测试）期间同样一个帧都不发——模型请求
// 期间思考帧照常流，不发帧的是工具在跑的那段（2026-10-28 桌面版现场：一个
// python 测速跑了两分钟被杀，静默期段日志里只有 `tool.shell.started`，没有
// `model.*`）。帧静默不等于 agent 静默。
//
// 与 codex 的差别只在「日志长什么样、怎么读」：codex 读 SQLite，qoder 读
// `<config>/logs/sessions/<project>/<sessionId>/segments/<ts>.jsonl`——
// 一段一个文件，按 mtime 取最新那段；行是 JSON，带 `ts`（ISO）与 `type`。
// 分类逻辑（哪些 type 算进展）单独抽出，游标与增量读取复用 createProgressProbe。
// ---------------------------------------------------------------------------

/** qoder 段日志里算「还在干活」的记录类型；其余当噪音或无关。 */
const QODER_PROGRESS_TYPES = new Set([
  'turn.started',
  'loop.iteration.started',
  'loop.iteration.finished',
  'model.request.started',
  'model.response.completed',
  'tool.requested',
  'tool.shell.started',
  'tool.shell.backgrounded',
])

/** qoder 段日志行；只取分类与游标需要的字段。 */
type QoderSegmentRow = {
  seq?: unknown
  ts?: unknown
  type?: unknown
}

/** ISO 串 → epoch 毫秒；解析失败回 0（排到最旧，不影响判定）。 */
function qoderRowAt(ts: unknown): number {
  if (typeof ts !== 'string') return 0
  const at = Date.parse(ts)
  return Number.isNaN(at) ? 0 : at
}

/**
 * 一段 qoder 段日志的分类器。
 *
 * 认不出的类型按「噪音」跳过：新增的 phase 类型（如 attachment/hook 碎念）不该
 * 把死回合说成活——真进展由 QODER_PROGRESS_TYPES 里那几类明确背书。
 */
export function classifyQoderRow(row: ProgressRow): { key: string; label: string } | undefined {
  let parsed: QoderSegmentRow
  try {
    parsed = JSON.parse(row.body) as QoderSegmentRow
  } catch {
    return undefined
  }
  if (typeof parsed.type !== 'string') return undefined
  if (!QODER_PROGRESS_TYPES.has(parsed.type)) return undefined
  const label = qoderLabel(parsed.type)
  return { key: `qoder:${parsed.type}`, label }
}

function qoderLabel(type: string): string {
  switch (type) {
    case 'turn.started': return 'qoder 正在开始新回合'
    case 'loop.iteration.started': return 'qoder 正在推进一轮'
    case 'loop.iteration.finished': return 'qoder 正在收尾一轮'
    case 'model.request.started': return 'qoder 正在等待模型回答'
    case 'model.response.completed': return 'qoder 正在生成输出'
    case 'tool.requested': return 'qoder 正在执行工具'
    case 'tool.shell.started': return 'qoder 正在跑命令'
    case 'tool.shell.backgrounded': return 'qoder 正在后台跑命令'
    default: return `qoder 日志活动：${type}`
  }
}

/** qoder 配置目录：官方 `QODERCN_CONFIG_DIR`，缺省本机 `~/.qoder-cn`。 */
function qoderHome(): string {
  return process.env['QODERCN_CONFIG_DIR'] ?? join(homedir(), '.qoder-cn')
}

/** 该会话当前最新一段段日志的路径；会话还没落日志时 undefined。 */
function newestSegmentPath(sessionId: string): string | undefined {
  const sessionsRoot = join(qoderHome(), 'logs', 'sessions')
  if (!existsSync(sessionsRoot)) return undefined
  // 段日志按 <project>/<sessionId>/segments/<ts>.jsonl 存；project 名是工作目录
  // 编码，DSH 不知道，只能遍历。会话目录只有一个，命中即停。
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(sessionsRoot)
  } catch {
    return undefined
  }
  for (const project of projectDirs) {
    const segmentsDir = join(sessionsRoot, project, sessionId, 'segments')
    if (!existsSync(segmentsDir)) continue
    let files: string[]
    try {
      files = readdirSync(segmentsDir).filter(name => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    let newest: { name: string; mtime: number } | undefined
    for (const name of files) {
      try {
        const mtime = statSync(join(segmentsDir, name)).mtimeMs
        if (newest === undefined || mtime > newest.mtime) newest = { name, mtime }
      } catch {
        // 一段刚被删/换名，跳过。
      }
    }
    if (newest !== undefined) return join(segmentsDir, newest.name)
  }
  return undefined
}

/**
 * 按会话 id 拿 qoder 段日志读取器。
 *
 * 首次 read 之前游标停在文件当时的末尾：打开会话就把历史行当「刚刚还在动」，
 * 看门狗就永远不响——与 codex 同一个坑。段文件在回合进行中会被追加，按字节
 * 偏移游标增量读；文件被换名（新一轮）时回到新文件从头读。
 */
function qoderSegmentSource(): ProgressSource {
  return sessionId => {
    const path = newestSegmentPath(sessionId)
    if (path === undefined) return undefined
    let cursor = 0
    let primed = false
    const read = (): readonly ProgressRow[] => {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return []
      }
      // 文件被换/截断：从新文件头重读，并重新 primed。
      if (text.length < cursor) {
        cursor = 0
        primed = false
      }
      // 首次接入：游标停在当时末尾，历史行不算「刚刚还在动」——否则打开会话
      // 就把十分钟前的旧行当进展，看门狗永远不响（与 codex 同一个坑）。停在
      // 最后一个换行之后：qoder 段日志每行完整，但停在行尾避免把半行当整行。
      if (!primed) {
        const lastNewline = text.lastIndexOf('\n')
        cursor = lastNewline < 0 ? text.length : lastNewline + 1
        primed = true
        if (text.length === cursor) return []
      }
      if (text.length === cursor) return []
      const slice = text.slice(cursor)
      cursor = text.length
      const fresh: ProgressRow[] = []
      let seq = 0
      for (const line of splitLines(slice)) {
        if (line.trim() === '') continue
        let parsed: QoderSegmentRow
        try {
          parsed = JSON.parse(line) as QoderSegmentRow
        } catch {
          continue
        }
        const id = typeof parsed.seq === 'number' ? parsed.seq : seq
        seq = id + 1
        fresh.push({ id, at: qoderRowAt(parsed.ts), target: typeof parsed.type === 'string' ? parsed.type : 'qoder', body: line })
      }
      return fresh
    }
    return { read }
  }
}

/** 按行切，保留末尾未完成的半行（下一段再拼）。 */
function splitLines(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      out.push(text.slice(start, index))
      start = index + 1
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

/**
 * qoder 进度探针；宿主环境里没有段日志时返回 undefined。
 *
 * `source` 仅供测试注入——生产路径永远走只读段日志。
 */
export function qoderProgressProbe(options?: { readonly source?: ProgressSource }): ProgressProbe | undefined {
  const source = options?.source ?? qoderSegmentSource()
  if (source === undefined) return undefined
  return createProgressProbe(source, classifyQoderRow)
}

// ---------------------------------------------------------------------------
// grok: 读它自己的会话更新日志，判断压缩上下文是否还在推进。
//
// 2026-10-28 桌面版现场（session-983e4ad7）：grok 发完最后一段文字就转入自动
// 压缩（它自己的 updates.jsonl 记着 93% / 238k token），之后 120 秒零帧，看门
// 狗把回合杀了。压缩本身是会发事件的——`auto_compact_started`、
// `compaction_checkpoint`、`auto_compact_completed`——但都包在私有方法
// `_x.ai/session/update` 里，DSH 的 grok 方言不收这个方法，界面上一个都看不到。
// 既然帧里看不见，就去日志里看：这些种类出现在 updates.jsonl 就是还在推进。
//
// 与 codex/qoder 的差别在「历史怎么挡」：压缩开始那一行写在最后一帧之后不到
// 一毫秒，第一次静默探针（≥5 秒）若按「游标停在末尾」处理，恰好把它当历史
// 跳过——要看的就是它。这里改用时间窗：只认最近一分钟内写入的行。
// ---------------------------------------------------------------------------

/** grok 的会话更新里算「还在推进」的种类；其余（工具/文本块）不是这层信号。 */
const GROK_PROGRESS_UPDATES = new Set([
  'auto_compact_started',
  'compaction_checkpoint',
  'auto_compact_completed',
])

/** 只认这么新的行：日志里的旧压缩不能把十分钟后的死回合说成活回合。 */
const GROK_FRESH_MS = 60_000

/**
 * 首次接入时最多往回扫这么多字节。
 *
 * updates.jsonl 不轮转，本机见过 50MB 的会话；每次静默探针整文件重读会把
 * 主线程卡住。一分钟里的压缩行一定落在文件末尾附近，往回 4MB 足够覆盖。
 */
const GROK_TAIL_BYTES = 4 * 1024 * 1024

/** grok 的 updates.jsonl 行；只取分类与时间需要的字段。 */
type GrokUpdateRow = {
  timestamp?: unknown
  params?: unknown
  _meta?: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** 行时间：`timestamp` 是 epoch 秒；缺了退回 `_meta.agentTimestampMs`。 */
function grokRowAt(row: GrokUpdateRow): number {
  if (typeof row.timestamp === 'number' && Number.isFinite(row.timestamp)) return row.timestamp * 1000
  const ms = asRecord(row._meta)['agentTimestampMs']
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : 0
}

/**
 * 一行 grok 会话更新的分类器。
 *
 * 只看 `params.update.sessionUpdate`，不看外面的方法名：压缩事件只写进 grok
 * 自己的 updates.jsonl（`_x.ai/session/update`），根本不走 ACP 线——线上私有
 * 通知 `_x.ai/session_notification` 里没有这几个种类，界面无从展示，日志是
 * 唯一能看见它们的通道。认不得的种类按噪音跳过——工具与文本块每轮上千行，
 * 认了就把死回合说成活回合。
 *
 * `key` 带上行时间：一轮里压缩两次时，两次都要各给一条提示。
 */
export function classifyGrokRow(row: ProgressRow): { key: string; label: string } | undefined {
  let parsed: GrokUpdateRow
  try {
    parsed = JSON.parse(row.body) as GrokUpdateRow
  } catch {
    return undefined
  }
  const update = asRecord(asRecord(parsed.params)['update'])
  const kind = update['sessionUpdate']
  if (typeof kind !== 'string' || !GROK_PROGRESS_UPDATES.has(kind)) return undefined
  return { key: `grok:${kind}@${String(row.at)}`, label: grokLabel(kind, update) }
}

function numberAt(update: Record<string, unknown>, key: string): number | undefined {
  const value = update[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 千分位，不依赖 locale：提示里读到的都是同一个形状。 */
function grouped(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 提示要当场说清「它在干什么、压到哪了」，而不是只报一个种类名。 */
function grokLabel(kind: string, update: Record<string, unknown>): string {
  switch (kind) {
    case 'auto_compact_started': {
      const used = numberAt(update, 'tokens_used')
      const window = numberAt(update, 'context_window')
      const pct = numberAt(update, 'percentage')
      const size = used !== undefined && window !== undefined ? `已用 ${grouped(used)} / ${grouped(window)} tokens` : ''
      const tail = pct !== undefined ? `${size === '' ? '' : '，'}${String(pct)}%` : ''
      const detail = size === '' && tail === '' ? '' : `（${size}${tail}）`
      return `grok 正在压缩上下文${detail}`
    }
    case 'compaction_checkpoint': return 'grok 已写入压缩检查点'
    case 'auto_compact_completed': {
      const before = numberAt(update, 'tokens_before')
      const after = numberAt(update, 'tokens_after')
      const elapsed = numberAt(update, 'elapsed_ms')
      const shrink = before !== undefined && after !== undefined ? `${grouped(before)} → ${grouped(after)} tokens` : ''
      const time = elapsed !== undefined ? `用时 ${String(Math.round(elapsed / 1000))}s` : ''
      const parts = [shrink, time].filter(part => part !== '')
      return `grok 已完成上下文压缩${parts.length === 0 ? '' : `（${parts.join('，')}）`}`
    }
    default: return `grok 日志活动：${kind}`
  }
}

/** grok 配置目录：官方 `GROK_HOME`，缺省本机 `~/.grok`。 */
function grokHome(): string {
  return process.env['GROK_HOME'] ?? join(homedir(), '.grok')
}

/** 该会话的 updates.jsonl 路径；还没落日志时 undefined。 */
function grokUpdatesPath(sessionId: string): string | undefined {
  const sessionsRoot = join(grokHome(), 'sessions')
  if (!existsSync(sessionsRoot)) return undefined
  // 会话按 <URL 编码的工作目录>/<sessionId>/updates.jsonl 存；工作目录 DSH
  // 不知道，只能遍历。会话目录只有一个，命中即停。
  let projectDirs: string[]
  try {
    projectDirs = readdirSync(sessionsRoot)
  } catch {
    return undefined
  }
  for (const project of projectDirs) {
    const path = join(sessionsRoot, project, sessionId, 'updates.jsonl')
    if (existsSync(path)) return path
  }
  return undefined
}

/** 只读一段字节；读不到返回 undefined，短读按实际长度交回。 */
function readRange(path: string, start: number, length: number): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const got = readSync(fd, buffer, offset, length - offset, start + offset)
      if (got === 0) break
      offset += got
    }
    return offset === length ? buffer : buffer.subarray(0, offset)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 按会话 id 拿 grok 会话更新读取器。
 *
 * 按字节偏移增量读，只读追加的尾巴；末尾没有换行的半行留到下次再拼。文件被
 * 换/截断时从头重读。不把游标先停在末尾，而是交给 `GROK_FRESH_MS` 挡历史——
 * 原因见本节开头。
 */
function grokUpdatesSource(): ProgressSource {
  return sessionId => {
    const path = grokUpdatesPath(sessionId)
    if (path === undefined) return undefined
    let cursor: number | undefined
    const read = (): readonly ProgressRow[] => {
      let size: number
      try {
        size = statSync(path).size
      } catch {
        return []
      }
      if (cursor === undefined) cursor = Math.max(0, size - GROK_TAIL_BYTES)
      // 文件被换/截断：从新文件头重读。
      if (size < cursor) cursor = 0
      if (size <= cursor) return []
      const chunk = readRange(path, cursor, size - cursor)
      if (chunk === undefined) return []
      // 末尾没有换行的是还没写完的半行，不算数，下次再读。
      const lastNewline = chunk.lastIndexOf(0x0a)
      if (lastNewline < 0) return []
      const complete = chunk.subarray(0, lastNewline + 1)
      cursor += complete.length
      const now = Date.now()
      const fresh: ProgressRow[] = []
      let seq = 0
      for (const line of splitLines(complete.toString('utf8'))) {
        if (line.trim() === '') continue
        let parsed: GrokUpdateRow
        try {
          parsed = JSON.parse(line) as GrokUpdateRow
        } catch {
          continue
        }
        const at = grokRowAt(parsed)
        // 旧行不是「现在还在动」的证据（恢复的旧会话尤其明显）。
        if (now - at > GROK_FRESH_MS) continue
        seq += 1
        fresh.push({ id: seq, at, target: 'grok', body: line })
      }
      return fresh
    }
    return { read }
  }
}

/**
 * grok 进度探针；宿主环境里没有会话更新日志时返回 undefined。
 *
 * `source` 仅供测试注入——生产路径永远走只读 updates.jsonl。
 */
export function grokProgressProbe(options?: { readonly source?: ProgressSource }): ProgressProbe | undefined {
  const source = options?.source ?? grokUpdatesSource()
  return createProgressProbe(source, classifyGrokRow)
}
