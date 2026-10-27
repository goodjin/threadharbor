/**
 * codex 日志进度探针：帧静默时判断「它其实还在干活」。
 *
 * 2026-10-27 的现场：回合中途压缩上下文，四分钟零帧，代码这边的看门狗把回合
 * 杀了；同一时间 codex 日志每 30 秒一行 compaction。这里钉住读数与噪音边界。
 */

import { describe, expect, it } from 'vitest'
import { classifyProgressRow, codexProgressProbe, createProgressProbe } from '../src/agent-progress.ts'
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
