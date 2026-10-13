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

  it('四家都认取消', () => {
    for (const d of [claudeDialect, codexDialect, grokDialect, cursorDialect]) {
      expect(d.capabilities.cancelsTurns).toBe(true)
    }
  })

  it('claude maps its tool names onto the short names DSH uses', () => {
    expect(claudeDialect.capabilities.toolNameMap).toEqual({
      Read: 'read',
      Edit: 'edit',
      Bash: 'bash',
      Write: 'write',
      Grep: 'grep',
      Glob: 'glob',
      TodoWrite: 'todo',
    })
  })
})
