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
  classifyProgressRow,
  classifyQoderRow,
  codexProgressProbe,
  createProgressProbe,
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
