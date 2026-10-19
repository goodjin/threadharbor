/**
 * Mid-turn tool-card writing.
 *
 * The turn used to write the session log once, at its end, so even frame-ordered
 * events appeared only when everything was over. Now the runner writes each
 * tool's opening card the moment its first frame arrives — the card exists in
 * the log while the agent is still working — and the turn-end write carries
 * only what is left: the step's message and results not already committed. A card is written
 * exactly once, pre-abort writes are kept (post-abort frames were already
 * dropped by the runner's abort flag), and the payloads are the projection's
 * own, so the writer pairs results to the mid-turn call by the same
 * `turn:callId` key as ever.
 *
 * The claude frames below carry real statuses; the dialect, the projection and
 * the content writer are the real ones, and only the session append and the
 * agent's clock stand in.
 */

import type { AcpDialect, AcpFrame } from '@threadharbor/dsh-acp-agent'
import { claudeDialect, cursorDialect, projectStepContent } from '@threadharbor/dsh-acp-agent'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { StepDecisionLike, TurnContext } from '../src/dispatch.ts'
import { makeContentWriter } from '../src/content-writer.ts'
import type { ContentWriter } from '../src/content-writer.ts'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'

const DECISION: StepDecisionLike = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'list the files' }] }],
}

const update = (fields: Record<string, unknown>): AcpFrame['params'] => ({
  sessionId: 'ext',
  update: fields,
})

const openFrame: AcpFrame = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'in_progress' }),
}
const tickFrame: AcpFrame = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }),
}
const doneFrame: AcpFrame = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'text', text: 'ok' }] }),
}
const secondFrame: AcpFrame = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Read', status: 'in_progress' }),
}
const secondDoneFrame: AcpFrame = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', content: [{ type: 'text', text: 'file' }] }),
}
const answerFrame: AcpFrame = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }),
}

/** What the session log received, in arrival order. */
type Append = { type: string; payload: Record<string, unknown>; intent?: { surfaceOp?: string; sourceEventSeqs?: readonly number[] } }

function recordingWrite(order: string[]): { write: ContentWriter; appends: Append[] } {
  const appends: Append[] = []
  const write = makeContentWriter((type, payload, intent) => {
    appends.push({ type, payload: payload as Record<string, unknown>, ...(intent === undefined ? {} : { intent }) })
    order.push(`append:${type}`)
    return { seq: appends.length }
  })
  return { write, appends }
}

/** The turn as the dispatch wires it: the real projection over the real dialect. */
function turnOf(write: ContentWriter, position = { turn: 4, step: 2 }, dialect: AcpDialect = claudeDialect): TurnContext {
  return {
    sessionId: 'dsh1',
    position,
    produce: result => projectStepContent(result.frames, { turn: position.turn, step: position.step, dialect }),
    write,
  }
}

type Harness = {
  run: () => Promise<{ end: { kind: string } }>
  /** Resolves once the runner is inside its pending prompt and can see frames. */
  started: () => Promise<void>
  release: () => void
  order: string[]
  appends: Append[]
  push: (frames: readonly AcpFrame[]) => void
}

/**
 * A runner against an agent whose prompt hangs until `release` — the shape of
 * a real turn, where frames arrive while the agent is still working.
 */
function harness(options: { dialect?: AcpDialect; abort?: () => AbortSignal }): Harness {
  let deliver: ((frame: AcpFrame) => void) | undefined
  let releasePrompt: () => void
  const order: string[] = []
  let markStarted: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const client: AcpClientPort = {
    onFrame: handler => { deliver = handler },
    notify: () => {},
    request: async method => {
      if (method === 'initialize') return {}
      if (method === 'session/new') return { sessionId: 'ext' }
      if (method === 'session/prompt') {
        markStarted()
        await new Promise<void>(resolve => {
          releasePrompt = () => { order.push('reply-resolved'); resolve() }
        })
        return { stopReason: 'end_turn' }
      }
      return {}
    },
  }
  const { write, appends } = recordingWrite(order)
  const runner = new AcpTurnRunner(client, {
    cwd: '/tmp',
    ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
    ...(options.abort === undefined ? {} : { abort: options.abort }),
  })
  const running = runner.run(DECISION, turnOf(write, undefined, options.dialect))
  return {
    run: () => running,
    started: () => started.then(() => new Promise<void>(resolve => { setTimeout(resolve, 0) })),
    release: () => releasePrompt(),
    order,
    appends,
    push: frames => {
      for (const frame of frames) deliver!(frame)
    },
  }
}

describe('mid-turn tool-card writing', () => {
  it('失败结果立即关闭卡片，回合结束不再追加同一个结果', async () => {
    const h = harness({ dialect: claudeDialect })
    await h.started()
    h.push([openFrame, { ...doneFrame, params: update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'text', text: 'failed edit' }] }) }])
    const results = h.appends.filter(a => a.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]!.payload).toMatchObject({ message: { isError: true } })
    h.release()
    await h.run()
    expect(h.appends.filter(a => a.type === 'tool/result')).toHaveLength(1)
  })

  it('writes the opening card while the agent is still working, before the reply resolves', async () => {
    const turn1 = harness({ dialect: claudeDialect })
    await turn1.started()
    turn1.push([openFrame, tickFrame, answerFrame])

    // The card exists in the log now, with the agent's answer still pending.
    expect(turn1.order).toContain('append:tool/call')
    expect(turn1.order).not.toContain('reply-resolved')

    turn1.release()
    await turn1.run()

    // The turn end brings the message and the result, and never a second card.
    // Each live card is preceded by its one-block announcement message; the
    // turn-end message keeps only the answer text, its blocks already filed.
    expect(turn1.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'assistant/message', 'tool/result'])
    // The result is paired to the mid-turn card, not orphaned. The card is the
    // second append (the announcement took seq 1), so its sequence is 2.
    expect(turn1.appends[3]!.intent?.sourceEventSeqs).toEqual([2])
  })

  it('writes each call exactly once, however many updates follow it', async () => {
    const turn1 = harness({ dialect: claudeDialect })
    await turn1.started()
    turn1.push([openFrame, tickFrame, secondFrame, doneFrame, secondDoneFrame, answerFrame])
    turn1.release()
    await turn1.run()

    const calls = turn1.appends.filter(append => append.type === 'tool/call')
    expect(calls.map(append => append.payload['callId'])).toEqual(['t1', 't2'])
    const results = turn1.appends.filter(append => append.type === 'tool/result')
    // Each result pairs to its own card by sequence number: the first card is
    // seq 2 (its announcement took seq 1), the second seq 4.
    expect(results.map(append => append.intent?.sourceEventSeqs)).toEqual([[2], [4]])
  })

  it('keeps pre-abort cards and writes nothing for frames that arrive after the stop', async () => {
    const abort = new AbortController()
    const turn1 = harness({ dialect: claudeDialect, abort: () => abort.signal })
    await turn1.started()
    turn1.push([openFrame])
    // The announcement and the card land together, before the reply resolves.
    expect(turn1.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call'])

    // The user stops: the still-running call stays (it was real), the late
    // completion and the next call never reach the log.
    abort.abort()
    // The open card closes at the stop itself, not at the turn end: whatever
    // ends the turn next (a gateway watchdog settling the stream without the
    // run) may close the step before this runner's final write, and a card
    // left open there makes the whole session unloadable.
    expect(turn1.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'tool/result'])
    const closed = turn1.appends[2]!.payload as { message?: { isError?: boolean; toolCallId?: string } }
    expect(closed.message?.toolCallId).toBe('t1')
    expect(closed.message?.isError).toBe(true)

    turn1.push([doneFrame, secondFrame])
    turn1.release()
    const result = await turn1.run()

    expect(result.end.kind).toBe('aborted')
    // Exactly one result for the kept call — the interrupt write — and the
    // post-abort call and the completion frame reached nothing.
    expect(turn1.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'tool/result'])
    const ids = turn1.appends.map(append => append.payload['callId'] ?? (append.payload as { message?: { toolCallId?: string } }).message?.toolCallId)
    expect(ids.filter((id): id is string => id !== undefined)).toEqual(['t1', 't1'])
    expect(turn1.appends.some(append => append.payload['callId'] === 't2')).toBe(false)
  })

  it('carries the loop-announced turn and step on the mid-turn card', async () => {
    const turn1 = harness({ dialect: claudeDialect })
    await turn1.started()
    // The answer frame makes the step's message the first turn-end event, so
    // the card at appends[0] can only be the mid-turn write.
    turn1.push([openFrame, answerFrame])
    turn1.release()
    await turn1.run()
    // The announcement takes appends[0]; the card it precedes is appends[1].
    // The card name goes through toolNameMap ("Bash" → DSH "bash"), same as
    // the end-of-turn projection writes it.
    expect(turn1.appends[1]!.payload).toMatchObject({ turn: 4, step: 2, callId: 't1', name: 'bash' })
  })

  it('mid-turn card payload is identical to the end-of-turn projection’s own card', async () => {
    // The same frame through both paths — the turn-end projection and the
    // mid-turn writer — must produce the same payload, or the writer would
    // pair a result against a card shape nobody recognises.
    const oldPath = projectStepContent([openFrame, answerFrame], { turn: 4, step: 2, dialect: claudeDialect })
      .find(event => event.type === 'tool/call')!
    const turn1 = harness({ dialect: claudeDialect })
    await turn1.started()
    // The answer frame makes the step's message the first turn-end event, so
    // the card at appends[0] can only be the mid-turn write.
    turn1.push([openFrame, answerFrame])
    turn1.release()
    await turn1.run()
    // The announcement takes appends[0]; the mid-turn card is appends[1].
    expect(turn1.appends[1]!.type).toBe('tool/call')
    expect(turn1.appends[1]!.payload).toEqual(oldPath.payload)
  })

  it('writes a cursor call whose id carries a newline exactly once', async () => {
    // Cursor concatenates two ids with a literal newline and the dialect
    // collapses it when folding (singleLineId). The written-set and the
    // turn-end strip must both key on the FOLDED id — the one the projected
    // card carries — or the strip misses and the card lands twice.
    const rawId = 'call_1\ncall_1_tail'
    const cursorOpen: AcpFrame = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: update({ sessionUpdate: 'tool_call', toolCallId: rawId, kind: 'execute', status: 'in_progress' }),
    }
    const cursorDone: AcpFrame = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: update({
        sessionUpdate: 'tool_call_update', toolCallId: rawId, status: 'completed',
        rawOutput: { exitCode: 0, stdout: 'ok', stderr: '' },
      }),
    }
    const turn1 = harness({ dialect: cursorDialect })
    await turn1.started()
    turn1.push([cursorOpen, cursorDone, answerFrame])
    turn1.release()
    await turn1.run()

    const calls = turn1.appends.filter(append => append.type === 'tool/call')
    const foldedId = rawId.replace(/[\r\n]+/g, '')
    // Exactly one card, and it is the folded id the end-of-turn path uses too.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload['callId']).toBe(foldedId)
    expect(calls[0]!.payload['callId']).not.toContain('\n')
    // The result is committed before the final answer, exactly once.
    expect(turn1.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'tool/result', 'assistant/message'])
  })

  it('produces a log the session validator admits: every call announced before it, none left open', async () => {
    // The bug this whole change exists for: the projection wrote `tool/call`
    // events with no `assistant/message` carrying a matching `tool-call`
    // block, so the log refused the session at open time ("does not match an
    // open turn and step"). Rebuild the ordered event stream the validator sees
    // and assert the two rules it enforces: a call is announced (by id, name
    // and arguments) before it appears, and the step closes with nothing open.
    const turn1 = harness({ dialect: claudeDialect })
    await turn1.started()
    turn1.push([openFrame, secondFrame, doneFrame, secondDoneFrame, answerFrame])
    turn1.release()
    await turn1.run()

    const announced = new Map<string, { name: string; arguments: string }>()
    const open = new Set<string>()
    for (const append of turn1.appends) {
      if (append.type === 'assistant/message') {
        const content = (append.payload as { message?: { content?: unknown } }).message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          const b = block as { type?: string; id?: string; name?: string; arguments?: string }
          if (b?.type === 'tool-call' && typeof b.id === 'string') {
            announced.set(b.id, { name: b.name ?? '', arguments: b.arguments ?? '' })
          }
        }
      } else if (append.type === 'tool/call') {
        const p = append.payload as { callId: string; name: string; arguments: string }
        const a = announced.get(p.callId)
        expect(a, `call ${p.callId} must be announced before it`).toBeDefined()
        expect(a!.name).toBe(p.name)
        expect(a!.arguments).toBe(p.arguments)
        open.add(p.callId)
      } else if (append.type === 'tool/result') {
        const toolCallId = (append.payload as { message?: { toolCallId?: string } }).message?.toolCallId
        if (typeof toolCallId === 'string') open.delete(toolCallId)
      }
    }
    expect(open.size, 'no call left open at the end of the step').toBe(0)
  })

  it('without a dialect the runner writes only at turn end, exactly as before', async () => {
    const turn1 = harness({})
    await turn1.started()
    turn1.push([openFrame, answerFrame])
    expect(turn1.order).not.toContain('append:tool/call')

    turn1.release()
    await turn1.run()
    // The old full shape: message, then call+result pairs, all at the end.
    expect(turn1.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'tool/result'])
    expect(turn1.order.indexOf('append:tool/call')).toBeGreaterThan(turn1.order.indexOf('reply-resolved'))
  })

  it('opens the subagent card the moment the spawn frame arrives, and pairs the child’s reply at turn end', async () => {
    // ACP subagent draft (#1992): the spawn frame is the card's opening
    // moment — the parent is still working — and the child's frames arrive
    // tagged with the child session id. The card must exist while the child
    // runs (that is the whole point of native subagent visibility), and the
    // turn end pairs the result to the live card, never a second one.
    const spawnedFrame: AcpFrame = {
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'ext', update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child-1', name: 'Researcher', task: 'find docs', capabilities: {} } },
    }
    const childReplyFrame: AcpFrame = {
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'child-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child reply' } } },
    }
    const settledFrame: AcpFrame = {
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'ext', update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-1', state: 'completed' } },
    }
    const turn1 = harness({ dialect: claudeDialect })
    await turn1.started()
    turn1.push([spawnedFrame])

    // The card exists in the log while the child is still working.
    expect(turn1.order).toContain('append:tool/call')
    expect(turn1.order).not.toContain('reply-resolved')

    turn1.push([childReplyFrame, settledFrame, answerFrame])
    turn1.release()
    await turn1.run()

    expect(turn1.appends.map(append => append.type)).toEqual(['assistant/message', 'tool/call', 'assistant/message', 'tool/result'])
    expect(turn1.appends[1]!.payload).toMatchObject({ name: 'subagent', callId: 'child-1' })
    // The parent's own message keeps only the parent's words; the child's
    // reply rides the paired result, keyed to the live card's sequence.
    const message = turn1.appends[2]!.payload as { message: { content: { type: string; text: string }[] } }
    expect(message.message.content).toEqual([{ type: 'text', text: 'done' }])
    const result = turn1.appends[3]!.payload as { message: { content: { text: string }[] } }
    expect(result.message.content.map(part => part.text).join('')).toBe('child reply')
    expect(turn1.appends[3]!.intent?.sourceEventSeqs).toEqual([2])
  })

  it('opens an async task card live, the same way', async () => {
    const spawnedFrame: AcpFrame = {
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'ext', update: { sessionUpdate: 'async_task_spawned', asyncTaskId: 'bg-1', name: 'watch', taskType: 'background_bash', description: 'pnpm watch', showInTranscript: true, canStop: true } },
    }
    const settledFrame: AcpFrame = {
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'ext', update: { sessionUpdate: 'async_task_state_update', asyncTaskId: 'bg-1', state: 'completed', summary: 'watch exited 0' } },
    }
    const turn1 = harness({ dialect: claudeDialect })
    await turn1.started()
    turn1.push([spawnedFrame])
    expect(turn1.order).toContain('append:tool/call')

    turn1.push([settledFrame, answerFrame])
    turn1.release()
    await turn1.run()

    expect(turn1.appends[1]!.payload).toMatchObject({ name: 'async_task', callId: 'task-bg-1' })
    const result = turn1.appends[3]!.payload as { message: { content: { text: string }[] } }
    expect(result.message.content.map(part => part.text).join('')).toBe('watch exited 0')
  })
})


describe('Cursor 的编辑过程使用真实帧', () => {
  const frames = JSON.parse(readFileSync(new URL('../../dsh-acp-agent/tests/fixtures/captured-frames.cursor-edit.json', import.meta.url), 'utf8')) as AcpFrame[]
  const edits = frames.filter(frame => (frame.params as { update: { toolCallId: string } }).update.toolCallId === 'edit-call\n1')

  it('等待编辑文件路径到达再登记卡片，完成帧到达就落结果，不等整轮结束', async () => {
    const h = harness({ dialect: cursorDialect })
    await h.started()
    h.push(edits.slice(0, 1))
    expect(h.appends).toEqual([])
    h.push(edits.slice(1, 3))
    const call = h.appends.find(a => a.type === 'tool/call')!
    expect(call.payload).toMatchObject({ name: 'edit', arguments: JSON.stringify({ path: '/tmp/cursor-fixture/sample.txt' }) })
    h.push(edits.slice(3))
    const results = h.appends.filter(a => a.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0]!.payload)).toContain('before')
    expect(JSON.stringify(results[0]!.payload)).toContain('after')
    expect(results[0]!.intent?.sourceEventSeqs).toEqual([2])
    expect(h.order).not.toContain('reply-resolved')
    h.push(edits.slice(3))
    h.release()
    await h.run()
    expect(h.appends.filter(a => a.type === 'tool/result')).toHaveLength(1)
  })

  it('完整投影按原始带换行的编号累积参数，保留编辑名称与路径', () => {
    const events = projectStepContent(edits, { turn: 1, step: 1, dialect: cursorDialect })
    expect(events.find(e => e.type === 'tool/call')?.payload).toMatchObject({ name: 'edit', arguments: JSON.stringify({ path: '/tmp/cursor-fixture/sample.txt' }) })
    expect(events.filter(e => e.type === 'tool/result')).toHaveLength(1)
  })

  it('文件读取的结果在整轮仍运行时可见', async () => {
    const h = harness({ dialect: cursorDialect })
    await h.started()
    h.push(frames.filter(frame => (frame.params as { update: { toolCallId: string } }).update.toolCallId === 'read-call\n1'))
    expect(h.appends.filter(a => a.type === 'tool/result')).toHaveLength(1)
    expect(JSON.stringify(h.appends)).toContain('before')
    h.release()
    await h.run()
  })
})
