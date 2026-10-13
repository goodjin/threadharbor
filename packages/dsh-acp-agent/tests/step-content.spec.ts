/**
 * A projection for an agent whose step has been replaced wholesale.
 *
 * When a plugin swaps out the loop's `step`, the surrounding native loop still
 * owns the turn and step boundaries: it appends `step/start` before calling the
 * step and `step/end` in a finally, with `turn/end` when the turn unwinds. So a
 * replacement step must contribute only the model-visible content, and emitting
 * boundaries too would double them into the session log.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { projectStepContent } from '../src/projection.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import type { AcpFrame } from '../src/acp-client.ts'

const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-frames.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, unknown>>

const claudeTool = captured['claude']!['tool'] as AcpFrame[]

describe('projectStepContent', () => {
  it('emits only content events, leaving the turn and step boundaries to the native loop', () => {
    const events = projectStepContent(claudeTool, { turn: 1, step: 1, dialect: claudeDialect })
    expect(events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('carries the same payloads as the full projection', () => {
    const events = projectStepContent(claudeTool, { turn: 1, step: 1, dialect: claudeDialect })
    // The card name goes through toolNameMap, same as the full projection.
    expect((events[0]!.payload as { name: string }).name).toBe('bash')
    expect((events[0]!.payload as { turn: number; step: number }).turn).toBe(1)
  })

  it('still stamps the step number the native loop is on', () => {
    // The loop increments its own step counter, so the caller passes it in.
    const events = projectStepContent(claudeTool, { turn: 3, step: 2, dialect: claudeDialect })
    expect((events[0]!.payload as { step: number }).step).toBe(2)
  })
})