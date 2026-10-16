/**
 * Native subagent and async-task frames through the shared projection.
 *
 * The frame shapes here follow the ACP subagent draft
 * (agentclientprotocol/agent-client-protocol#1992) as implemented by the
 * adapters this machine actually runs — codex-acp 1.10.0 and
 * claude-agent-acp 0.76.0 (verified in their dist/ 2026-10-20). They are
 * dialect-independent: both adapters send the same update kinds once the
 * client declares `clientCapabilities.subagents`, so the shared projection —
 * not a dialect — owns them.
 *
 * What these tests pin:
 *   - a spawned subagent becomes the DSH `subagent` card (the name the
 *     reference client renders with a dedicated view), with the task and
 *     agent name in its arguments;
 *   - child-session frames (tagged with the child's sessionId) fold into
 *     that card's reply and never leak into the parent's answer text;
 *   - the state update settles the card, and an unsettled child reports
 *     "still running" instead of a silent success — the session log cannot
 *     close a step on an open tool call, so honesty has to live in the text.
 */

import { describe, expect, it } from 'vitest'
import { projectStepContent } from '../src/projection.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import type { AcpFrame } from '../src/acp-client.ts'

const ROOT = 'root-session'
const CHILD = 'child-session'

/** One root-tagged update frame. */
const rootUpdate = (update: Record<string, unknown>): AcpFrame => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: ROOT, update },
})

/** One update frame tagged with the subagent's own session id. */
const childUpdate = (update: Record<string, unknown>): AcpFrame => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId: CHILD, update },
})

const spawned = rootUpdate({
  sessionUpdate: 'subagent_spawned',
  subagentSessionId: CHILD,
  name: 'Researcher',
  task: 'Find the ACP subagent draft',
  capabilities: {},
})

const childReply = (text: string) => childUpdate({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
})

const settled = (state: string) => rootUpdate({
  sessionUpdate: 'subagent_state_update',
  subagentSessionId: CHILD,
  state,
})

const parentAnswer = rootUpdate({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'the parent answer' },
})

/** Read one projected event's payload with the fields these tests assert on. */
type CallPayload = { name: string; callId: string; arguments: string }
type ResultPayload = { message: { content: { text: string }[]; isError?: boolean } }

const callOf = (events: ReturnType<typeof projectStepContent>): CallPayload =>
  (events.find(event => event.type === 'tool/call')!.payload as CallPayload)
const resultOf = (events: ReturnType<typeof projectStepContent>): ResultPayload =>
  (events.find(event => event.type === 'tool/result')!.payload as ResultPayload)

describe('native subagent frames', () => {
  it('maps a spawned subagent onto the DSH subagent card with task and agent name', () => {
    const events = projectStepContent([spawned, childReply('found draft #1992'), settled('completed')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    const call = callOf(events)
    expect(call.name).toBe('subagent')
    expect(call.callId).toBe(CHILD)
    expect(JSON.parse(call.arguments)).toEqual({ prompt: 'Find the ACP subagent draft', agent: 'Researcher' })
  })

  it('settles the card with the child’s reply as the result text', () => {
    const events = projectStepContent([spawned, childReply('found draft #1992'), settled('completed')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    const result = resultOf(events)
    expect(result.message.content.map(part => part.text).join('')).toBe('found draft #1992')
    expect(result.message.isError).toBe(false)
  })

  it('keeps child-session frames out of the parent’s answer text', () => {
    // The child's reply rides its own card; if it also folded into the step
    // message, the parent transcript would show words the parent never said.
    const events = projectStepContent([spawned, childReply('child words'), parentAnswer, settled('completed')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    const message = events.find(event => event.type === 'assistant/message')!.payload as {
      message: { content: { type: string; text: string }[] }
    }
    // The card's announcement block rides the same message by design; the pin
    // is that no text block carries the child's words.
    expect(message.message.content.filter(block => block.type === 'text'))
      .toEqual([{ type: 'text', text: 'the parent answer' }])
  })

  it('raises no card for a tool call the child session made', () => {
    // Child tool frames describe the child's own work; surfacing them in the
    // parent transcript would duplicate what the subagent card summarizes.
    const events = projectStepContent([
      spawned,
      childUpdate({ sessionUpdate: 'tool_call', toolCallId: 'child-tool', kind: 'execute', title: 'ls' }),
      settled('completed'),
    ], { turn: 1, step: 1, dialect: codexDialect })

    expect(events.some(event => event.type === 'tool/call'
      && (event.payload as CallPayload).callId === 'child-tool')).toBe(false)
  })

  it('settles a failed subagent as an error result', () => {
    const events = projectStepContent([spawned, childReply('partial work'), settled('failed')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    expect(resultOf(events).message.isError).toBe(true)
  })

  it('reports a child still running at turn end instead of a silent success', () => {
    // The session log cannot close a step on an open tool call, so the card
    // must settle. An unlabelled empty success would claim work that never
    // reported back; the text says what actually happened.
    const events = projectStepContent([spawned, childReply('working on it')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    const text = resultOf(events).message.content.map(part => part.text).join('')
    expect(text).toContain('[still running]')
    expect(text).toContain('working on it')
    expect(resultOf(events).message.isError).toBe(false)
  })
})

describe('async task frames', () => {
  const TASK = 'task-7'

  const taskSpawned = rootUpdate({
    sessionUpdate: 'async_task_spawned',
    asyncTaskId: TASK,
    name: 'watch build',
    taskType: 'background_bash',
    description: 'pnpm run watch',
    showInTranscript: true,
    canStop: true,
  })
  const taskProgress = (summary: string) => rootUpdate({
    sessionUpdate: 'async_task_progress',
    asyncTaskId: TASK,
    summary,
    usage: { totalTokens: 1200, toolUses: 3, durationMs: 45000 },
  })
  const taskSettled = (state: string) => rootUpdate({
    sessionUpdate: 'async_task_state_update',
    asyncTaskId: TASK,
    state,
    summary: 'watch exited 0',
  })

  it('maps a background task onto its own card with the description as arguments', () => {
    const events = projectStepContent([taskSpawned, taskProgress('compiling…'), taskSettled('completed')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    const call = callOf(events)
    expect(call.name).toBe('async_task')
    expect(JSON.parse(call.arguments)).toMatchObject({ name: 'watch build', description: 'pnpm run watch' })
  })

  it('settles with the latest summary as the result text', () => {
    const events = projectStepContent([taskSpawned, taskProgress('compiling…'), taskSettled('completed')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    const text = resultOf(events).message.content.map(part => part.text).join('')
    expect(text).toContain('watch exited 0')
    expect(resultOf(events).message.isError).toBe(false)
  })

  it('marks a stopped task as an error result', () => {
    const events = projectStepContent([taskSpawned, taskSettled('stopped')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    expect(resultOf(events).message.isError).toBe(true)
  })

  it('reports a task still running at turn end', () => {
    const events = projectStepContent([taskSpawned, taskProgress('compiling…')], {
      turn: 1, step: 1, dialect: codexDialect,
    })

    const text = resultOf(events).message.content.map(part => part.text).join('')
    expect(text).toContain('[still running]')
    expect(text).toContain('compiling…')
  })
})
