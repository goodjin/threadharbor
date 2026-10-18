/**
 * Incremental tool-frame projection.
 *
 * `projectTurn` folds a whole turn and writes every tool card at the end, so a
 * card appears only when the turn is over. `projectTurnIncremental` walks the
 * frames in arrival order instead: the call lands on the FIRST frame seen for
 * its id — the card appears while the tool still runs — and the result lands
 * on the terminal frame, paired by the same `turn:callId` key the writer files
 * the call under. Non-terminal update frames after the first are folded into
 * the accumulated call but emit nothing: the host has no in-place card update
 * (a descoped ruling — see task-3-report.md), so the completed result is what
 * carries their state.
 *
 * The claude sequence is the brief's; the codex and grok sequences are the
 * real captures (`fixtures/captured-frames.json`, 2026-10-09).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectToolResultFrame, projectTurnIncremental } from '../src/projection.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import type { AcpFrame } from '../src/acp-client.ts'

const captured = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/captured-frames.json', import.meta.url)), 'utf8'),
) as Record<string, Record<string, unknown>>

const claudeFrames: AcpFrame[] = [
  { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'in_progress' } } },
  { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' } } },
  { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'text', text: 'ok' }] } } },
]

describe('projectTurnIncremental', () => {
  it('claude 形状投影出调用、完成两事件，先调用后完成', () => {
    // Exactly two events, and in frame order: the card opens on the first
    // frame and closes on the terminal one — not folded at the end.
    const events = projectTurnIncremental(claudeFrames, { turn: 1, dialect: claudeDialect })
    expect(events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('codex 形状（调用→完成）投影出两事件', () => {
    // Real capture: an opening tool_call (in_progress) and one completed
    // update — the two_frame shape the capability table records.
    const events = projectTurnIncremental(captured['codex']!['tool'] as AcpFrame[], { turn: 1, dialect: codexDialect })
    expect(events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
  })

  it('opens the card on the first frame for a call id, even when that frame is an update', () => {
    // An update can arrive with no opening tool_call behind it (a join
    // mid-turn). It is still the first frame for that id, so it opens the
    // call; the terminal one closes it.
    const frames: AcpFrame[] = [
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't2', title: 'Read', status: 'in_progress' } } },
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', content: [{ type: 'text', text: 'file' }] } } },
    ]
    const events = projectTurnIncremental(frames, { turn: 1, dialect: claudeDialect })
    expect(events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
    expect((events[0]!.payload as { callId: string }).callId).toBe('t2')
  })

  it('folds later non-terminal updates into the call without emitting them', () => {
    // grok's real capture ticks two in_progress updates mid-run. They change
    // the accumulated call (their output reaches the result) but emit no
    // event of their own — the log has no in-place card update to carry them.
    const events = projectTurnIncremental(captured['grok']!['tool'] as AcpFrame[], { turn: 1, dialect: grokDialect })
    expect(events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
    const call = events[0]!.payload as { name: string }
    // The latched opening name, as the card carries it after toolNameMap.
    expect(call.name).toBe('bash')
    const result = events[1]!.payload as { message: { content: { text: string }[] } }
    expect(result.message.content.map(part => part.text).join('')).toContain('THREADHARBOR_TOOL_OK')
  })

  it('shapes tool/call and tool/result like the end-of-turn projection does', () => {
    // Same payload contracts as contentEvents, so one writer serves both
    // paths: the call log-only, the result a message pointing back at it.
    const events = projectTurnIncremental(claudeFrames, { turn: 1, dialect: claudeDialect })
    expect(events[0]!.payload).toMatchObject({ turn: 1, step: 1, callId: 't1', name: 'bash' })
    const payload = events[1]!.payload as {
      turn: number
      step: number
      message: { role: string; toolCallId: string; isError: boolean; content: { type: string; text: string }[] }
    }
    expect(payload.turn).toBe(1)
    expect(payload.step).toBe(1)
    expect(payload.message.toolCallId).toBe('t1')
    expect(payload.message.isError).toBe(false)
    expect(payload.message.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('closes the call at once when the opening frame already carries the outcome', () => {
    // A single-frame completion must not leave a card running forever: the
    // call and its result land together, still paired by callId.
    const frames: AcpFrame[] = [
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't9', status: 'completed', content: [{ type: 'text', text: 'done' }] } } },
    ]
    const events = projectTurnIncremental(frames, { turn: 1, dialect: claudeDialect })
    expect(events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
    expect((events[1]!.payload as { message: { toolCallId: string } }).message.toolCallId).toBe('t9')
  })

  it('keeps a call id reused across turns on its own turn', () => {
    // Turn numbers restart; a second turn reusing `t1` must file its events
    // under turn 2, or the writer would pair them with turn 1's call.
    const events = [
      ...projectTurnIncremental(claudeFrames, { turn: 1, dialect: claudeDialect }),
      ...projectTurnIncremental(claudeFrames, { turn: 2, dialect: claudeDialect }),
    ]
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.map(event => (event.payload as { turn: number }).turn)).toEqual([1, 2])
    const results = events.filter(event => event.type === 'tool/result')
    expect(results.map(event => (event.payload as { turn: number }).turn)).toEqual([1, 2])
  })

  it('writes a failed outcome as an error result, like the end-of-turn projection', () => {
    const frames: AcpFrame[] = [
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Bash', status: 'in_progress' } } },
      { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'failed', content: [{ type: 'text', text: 'boom' }] } } },
    ]
    const events = projectTurnIncremental(frames, { turn: 1, dialect: claudeDialect })
    const payload = (events[1]!.payload as { message: { isError: boolean }; error?: unknown }).message
    expect(payload.isError).toBe(true)
    expect(events[1]!.payload as { error?: unknown }).toHaveProperty('error')
  })
})

/**
 * Per-frame result projection.
 *
 * The end-of-turn fold carries every result; the runner's live path needs the
 * result the moment a call's TERMINAL frame arrives — mid-turn, while a long
 * external-agent turn is still running — instead of minutes later with the
 * turn's answer. Same folding rule as `projectToolCallFrame`: one frame, no
 * carried state, the dialect reads the fields. A frame that is not terminal
 * folds to a call that is neither completed nor failed, and projects nothing.
 */
describe('projectToolResultFrame', () => {
  const live = { turn: 7, step: 3 }

  it('codex 收尾帧投影出 tool/result，输出取 rawOutput.formatted_output', () => {
    // Real capture: codex has no `content` at all — the result text lives only
    // in `rawOutput.formatted_output`, the field the end-of-turn fold reads.
    const frames = captured['codex']!['tool'] as AcpFrame[]
    const event = projectToolResultFrame(frames[1]!, { ...live, dialect: codexDialect })
    expect(event?.type).toBe('tool/result')
    const payload = event!.payload as {
      turn: number
      step: number
      message: { role: string; toolCallId: string; isError: boolean; content: { type: string; text: string }[] }
    }
    expect(payload.turn).toBe(7)
    expect(payload.step).toBe(3)
    expect(payload.message.role).toBe('tool')
    expect(payload.message.toolCallId).toBe('exec-d1c91a22-fdf4-49f3-8b82-c901f115da4c')
    expect(payload.message.isError).toBe(false)
    expect(payload.message.content).toEqual([{ type: 'text', text: expect.stringContaining('total 544') }])
  })

  it('claude 收尾帧同样成立', () => {
    const frames = captured['claude']!['tool'] as AcpFrame[]
    const event = projectToolResultFrame(frames[3]!, { ...live, dialect: claudeDialect })
    expect(event?.type).toBe('tool/result')
    const payload = event!.payload as { message: { toolCallId: string; content: { text: string }[] } }
    expect(payload.message.toolCallId).toBe('chatcmpl-tool-bf330e1a077781f6')
    expect(payload.message.content.map(part => part.text).join('')).toContain('total 544')
  })

  it('grok 收尾帧同样成立', () => {
    const frames = captured['grok']!['tool'] as AcpFrame[]
    const event = projectToolResultFrame(frames[4]!, { ...live, dialect: grokDialect })
    expect(event?.type).toBe('tool/result')
    const payload = event!.payload as { message: { toolCallId: string; content: { text: string }[] } }
    expect(payload.message.toolCallId).toBe('call-d0f9391e-a336-4eed-bc3a-81344b79a72f-0')
    expect(payload.message.content.map(part => part.text).join('')).toContain('THREADHARBOR_TOOL_OK')
  })

  it('开场帧与 in_progress 帧都不是收尾帧，返回 undefined', () => {
    // The live writer must not write a result before the agent finished —
    // the frames before the terminal one carry progress, not an outcome.
    const codex = captured['codex']!['tool'] as AcpFrame[]
    expect(projectToolResultFrame(codex[0]!, { ...live, dialect: codexDialect })).toBeUndefined()
    const claude = captured['claude']!['tool'] as AcpFrame[]
    // Opening tool_call(pending), the in-progress tick and the toolResponse
    // tick all fold to a call that has not settled yet.
    expect(projectToolResultFrame(claude[0]!, { ...live, dialect: claudeDialect })).toBeUndefined()
    expect(projectToolResultFrame(claude[1]!, { ...live, dialect: claudeDialect })).toBeUndefined()
    expect(projectToolResultFrame(claude[2]!, { ...live, dialect: claudeDialect })).toBeUndefined()
    const grok = captured['grok']!['tool'] as AcpFrame[]
    expect(projectToolResultFrame(grok[2]!, { ...live, dialect: grokDialect })).toBeUndefined()
  })

  it('failed 收尾帧投影成错误结果，与回合末投影同形', () => {
    const frame: AcpFrame = { method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'failed', content: [{ type: 'text', text: 'boom' }] } } }
    const event = projectToolResultFrame(frame, { ...live, dialect: claudeDialect })
    expect(event?.type).toBe('tool/result')
    expect((event!.payload as { message: { isError: boolean } }).message.isError).toBe(true)
    expect(event!.payload as { error?: unknown }).toHaveProperty('error')
  })
})
