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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectStepContent } from '../src/projection.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { cursorDialect } from '../src/dialects/cursor.ts'
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

/**
 * cursor publishes one delegation twice (bundle 2026.10.01, measured
 * 2026-10-21): a `task` tool call with the full prompt and agent name, and a
 * native `subagent_spawned`/`subagent_state_update` pair whose `task` is
 * truncated. `_meta.cursor.toolCallId` joins them (in the same newline-joined
 * form the tool frames use — cursor joins two ids). One card, one child.
 */
describe('cursor delegation published twice', () => {
  const RAW_ID = 'call-1\nfc-1_0'
  const CALL_ID = 'call-1fc-1_0'

  const dispatch = rootUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: RAW_ID,
    kind: 'other',
    status: 'pending',
    rawInput: { _toolName: 'task', prompt: 'build the thing', description: 'design-work' },
  })
  const dispatchDone = rootUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: RAW_ID,
    status: 'completed',
  })
  const cursorSpawn = rootUpdate({
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: CHILD,
    name: 'generalPurpose',
    task: 'build the',
    capabilities: {},
    _meta: { cursor: { toolCallId: RAW_ID } },
  })

  it('keeps one card, joined by _meta.cursor.toolCallId, with the dispatch’s full task', () => {
    const events = projectStepContent(
      [dispatch, cursorSpawn, dispatchDone, childReply('done'), settled('completed')],
      { turn: 1, step: 1, dialect: cursorDialect },
    )

    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls).toHaveLength(1)
    const card = calls[0]!.payload as CallPayload
    expect(card.callId).toBe(CALL_ID)
    expect(card.name).toBe('subagent')
    expect(JSON.parse(card.arguments)).toEqual({ prompt: 'build the thing', agent: 'design-work' })
  })

  it('settles on the native state, not on the dispatch call’s completed frame', () => {
    const events = projectStepContent(
      [dispatch, cursorSpawn, dispatchDone, childReply('done'), settled('completed')],
      { turn: 1, step: 1, dialect: cursorDialect },
    )

    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect((results[0]!.payload as ResultPayload).message.content.map(part => part.text).join('')).toBe('done')
    expect((results[0]!.payload as ResultPayload).message.isError).toBe(false)
  })

  it('reports still running when only the dispatch call completed', () => {
    const events = projectStepContent(
      [dispatch, cursorSpawn, dispatchDone, childReply('working')],
      { turn: 1, step: 1, dialect: cursorDialect },
    )

    const text = (resultOf(events).message.content).map(part => part.text).join('')
    expect(text).toContain('[still running]')
    expect(text).toContain('working')
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

  it('认得 cursor 自己的 task 工具：子代理派发也落成 subagent 卡片', () => {
    // 2026-10-21 真机抓帧（桌面版 cursor 会话）：cursor 用自己的 `task` 工具派
    // 子代理，ACP 帧里工具名是 "other"，原工具名在 rawInput._toolName，任务在
    // prompt，代理名在 description。不认它，界面就只剩一张叫 "other" 的卡片，
    // 子代理不展现。
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      kind: 'other',
      status: 'pending',
      rawInput: {
        _toolName: 'task',
        prompt: '你是 design-work 独立子代理。只做方案设计。',
        description: '技能统一 design-work',
      },
    }
    const projected = projectStepContent([rootUpdate(update)], {
      dialect: cursorDialect,
      turn: 1,
      step: 1,
    })
    const call = projected.find(event => event.type === 'tool/call')
    expect(call).toBeDefined()
    const payload = (call as { payload: { name: string; arguments: string } }).payload
    expect(payload.name).toBe('subagent')
    expect(JSON.parse(payload.arguments)).toEqual({
      prompt: '你是 design-work 独立子代理。只做方案设计。',
      agent: '技能统一 design-work',
    })
  })

  it('cursor 的别的工具（updateTodos）不认成子代理', () => {
    const update = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-2',
      kind: 'other',
      status: 'pending',
      rawInput: { _toolName: 'updateTodos' },
    }
    const projected = projectStepContent([rootUpdate(update)], {
      dialect: cursorDialect,
      turn: 1,
      step: 1,
    })
    const call = projected.find(event => event.type === 'tool/call')
    const payload = (call as { payload: { name: string } }).payload
    expect(payload.name).not.toBe('subagent')
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

/**
 * grok's private subagent vocabulary, pinned to a REAL capture
 * (2026-10-20, grok 1.0.60 over its own serve): grok does not implement the
 * draft's kinds or field spellings — it sends `subagent_spawned` with
 * `child_session_id` / `subagent_type` / `description` (no `task`), a
 * metrics-only `subagent_progress`, and `subagent_finished` carrying the
 * child's final `output` and `status`. All three ride the PARENT session id;
 * no child-tagged content frames exist. The dialect normalizes them onto the
 * draft shape the shared projection already speaks.
 */
describe('grok private subagent vocabulary (real capture)', () => {
  const captured = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/captured-subagent-frames.json', import.meta.url)), 'utf8'),
  ) as { grok: { frames: AcpFrame[] } }
  const frames = captured.grok.frames

  it('maps the spawned/finished pair onto the subagent card with the child’s output', () => {
    const events = projectStepContent(frames, { turn: 1, step: 1, dialect: grokDialect })

    const card = events.find(event => event.type === 'tool/call'
      && (event.payload as { name: string }).name === 'subagent')
    expect(card, 'grok 的子代理帧必须投成 subagent 卡片').toBeDefined()
    const payload = card!.payload as { callId: string; arguments: string }
    expect(payload.callId).toBe('01a144de-463c-7940-8014-aa00e9ab009f')
    expect(JSON.parse(payload.arguments)).toMatchObject({
      prompt: 'Trivial arithmetic check',
      agent: 'general-purpose',
    })
    const results = events.filter(event => event.type === 'tool/result')
    const sub = results.find(event => (event.payload as { message: { toolCallId?: string } }).message?.toolCallId === payload.callId)
    expect(sub, 'the subagent card must settle with a result').toBeDefined()
    const text = ((sub!.payload as { message: { content: { text: string }[] } }).message.content ?? []).map(p => p.text).join('')
    expect(text).toContain('4')
  })

  it('keeps the spawn tool call its own card beside the subagent card', () => {
    // grok reports the delegation BOTH ways: the ordinary `spawn_subagent`
    // tool call and the subagent lifecycle frames. The tool card stays (the
    // call is real, with its arguments), the lifecycle adds the run view.
    const events = projectStepContent(frames, { turn: 1, step: 1, dialect: grokDialect })
    const names = events.filter(event => event.type === 'tool/call')
      .map(event => (event.payload as { name: string }).name)
    expect(names).toContain('spawn_subagent')
    expect(names).toContain('subagent')
  })

  it('keeps the parent’s own answer in the parent message', () => {
    const events = projectStepContent(frames, { turn: 1, step: 1, dialect: grokDialect })
    const message = events.find(event => event.type === 'assistant/message')!.payload as {
      message: { content: { type: string; text: string }[] }
    }
    const text = message.message.content.filter(b => b.type === 'text').map(b => b.text).join('')
    expect(text).toContain('The subagent returned `4`.')
  })
})

/**
 * The draft path pinned to REAL captures (2026-10-20, after the client began
 * advertising the subagent capability through both the draft field and the
 * `_meta.jetbrains.air` fallback): codex and claude send exactly the draft
 * shapes the synthetic tests above encode. These hold the projection to the
 * live wire, the way the grok capture below does for its private vocabulary.
 */
describe('draft subagent frames against real captures', () => {
  const captured = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/captured-subagent-frames.json', import.meta.url)), 'utf8'),
  ) as Record<string, { frames: AcpFrame[] }>

  it('codex: a real collab delegation projects onto the subagent card', () => {
    const events = projectStepContent(captured['codex']!.frames, { turn: 1, step: 1, dialect: codexDialect })
    const card = events.find(event => event.type === 'tool/call'
      && (event.payload as { name: string }).name === 'subagent')
    expect(card).toBeDefined()
    expect(JSON.parse((card!.payload as { arguments: string }).arguments)).toMatchObject({ agent: 'Calculate' })
    const sub = events.find(event => event.type === 'tool/result'
      && (event.payload as { message: { toolCallId?: string } }).message?.toolCallId === (card!.payload as { callId: string }).callId)
    expect(sub).toBeDefined()
    expect((sub!.payload as { message: { isError?: boolean } }).message.isError).toBe(false)
  })

  it('claude: a real Task delegation projects onto the subagent card with the verbatim task', () => {
    const events = projectStepContent(captured['claude']!.frames, { turn: 1, step: 1, dialect: claudeDialect })
    const card = events.find(event => event.type === 'tool/call'
      && (event.payload as { name: string }).name === 'subagent')
    expect(card).toBeDefined()
    expect(JSON.parse((card!.payload as { arguments: string }).arguments))
      .toMatchObject({ prompt: 'Compute 6*7. Reply with just the number, nothing else.' })
  })
})
