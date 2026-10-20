/**
 * The capability table (能力表).
 *
 * Every dialect declares, up front, what its agent can do — cancels, image
 * content, tool-frame shape, command path, tool-name mapping — so the stop /
 * visibility / reply / attachment tasks read a fact instead of re-deriving one
 * from frame shapes. Values come from the live captures documented on each
 * dialect, not from guesses.
 */

import { describe, expect, it } from 'vitest'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import { cursorDialect } from '../src/dialects/cursor.ts'
import { qoderDialect } from '../src/dialects/qoder.ts'

describe('capabilities', () => {
  it('claude: 不认图片、工具帧有执行中', () => {
    expect(claudeDialect.capabilities.acceptsImageContent).toBe(false)
    expect(claudeDialect.capabilities.toolFrameShape).toBe('in_progress')
  })

  it('codex: 认图片、工具帧两段', () => {
    expect(codexDialect.capabilities.acceptsImageContent).toBe(true)
    expect(codexDialect.capabilities.toolFrameShape).toBe('two_frame')
  })

  it('grok: 认图片、工具帧两段、命令经工具帧', () => {
    expect(grokDialect.capabilities.acceptsImageContent).toBe(true)
    expect(grokDialect.capabilities.toolFrameShape).toBe('two_frame')
    expect(grokDialect.capabilities.commandVia).toBe('tool_frame')
  })

  it('cursor: 认图片、工具帧有执行中', () => {
    expect(cursorDialect.capabilities.acceptsImageContent).toBe(true)
    expect(cursorDialect.capabilities.toolFrameShape).toBe('in_progress')
  })

  it('qoder: 认图片、工具帧两段、命令经工具帧、可取消', () => {
    expect(qoderDialect.capabilities.acceptsImageContent).toBe(true)
    expect(qoderDialect.capabilities.toolFrameShape).toBe('two_frame')
    expect(qoderDialect.capabilities.commandVia).toBe('tool_frame')
    expect(qoderDialect.capabilities.cancelsTurns).toBe(true)
  })

  it('五家都认取消', () => {
    for (const d of [claudeDialect, codexDialect, grokDialect, cursorDialect, qoderDialect]) {
      expect(d.capabilities.cancelsTurns).toBe(true)
    }
  })

  it('claude maps its tool names onto the short names DSH uses', () => {
    // Values verified 2026-10-13 against the reference DSH client: the
    // `classifyTool` table and the keyed `tool.call.toolview` registrations.
    // The todo row registers key `todo_write`; `todo` is registered nowhere.
    expect(claudeDialect.capabilities.toolNameMap).toEqual({
      Read: 'read',
      Edit: 'edit',
      Bash: 'bash',
      Write: 'write',
      Grep: 'grep',
      Glob: 'glob',
      TodoWrite: 'todo_write',
      WebFetch: 'web_fetch',
      WebSearch: 'web_search',
      Skill: 'skill',
    })
  })

  it('codex/cursor 名字只有 kind execute，映射成 bash；grok 的标题同理', () => {
    expect(codexDialect.capabilities.toolNameMap).toEqual({ execute: 'bash' })
    expect(cursorDialect.capabilities.toolNameMap).toEqual({ execute: 'bash' })
    expect(grokDialect.capabilities.toolNameMap).toEqual({ run_terminal_command: 'bash' })
  })

  it('qoder maps only the tool names its live capture showed', () => {
    // 2026-10-20, qoder-cli-cn 1.1.6: Bash/Read/Edit/Write/Grep/Glob.
    expect(qoderDialect.capabilities.toolNameMap).toEqual({
      Bash: 'bash',
      Read: 'read',
      Edit: 'edit',
      Write: 'write',
      Grep: 'grep',
      Glob: 'glob',
    })
  })
})
