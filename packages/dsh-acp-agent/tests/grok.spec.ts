/**
 * grok dialect tests.
 *
 * The shapes here are the ones grok emits; `grok-turns.spec.ts` next door pins
 * the same dialect against frames captured from a live `grok agent serve`
 * (grok 1.0.46), session and call ids included.
 *
 * grok is the odd one in two ways worth keeping tests for:
 *   - The tool's name is in `title`, and **only on the opening frame** — later
 *     `tool_call_update`s overwrite `title` with a human activity line. That is
 *     the bug the original projection was written to avoid.
 *   - Token counts ride on the update frame's `_meta`, which is the one place
 *     codex and claude do *not* report them.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectTurn } from '../src/projection.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import type { AcpFrame } from '../src/acp-client.ts'

const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-frames.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, unknown>>

const grok = captured['grok']!
const grokTool = grok['tool'] as AcpFrame[]

describe('projectTurn with the grok dialect', () => {
  it('keeps the tool name from the opening frame, not the human title of an update', () => {
    const events = projectTurn(grokTool, { turn: 1, dialect: grokDialect })
    const call = events.find(event => event.type === 'tool/call')!
    expect((call.payload as { name: string }).name).toBe('run_terminal_command')
  })

  it('unwraps grok’s nested output shape', () => {
    const events = projectTurn(grokTool, { turn: 1, dialect: grokDialect })
    const result = events.find(event => event.type === 'tool/result')!
    const message = (result.payload as { message: { content: { text: string }[] } }).message
    expect(message.content.map(part => part.text).join('')).toBe('THREADHARBOR_TOOL_OK\n')
  })

  it('reads the token count grok puts on the update frame’s _meta', () => {
    const events = projectTurn(grok['messageWithTokens'] as AcpFrame[], { turn: 1, dialect: grokDialect })
    const message = events.find(event => event.type === 'assistant/message')!
    expect((message.payload as { usage: { outputTokens: number } }).usage.outputTokens).toBe(21576)
  })

  it('drops the setup chatter grok emits before any turn content', () => {
    const events = projectTurn([...(grok['noise'] as AcpFrame[]), ...(grok['message'] as AcpFrame[])], {
      turn: 1,
      dialect: grokDialect,
    })
    expect(events.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
  })

  it('reports a failed tool as failed only when grok says so', () => {
    const failed: AcpFrame[] = [
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run_terminal_command' } } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' } } },
    ]
    const events = projectTurn(failed, { turn: 1, dialect: grokDialect })
    const result = events.find(event => event.type === 'tool/result')!
    // grok reports `completed` even for tools that failed, so the projection
    // must reflect grok's own status rather than guessing from the output text.
    expect((result.payload as { message: { isError: boolean } }).message.isError).toBe(true)
  })

  it('reads grok’s model list from models.availableModels', () => {
    expect(grokDialect.readModels(grok['sessionNew'])).toEqual([{ id: 'grok-4.7', name: 'Grok 4.7' }])
  })
})