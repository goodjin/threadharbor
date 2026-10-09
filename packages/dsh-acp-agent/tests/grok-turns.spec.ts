/**
 * grok turns, over frames captured from a live `grok agent serve` (grok 1.0.46).
 *
 * The shapes asserted here are the ones the product emits, captured with the
 * session and call ids grok actually used. They moved here from the standalone
 * grok package when that package was retired: the shared layer now serves all
 * three agents, so the captured frames have to be pinned against the shared
 * layer itself rather than against a binding nothing uses any more.
 */

import { describe, expect, it } from 'vitest'
import { projectTurn } from '../src/projection.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import type { AcpFrame } from '../src/acp-client.ts'

const SESSION = '01a11edf-8c6f-77a0-9339-32b802c8ebd5'
const CALL_ID = 'call-d0f9391e-a336-4eed-bc3a-81344b79a72f-0'

/** One `session/update` frame carrying the given update and meta. */
function update(u: unknown, meta: unknown = {}): AcpFrame {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: u, _meta: meta } }
}

/** The exact tool-call sequence grok emitted for `echo THREADHARBOR_TOOL_OK`. */
const toolFrames: AcpFrame[] = [
  update({ sessionUpdate: 'tool_call', toolCallId: CALL_ID, title: 'run_terminal_command', rawInput: { command: 'echo THREADHARBOR_TOOL_OK' } }),
  update({ sessionUpdate: 'tool_call_update', toolCallId: CALL_ID, title: 'Execute `echo THREADHARBOR_TOOL_OK`', kind: 'execute', rawInput: { variant: 'Bash', command: 'echo THREADHARBOR_TOOL_OK' }, content: [{ type: 'content', content: { type: 'text', text: 'Print THREADHARBOR_TOOL_OK marker' } }] }),
  update({ sessionUpdate: 'tool_call_update', toolCallId: CALL_ID, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: '' } }] }),
  update({ sessionUpdate: 'tool_call_update', toolCallId: CALL_ID, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'THREADHARBOR_TOOL_OK\n' } }] }),
  update({ sessionUpdate: 'tool_call_update', toolCallId: CALL_ID, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'THREADHARBOR_TOOL_OK\n' } }] }),
]

const turn = (frames: readonly AcpFrame[]) => projectTurn(frames, { turn: 1, dialect: grokDialect })

describe('grok turns over captured frames', () => {
  it('orders a turn as start, step, message, step end, turn end', () => {
    const events = turn([update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } })])
    expect(events.map(e => e.type)).toEqual(['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  })

  it('separates thinking from the visible answer', () => {
    const events = turn([
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I need to think.' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '0.05' } }),
    ])
    const blocks = events.filter(e => e.type === 'assistant/message')
      .flatMap(e => (e.payload as { message: { content: { type: string }[] } }).message.content)
    expect(blocks.map(b => b.type)).toEqual(['reasoning', 'text'])
  })

  it('keeps the token count grok reports in _meta', () => {
    const events = turn([
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } }, { totalTokens: 21576 }),
    ])
    const message = events.find(e => e.type === 'assistant/message')!
    expect((message.payload as { usage: { outputTokens: number } }).usage.outputTokens).toBe(21576)
  })

  it('keeps the tool name from the opening call, not the human title of an update', () => {
    // grok puts the tool's name in `title` only on the opening frame; every
    // later update overwrites it with a human activity line.
    const call = turn(toolFrames).find(e => e.type === 'tool/call')!
    expect((call.payload as { name: string }).name).toBe('run_terminal_command')
  })

  it('captures the tool output from the nested ACP content shape', () => {
    const result = turn(toolFrames).find(e => e.type === 'tool/result')!
    const message = (result.payload as { message: { role: string; content: { text: string }[]; toolCallId: string } }).message
    expect(message.role).toBe('tool')
    expect(message.toolCallId).toBe(CALL_ID)
    expect(message.content.map(c => c.text).join('')).toBe('THREADHARBOR_TOOL_OK\n')
  })

  it('pairs exactly one call with one result', () => {
    // grok updates the same call several times; counting updates as calls would
    // emit a duplicate tool card per progress line.
    const events = turn(toolFrames)
    expect(events.filter(e => e.type === 'tool/call')).toHaveLength(1)
    expect(events.filter(e => e.type === 'tool/result')).toHaveLength(1)
  })

  it('ignores the setup chatter grok emits before any turn content', () => {
    const chatter: AcpFrame[] = [
      { jsonrpc: '2.0', method: '_x.ai/session/setup', params: { phase: 'auth' } },
      { jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: { mcpServers: [] } },
      { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } },
    ]
    const events = turn([...chatter, update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } })])
    expect(events.map(e => e.type)).toEqual(['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  })
})