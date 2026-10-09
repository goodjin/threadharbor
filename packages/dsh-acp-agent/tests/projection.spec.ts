/**
 * Projection tests for the shared ACP layer.
 *
 * Every frame sequence below is a real capture, not a hand-written shape:
 * `tests/fixtures/captured-frames.json` was recorded from a live
 * `claude-agent-acp@0.76.0` and a live `codex-acp` (2026-10-09). The three
 * agents disagree about where a tool's name lives, where its output lives and
 * how it reports token counts, so the dialect — not the shared projection — is
 * what these tests pin down.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectTurn } from '../src/projection.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import type { AcpFrame } from '../src/acp-client.ts'

/** The real captures, read from disk so a test can never drift from them. */
const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-frames.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, unknown>>

const claudeTool = captured['claude']!['tool'] as AcpFrame[]

describe('projectTurn with the claude dialect', () => {
  it("takes the tool name from _meta.claudeCode.toolName, not the human title", () => {
    const events = projectTurn(claudeTool, { turn: 1, dialect: claudeDialect })
    const call = events.find(event => event.type === 'tool/call')!
    expect((call.payload as { name: string }).name).toBe('Bash')
  })
})