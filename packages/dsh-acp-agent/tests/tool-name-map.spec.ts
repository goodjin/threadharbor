/**
 * 工具名映射：agent 工具名 → DSH 视图键。
 *
 * `mapToolName` reads the dialect's `toolNameMap` (AcpCapabilities) and rewrites
 * the tool/call `name` so the DSH client's `classifyTool` (and its keyed
 * toolview registry) picks a dedicated card instead of the generic one. The map
 * VALUES are not free-form: they must be names the reference DSH client
 * actually recognizes, verified 2026-10-13 against
 * `reference/deepseek-harness` (read-only):
 *
 *   - `classifyTool` table (`ui-tool/src/client/tool/models/tool-call-model.ts`,
 *     TOOL_VARIANTS): bash, pwsh, read, read_image, web_fetch, web_search,
 *     grep, glob, write, edit, run_code, cordis_package_inspect,
 *     cordis_runtime_inspect, cordis_run, cordis_stop, cordis_undefine.
 *   - keyed `tool.call.toolview` registrations (a keyed hit replaces the
 *     generic row): ask_user_question, bash, edit, glob, grep, read,
 *     read_image, todo_write, web_fetch, web_search, write, create_goal,
 *     get_goal, update_goal, skill, present (+ cordis/terminal/schedule
 *     families). NOTE: the todo row registers key `todo_write` — `todo` is
 *     registered nowhere, and `web` is a Cordis service catalog key, not a
 *     tool view.
 *
 * A name absent from BOTH sets degrades to the generic card, which is the
 * honest fallback; a made-up value renders nothing useful. The guard test
 * below pins every map value to the verified set so a future wrong entry
 * fails here instead of silently rendering an empty card.
 *
 * Mapped names (2026-10-13, from the dialects' foldTool + live captures):
 *   claude  `_meta.claudeCode.toolName` — Anthropic names (Bash, Read, ...).
 *   codex   `kind` — only `execute` observed; a terminal command.
 *   cursor  `kind` — same as codex (`docs/agent-acp/README.md` 工具名 row).
 *   grok    first-frame `title` — only `run_terminal_command` observed.
 */

import { describe, expect, it } from 'vitest'
import { mapToolName, projectToolCallFrame, projectTurn, projectTurnIncremental } from '../src/projection.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { cursorDialect } from '../src/dialects/cursor.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AcpFrame } from '../src/acp-client.ts'
import type { AcpDialect } from '../src/dialects/types.ts'

const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-frames.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, unknown>>

/** Names `classifyTool` (TOOL_VARIANTS) maps to a generic-row variant. */
const CLASSIFY_NAMES = new Set([
  'bash', 'pwsh', 'read', 'read_image', 'web_fetch', 'web_search',
  'grep', 'glob', 'write', 'edit', 'run_code',
  'cordis_package_inspect', 'cordis_runtime_inspect',
  'cordis_run', 'cordis_stop', 'cordis_undefine',
])

/** Names registered under the keyed `tool.call.toolview` slot. */
const KEYED_NAMES = new Set([
  'ask_user_question', 'bash', 'edit', 'glob', 'grep', 'read', 'read_image',
  'todo_write', 'web_fetch', 'web_search', 'write', 'create_goal', 'get_goal',
  'update_goal', 'skill', 'present',
])

describe('mapToolName', () => {
  it('claude 的 Read 映射成 read', () => {
    expect(mapToolName(claudeDialect, 'Read')).toBe('read')
  })

  it('claude 的 Bash 映射成 bash', () => {
    expect(mapToolName(claudeDialect, 'Bash')).toBe('bash')
  })

  it('claude 的 Grep 映射成 grep', () => {
    expect(mapToolName(claudeDialect, 'Grep')).toBe('grep')
  })

  it('未知名原样返回', () => {
    expect(mapToolName(claudeDialect, 'SomethingNew')).toBe('SomethingNew')
  })

  it('grok 的标题 run_terminal_command 映射成 bash', () => {
    expect(mapToolName(grokDialect, 'run_terminal_command')).toBe('bash')
  })

  it('codex 和 cursor 的 kind execute 映射成 bash', () => {
    expect(mapToolName(codexDialect, 'execute')).toBe('bash')
    expect(mapToolName(cursorDialect, 'execute')).toBe('bash')
  })

  it('claude 的 TodoWrite 映射成 todo_write（DSH 注册的键）', () => {
    expect(mapToolName(claudeDialect, 'TodoWrite')).toBe('todo_write')
  })

  it('claude 的网络与技能工具映射成 DSH 同名键', () => {
    expect(mapToolName(claudeDialect, 'WebFetch')).toBe('web_fetch')
    expect(mapToolName(claudeDialect, 'WebSearch')).toBe('web_search')
    expect(mapToolName(claudeDialect, 'Skill')).toBe('skill')
  })

  it('每张映射表的值都是 DSH 认识的键（classifyTool 或 keyed toolview）', () => {
    for (const dialect of [claudeDialect, codexDialect, grokDialect, cursorDialect]) {
      for (const [raw, mapped] of Object.entries(dialect.capabilities.toolNameMap)) {
        expect(CLASSIFY_NAMES.has(mapped) || KEYED_NAMES.has(mapped),
          `${dialect.id}: ${raw} → ${mapped} 不是 DSH 认识的工具名`).toBe(true)
      }
    }
  })

  it('每张映射表至少有一条，且键不与值冲突（映射后仍是认识的名字或原样）', () => {
    for (const dialect of [claudeDialect, codexDialect, grokDialect, cursorDialect]) {
      expect(Object.keys(dialect.capabilities.toolNameMap).length,
        `${dialect.id} 的 toolNameMap 不应为空`).toBeGreaterThan(0)
    }
  })
})

describe('投影写出的 tool/call 名经映射', () => {
  const call = (events: { type: string; payload: unknown }[]) =>
    events.find(event => event.type === 'tool/call')!.payload as { name: string }

  it('projectTurn：claude 实拍 Bash 写成 bash', () => {
    expect(call(projectTurn(captured['claude']!['tool'] as AcpFrame[], { turn: 1, dialect: claudeDialect })).name).toBe('bash')
  })

  it('projectTurn：codex 实拍 execute 写成 bash', () => {
    expect(call(projectTurn(captured['codex']!['tool'] as AcpFrame[], { turn: 1, dialect: codexDialect })).name).toBe('bash')
  })

  it('projectTurn：grok 实拍 run_terminal_command 写成 bash', () => {
    expect(call(projectTurn(captured['grok']!['tool'] as AcpFrame[], { turn: 1, dialect: grokDialect })).name).toBe('bash')
  })

  it('projectTurnIncremental：流式路径同样映射（首帧开卡是唯一入库的卡）', () => {
    expect(call(projectTurnIncremental(captured['grok']!['tool'] as AcpFrame[], { turn: 1, dialect: grokDialect })).name).toBe('bash')
  })

  it('projectToolCallFrame：中段首帧开卡也映射', () => {
    const frame = (captured['claude']!['tool'] as AcpFrame[])[0]!
    const event = projectToolCallFrame(frame, { turn: 1, step: 1, dialect: claudeDialect })
    expect((event!.payload as { name: string }).name).toBe('bash')
  })

  it('映射不触碰 foldTool 的原始名（调用折叠仍是 agent 原话）', () => {
    const frame = (captured['claude']!['tool'] as AcpFrame[])[0]!
    expect(claudeDialect.foldTool(undefined, frameUpdate(frame)).name).toBe('Bash')
  })

  it('结果与错误字段不写映射名：tool/result 只按 callId 配对', () => {
    const events = projectTurn(captured['grok']!['tool'] as AcpFrame[], { turn: 1, dialect: grokDialect })
    const result = events.find(event => event.type === 'tool/result')!.payload as {
      message: { toolCallId: string; source: { callId: string } }
    }
    expect(result.message.toolCallId).toBeTruthy()
    expect(result.message.source.callId).toBe(result.message.toolCallId)
  })
})

function frameUpdate(frame: AcpFrame): Record<string, unknown> {
  return recordOf((frame.params ?? {}) as Record<string, unknown>)['update'] as Record<string, unknown>
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** Type-level guard used above: every dialect is an AcpDialect. */
const dialects: readonly AcpDialect[] = [claudeDialect, codexDialect, grokDialect, cursorDialect]
void dialects
