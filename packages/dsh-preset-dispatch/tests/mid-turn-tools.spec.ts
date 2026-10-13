/**
 * Mid-turn tool-card writing.
 *
 * The turn used to write the session log once, at its end, so even frame-ordered
 * events appeared only when everything was over. Now the runner writes each
 * tool's opening card the moment its first frame arrives — the card exists in
 * the log while the agent is still working — and the turn-end write carries
 * only what is left: the step's message and the results. A card is written
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
    expect(turn1.appends.map(append => append.type)).toEqual(['tool/call', 'assistant/message', 'tool/result'])
    // The result is paired to the mid-turn card, not orphaned.
    expect(turn1.appends[2]!.intent?.sourceEventSeqs).toEqual([1])
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
    expect(results.map(append => append.intent?.sourceEventSeqs)).toEqual([[1], [2]])
  })

  it('keeps pre-abort cards and writes nothing for frames that arrive after the stop', async () => {
    const abort = new AbortController()
    const turn1 = harness({ dialect: claudeDialect, abort: () => abort.signal })
    await turn1.started()
    turn1.push([openFrame])
    expect(turn1.appends.map(append => append.type)).toEqual(['tool/call'])

    // The user stops: the still-running call stays (it was real), the late
    // completion and the next call never reach the log.
    abort.abort()
    turn1.push([doneFrame, secondFrame])
    turn1.release()
    const result = await turn1.run()

    expect(result.end.kind).toBe('aborted')
    // The card stayed (mid-turn, before the stop); the turn end adds only the
    // result the end-of-turn projection has always written for a kept call —
    // empty, since the completion frame arrived after the stop and was
    // dropped. The post-abort call and the completion itself reached nothing.
    expect(turn1.appends.map(append => append.type)).toEqual(['tool/call', 'tool/result'])
    expect(turn1.appends.map(append => append.payload['callId'] ?? (append.payload as { message?: { toolCallId?: string } }).message?.toolCallId))
      .toEqual(['t1', 't1'])
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
    expect(turn1.appends[0]!.payload).toMatchObject({ turn: 4, step: 2, callId: 't1', name: 'Bash' })
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
    expect(turn1.appends[0]!.type).toBe('tool/call')
    expect(turn1.appends[0]!.payload).toEqual(oldPath.payload)
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
    // Everything else arrives once: the message and the paired result.
    expect(turn1.appends.map(append => append.type)).toEqual(['tool/call', 'assistant/message', 'tool/result'])
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
})
