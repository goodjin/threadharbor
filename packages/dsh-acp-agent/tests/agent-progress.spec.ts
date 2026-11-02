/**
 * codex 日志进度探针：帧静默时判断「它其实还在干活」。
 *
 * 2026-10-27 的现场：回合中途压缩上下文，四分钟零帧，代码这边的看门狗把回合
 * 杀了；同一时间 codex 日志每 30 秒一行 compaction。这里钉住读数与噪音边界。
 */

import { describe, expect, it, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyGrokRow,
  classifyProgressRow,
  classifyQoderRow,
  codexProgressProbe,
  createProgressProbe,
  grokProgressProbe,
  qoderProgressProbe,
} from '../src/agent-progress.ts'
import type { ProgressReader, ProgressRow } from '../src/agent-progress.ts'

function row(id: number, target: string, body = '', at = id * 1000): ProgressRow {
  return { id, at, target, body }
}

/** A source over one growing list; each reader starts at the current end. */
function liveSource(rows: ProgressRow[]): { calls: number; source: (sessionId: string) => ProgressReader | undefined } {
  const state = {
    calls: 0,
    source: (_sessionId: string): ProgressReader | undefined => {
      state.calls += 1
      let cursor = rows.length
      return { read: () => rows.slice(cursor, (cursor = rows.length)) }
    },
  }
  return state
}

describe('classifyProgressRow', () => {
  it('压缩上下文的行是进展，并说清它在压缩', () => {
    const reading = classifyProgressRow(row(1, 'codex_api::sse::responses',
      'run_auto_compact{reason=ContextLimit phase=MidTurn}: unhandled responses event: "response.compaction.compacting"'))
    expect(reading).toEqual({ key: 'compaction', label: 'codex 正在压缩上下文' })
  })

  it('工具、模型输出、子代理通信各有读法', () => {
    expect(classifyProgressRow(row(1, 'codex_core::tools::parallel'))?.key).toBe('tool')
    expect(classifyProgressRow(row(1, 'codex_core::stream_events_utils'))?.key).toBe('model')
    expect(classifyProgressRow(row(1, 'codex_otel.agent_communication'))?.key).toBe('agent')
  })

  it('认不出的目标按进展算：新增日志种类不该变成「静默」', () => {
    expect(classifyProgressRow(row(1, 'some_new_module::work'))).toEqual({
      key: 'log:some_new_module::work',
      label: 'codex 日志活动：some_new_module::work',
    })
  })

  it('网络重试与标签碎念不是进展', () => {
    // 2026-10-16 的教训：tls 重试每几十秒一行，持续十分钟，把死回合说成活回合。
    expect(classifyProgressRow(row(1, 'codex_http_client::client', 'Request failed, retrying'))).toBeUndefined()
    expect(classifyProgressRow(row(1, 'codex_http_client::custom_ca'))).toBeUndefined()
    expect(classifyProgressRow(row(1, 'feedback_tags'))).toBeUndefined()
    expect(classifyProgressRow(row(1, 'rmcp::service'))).toBeUndefined()
    expect(classifyProgressRow(row(1, 'codex_api::endpoint::responses_websocket'))).toBeUndefined()
  })
})

describe('createProgressProbe', () => {
  it('没有日志源的会话读不到东西', () => {
    const probe = createProgressProbe(() => undefined)
    expect(probe.read('thread-1')).toBeUndefined()
  })

  it('只报新行，最新一行是噪音时往前找', () => {
    const rows: ProgressRow[] = []
    const live = liveSource(rows)
    const probe = createProgressProbe(live.source)

    expect(probe.read('thread-1')).toBeUndefined()
    rows.push(row(10, 'codex_core::tools::parallel', 'tool_name=shell'))
    rows.push(row(11, 'feedback_tags', 'noise'))
    const reading = probe.read('thread-1')
    expect(reading).toEqual({ at: 10_000, key: 'tool', label: 'codex 正在执行工具' })

    // 同一个读取器继续，源只问过一次。
    expect(live.calls).toBe(1)
    expect(probe.read('thread-1')).toBeUndefined()
  })

  it('全是噪音时不算进展', () => {
    const rows: ProgressRow[] = [row(1, 'feedback_tags')]
    const probe = createProgressProbe(liveSource(rows).source)
    probe.read('thread-1')
    rows.push(row(2, 'codex_http_client::client', 'retry'))
    expect(probe.read('thread-1')).toBeUndefined()
  })

  it('读取器抛错时只算这一次没有读数，下次重新接入', () => {
    let broken = true
    const rows: ProgressRow[] = [row(1, 'codex_core::stream_events_utils')]
    let calls = 0
    const probe = createProgressProbe(() => {
      calls += 1
      let cursor = rows.length
      return {
        read: () => {
          if (broken) throw new Error('db locked')
          return rows.slice(cursor, (cursor = rows.length))
        },
      }
    })
    expect(probe.read('thread-1')).toBeUndefined()
    broken = false
    expect(calls).toBe(1)
    // 抛错后读取器被丢弃，下一次重新从源拿（游标重新停在当下末尾）。
    rows.push(row(2, 'codex_core::tools::parallel'))
    expect(probe.read('thread-1')).toBeUndefined()
    expect(calls).toBe(2)
  })

  it('会话之间互不串行：各自的读取器各自计数', () => {
    const rows = new Map<string, ProgressRow[]>([
      ['a', [row(1, 'codex_core::tools::parallel')]],
      ['b', [row(1, 'codex_core::stream_events_utils')]],
    ])
    const probe = createProgressProbe(sessionId => {
      const own = rows.get(sessionId) ?? []
      let cursor = own.length
      return { read: () => own.slice(cursor, (cursor = own.length)) }
    })
    probe.read('a')
    probe.read('b')
    rows.get('a')!.push(row(2, 'codex_core::stream_events_utils'))
    expect(probe.read('a')?.key).toBe('model')
    expect(probe.read('b')).toBeUndefined()
  })
})

describe('codexProgressProbe', () => {
  it('注入源时直接可用；close 后重新接入', () => {
    const rows: ProgressRow[] = [row(1, 'codex_core::tools::parallel')]
    const live = liveSource(rows)
    const probe = codexProgressProbe({ source: live.source })
    expect(probe).toBeDefined()
    probe!.read('thread-1')
    rows.push(row(2, 'codex_core::tools::parallel'))
    expect(probe!.read('thread-1')?.key).toBe('tool')
    probe!.close()
    probe!.read('thread-1')
    expect(live.calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// qoder 段日志进度探针：帧静默时判断「它其实还在干活」。
//
// 2026-10-28 的现场：qoder 在大仓里等工具结果落地后等模型回答，静默到点被杀
// （ACP_STALLED，120s）；同一时间它的段日志里每一轮都在 model.request.started /
// tool.requested 之间跳。这里钉住类型分类与「只认明确进展」的边界。
// ---------------------------------------------------------------------------

describe('classifyQoderRow', () => {
  function seg(type: string, ts = '2026-10-28T10:35:13.272+08:00', seq = 1): ProgressRow {
    return row(seq, type, JSON.stringify({ ts, type, seq }), Date.parse(ts))
  }

  it('回合/轮次/模型/工具各类型的进展读数', () => {
    expect(classifyQoderRow(seg('turn.started'))).toEqual({ key: 'qoder:turn.started', label: 'qoder 正在开始新回合' })
    expect(classifyQoderRow(seg('loop.iteration.started'))?.key).toBe('qoder:loop.iteration.started')
    expect(classifyQoderRow(seg('model.request.started'))).toEqual({ key: 'qoder:model.request.started', label: 'qoder 正在等待模型回答' })
    expect(classifyQoderRow(seg('model.response.completed'))?.key).toBe('qoder:model.response.completed')
    expect(classifyQoderRow(seg('tool.requested'))).toEqual({ key: 'qoder:tool.requested', label: 'qoder 正在执行工具' })
    expect(classifyQoderRow(seg('tool.shell.backgrounded'))?.key).toBe('qoder:tool.shell.backgrounded')
  })

  it('attachment/hook/phase 碎念不是进展', () => {
    // 这些类型每轮刷上百行，认了就把死回合说成活回合。
    expect(classifyQoderRow(seg('attachment.generator.finished'))).toBeUndefined()
    expect(classifyQoderRow(seg('hook.finished'))).toBeUndefined()
    expect(classifyQoderRow(seg('session.phase.finished'))).toBeUndefined()
  })

  it('body 不是 JSON / 没有 type 字段时不崩、不算进展', () => {
    expect(classifyQoderRow(row(1, 'qoder', 'not json'))).toBeUndefined()
    expect(classifyQoderRow(row(1, 'qoder', JSON.stringify({ ts: '2026-10-28T10:00:00Z' })))).toBeUndefined()
  })

  it('时间戳由调用方从行上透传；分类器本身不带 at', () => {
    // 分类器只回 { key, label }；at 是 ProgressRow 上的字段，createProgressProbe
    // 据它给读数盖时间戳。这里钉住分类器不碰时间，避免它悄悄改了契约。
    const r = seg('model.request.started', '2026-10-28T10:35:13.272+08:00', 7)
    expect(classifyQoderRow(r)).toEqual({ key: 'qoder:model.request.started', label: 'qoder 正在等待模型回答' })
  })
})

describe('qoderProgressProbe', () => {
  /** 一行 qoder 段日志：body 是带 ts/type/seq 的 JSON，target 留作分类器读的 type。 */
  function qoderRow(seq: number, type: string, ts = '2026-10-28T10:35:13.272+08:00'): ProgressRow {
    return row(seq, type, JSON.stringify({ ts, type, seq }), Date.parse(ts))
  }

  it('注入源时直接可用；close 后重新接入', () => {
    const rows: ProgressRow[] = []
    const live = liveSource(rows)
    const probe = qoderProgressProbe({ source: live.source })
    expect(probe).toBeDefined()
    // 首读：源刚接入，游标停在当下末尾，历史行不算进展。
    expect(probe!.read('session-1')).toBeUndefined()
    // 段日志追加一条真正的进展，下一次读到。
    rows.push(qoderRow(1, 'model.request.started'))
    expect(probe!.read('session-1')?.key).toBe('qoder:model.request.started')
    // 再来一条噪音，不应算进展。
    rows.push(qoderRow(2, 'attachment.generator.finished', '2026-10-28T10:35:14.000+08:00'))
    expect(probe!.read('session-1')).toBeUndefined()
    probe!.close()
    probe!.read('session-1')
    expect(live.calls).toBe(2)
  })

  it('会话没有段日志时读不到东西', () => {
    const probe = qoderProgressProbe({ source: () => undefined })
    expect(probe).toBeDefined()
    expect(probe!.read('session-1')).toBeUndefined()
  })
})

// 真走文件系统：在临时 QODERCN_CONFIG_DIR 下落一段段日志，验证源能找到会话目录、
// 取最新一段、按字节游标增量读、并把半行留到下次拼。
describe('qoderProgressProbe（文件系统）', () => {
  const savedHome = process.env['QODERCN_CONFIG_DIR']
  let home: string

  afterEach(() => {
    if (savedHome === undefined) delete process.env['QODERCN_CONFIG_DIR']
    else process.env['QODERCN_CONFIG_DIR'] = savedHome
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  function writeSegment(sessionId: string, lines: readonly object[]): void {
    const segDir = join(home, 'logs', 'sessions', '-Users-test-proj', sessionId, 'segments')
    mkdirSync(segDir, { recursive: true })
    writeFileSync(join(segDir, '2026-10-28T10-00-00-000+08-00-00000000-0000.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }

  it('读到最新一段里的进展行；历史行不当作当下进展', () => {
    home = mkdtempSync(join(tmpdir(), 'qoder-probe-'))
    process.env['QODERCN_CONFIG_DIR'] = home
    // 预先落一条历史：探针首次接入游标停在末尾，不能把这条旧行当「现在还在动」。
    writeSegment('sess-fs', [{ ts: '2026-10-28T10:00:00.000+08:00', type: 'model.request.started', seq: 1 }])
    const probe = qoderProgressProbe()
    expect(probe).toBeDefined()
    expect(probe!.read('sess-fs')).toBeUndefined()

    // 段日志被追加：新一轮 model.request.started 才算当下进展。
    const segDir = join(home, 'logs', 'sessions', '-Users-test-proj', 'sess-fs', 'segments')
    const segFile = join(segDir, '2026-10-28T10-00-00-000+08-00-00000000-0000.jsonl')
    const appended = [...Array.from({ length: 1 }, () => ({ ts: '2026-10-28T10:35:13.272+08:00', type: 'model.request.started', seq: 2 }))]
    writeFileSync(segFile, (JSON.stringify({ ts: '2026-10-28T10:00:00.000+08:00', type: 'model.request.started', seq: 1 }) + '\n'
      + appended.map(l => JSON.stringify(l)).join('\n') + '\n'))
    expect(probe!.read('sess-fs')?.key).toBe('qoder:model.request.started')
    // 同一段再读没有新行。
    expect(probe!.read('sess-fs')).toBeUndefined()
  })

  it('会话目录不存在时读不到东西', () => {
    home = mkdtempSync(join(tmpdir(), 'qoder-probe-'))
    process.env['QODERCN_CONFIG_DIR'] = home
    expect(qoderProgressProbe()?.read('nope')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// grok 会话更新日志进度探针：帧静默时判断上下文压缩是否还在推进。
//
// 2026-10-28 的现场：grok 发完最后一段文字就转入自动压缩，之后 120 秒零帧被杀
// （ACP_STALLED）；同一时刻它的 updates.jsonl 里躺着 `auto_compact_started`。
// 压缩事件包在方言不收的 `_x.ai/session/update` 里，界面看不见，只能读日志。
// ---------------------------------------------------------------------------

describe('classifyGrokRow', () => {
  const at = 1793245281000

  function update(kind: string, extra: Record<string, unknown> = {}): ProgressRow {
    return row(1, 'grok', JSON.stringify({
      timestamp: at / 1000,
      method: '_x.ai/session/update',
      params: { update: { sessionUpdate: kind, ...extra } },
    }), at)
  }

  it('压缩的三个节点都是进展，并把压缩到哪了说清', () => {
    expect(classifyGrokRow(update('auto_compact_started', {
      tokens_used: 238525,
      context_window: 256000,
      percentage: 93,
    }))).toEqual({
      key: `grok:auto_compact_started@${String(at)}`,
      label: 'grok 正在压缩上下文（已用 238,525 / 256,000 tokens，93%）',
    })
    expect(classifyGrokRow(update('compaction_checkpoint'))?.key).toBe(`grok:compaction_checkpoint@${String(at)}`)
    expect(classifyGrokRow(update('auto_compact_completed', {
      tokens_before: 206299,
      tokens_after: 20430,
      elapsed_ms: 49327,
    }))).toEqual({
      key: `grok:auto_compact_completed@${String(at)}`,
      label: 'grok 已完成上下文压缩（206,299 → 20,430 tokens，用时 49s）',
    })
  })

  it('字段缺席时不编造细节', () => {
    expect(classifyGrokRow(update('auto_compact_started'))?.label).toBe('grok 正在压缩上下文')
    expect(classifyGrokRow(update('auto_compact_completed'))?.label).toBe('grok 已完成上下文压缩')
  })

  it('一轮里压缩两次：时间不同，提示不去重', () => {
    const first = classifyGrokRow(update('auto_compact_started'))
    const later = classifyGrokRow(row(2, 'grok', JSON.stringify({
      timestamp: (at + 60_000) / 1000,
      method: '_x.ai/session/update',
      params: { update: { sessionUpdate: 'auto_compact_started' } },
    }), at + 60_000))
    expect(first?.key).not.toBe(later?.key)
  })

  it('文本块/工具/未知种类不算进展', () => {
    // 这些每轮上千行，认了就把死回合说成活回合。
    expect(classifyGrokRow(update('agent_message_chunk'))).toBeUndefined()
    expect(classifyGrokRow(update('tool_call_update'))).toBeUndefined()
    expect(classifyGrokRow(update('usage_update'))).toBeUndefined()
  })

  it('body 不是 JSON / 没有内层 update 时不崩、不算进展', () => {
    expect(classifyGrokRow(row(1, 'grok', 'not json'))).toBeUndefined()
    expect(classifyGrokRow(row(1, 'grok', JSON.stringify({ timestamp: 1793245281 })))).toBeUndefined()
    expect(classifyGrokRow(row(1, 'grok', JSON.stringify({ params: { update: { sessionUpdate: 3 } } })))).toBeUndefined()
  })
})

describe('grokProgressProbe', () => {
  function update(kind: string, at = Date.now()): ProgressRow {
    return row(1, 'grok', JSON.stringify({
      timestamp: Math.floor(at / 1000),
      method: '_x.ai/session/update',
      params: { update: { sessionUpdate: kind } },
    }), at)
  }

  it('注入源时直接可用；close 后重新接入', () => {
    const rows: ProgressRow[] = []
    const live = liveSource(rows)
    const probe = grokProgressProbe({ source: live.source })
    expect(probe).toBeDefined()
    expect(probe!.read('session-1')).toBeUndefined()
    rows.push(update('auto_compact_started'))
    expect(probe!.read('session-1')?.key.startsWith('grok:auto_compact_started@')).toBe(true)
    rows.push(update('tool_call_update'))
    expect(probe!.read('session-1')).toBeUndefined()
    probe!.close()
    probe!.read('session-1')
    expect(live.calls).toBe(2)
  })

  it('会话没有更新日志时读不到东西', () => {
    const probe = grokProgressProbe({ source: () => undefined })
    expect(probe).toBeDefined()
    expect(probe!.read('session-1')).toBeUndefined()
  })
})

// 真走文件系统：在临时 GROK_HOME 下落 updates.jsonl，验证源能找到会话目录、
// 挡住旧历史、首读仍能看见「最后一帧之后」写下的压缩行、并处理半行。
describe('grokProgressProbe（文件系统）', () => {
  const savedHome = process.env['GROK_HOME']
  let home: string

  afterEach(() => {
    if (savedHome === undefined) delete process.env['GROK_HOME']
    else process.env['GROK_HOME'] = savedHome
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  })

  function sessionFile(sessionId: string): string {
    const dir = join(home, 'sessions', '%2FUsers%2Ftest%2Fproj', sessionId)
    mkdirSync(dir, { recursive: true })
    return join(dir, 'updates.jsonl')
  }

  function line(kind: string, at = Date.now()): string {
    return JSON.stringify({
      timestamp: Math.floor(at / 1000),
      method: '_x.ai/session/update',
      params: { update: { sessionUpdate: kind } },
    })
  }

  it('首读看得见刚写下的压缩行；一分钟前的旧行不算', () => {
    home = mkdtempSync(join(tmpdir(), 'grok-probe-'))
    process.env['GROK_HOME'] = home
    const path = sessionFile('sess-fs')
    // 旧的压缩与刚发生的压缩同时存在：探针首次接入时，前者是历史、后者是
    // 「最后一帧之后 1ms」写下的、要看的那条信号。
    writeFileSync(path, [
      line('auto_compact_started', Date.now() - 120_000),
      line('auto_compact_started'),
    ].join('\n') + '\n')
    const probe = grokProgressProbe()
    expect(probe).toBeDefined()
    expect(probe!.read('sess-fs')?.key.startsWith('grok:auto_compact_started@')).toBe(true)

    // 追加 checkpoint 与半行：完整行算进展，半行留到下次。
    writeFileSync(path, line('auto_compact_started', Date.now() - 120_000) + '\n'
      + line('auto_compact_started') + '\n'
      + line('compaction_checkpoint') + '\n'
      + '{"timestamp":1793245281,"method":"_x.ai/session/update","params":{"update":{"sess')
    expect(probe!.read('sess-fs')?.key.startsWith('grok:compaction_checkpoint@')).toBe(true)
    expect(probe!.read('sess-fs')).toBeUndefined()

    // 半行补全后，下一段读到。
    writeFileSync(path, line('auto_compact_started', Date.now() - 120_000) + '\n'
      + line('auto_compact_started') + '\n'
      + line('compaction_checkpoint') + '\n'
      + line('auto_compact_completed') + '\n')
    expect(probe!.read('sess-fs')?.key.startsWith('grok:auto_compact_completed@')).toBe(true)
  })

  it('会话目录不存在时读不到东西', () => {
    home = mkdtempSync(join(tmpdir(), 'grok-probe-'))
    process.env['GROK_HOME'] = home
    expect(grokProgressProbe()?.read('nope')).toBeUndefined()
  })
})
