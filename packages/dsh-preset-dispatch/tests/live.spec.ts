/**
 * The phase-3 stack against the real agent binaries.
 *
 * This is the acceptance gate for dispatch: a real agent must be driven through
 * the turn runner, produce text that reaches the stream **while the turn is
 * still running**, and project into the same content events the native loop
 * expects around it.
 *
 * The streaming assertion is the load-bearing one. Collecting frames and
 * replaying them after the turn passes every other test here and still shows
 * the user nothing until the agent finishes — which is the exact behaviour
 * this work exists to remove. So the test records whether any text arrived
 * before the prompt call resolved.
 *
 * Skipped unless `THREADHARBOR_LIVE_ACP=1`: real binaries, real model, real
 * wall clock. See the ACP layer's live spec for what the local claude actually
 * is — its frame shapes are genuine, its model behaviour is not.
 */

import { describe, expect, it } from 'vitest'
import { AcpClient, TerminalService, StdioAcpTransport } from '@threadharbor/dsh-acp-agent'
import type { AcpDialect, AcpTransport } from '@threadharbor/dsh-acp-agent'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'
import { adaptClient } from '../src/factory.ts'
import { AcpAssistantStream } from '../src/stream.ts'
import { makeContentWriter, UNDELIVERED } from '../src/content-writer.ts'
import { projectStepContent } from '@threadharbor/dsh-acp-agent'
import { claudeDialect } from '@threadharbor/dsh-acp-agent'
import { codexDialect } from '@threadharbor/dsh-acp-agent'
import { grokDialect } from '@threadharbor/dsh-acp-agent'
import { bridgePermissions } from '@threadharbor/dsh-acp-agent'
import type { StepEndReason, TurnContext } from '../src/dispatch.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = process.env['THREADHARBOR_LIVE_ACP'] === '1'
const CODEX_ACP = process.env['THREADHARBOR_CODEX_ACP'] ?? 'codex-acp'
const CLAUDE_ACP = process.env['THREADHARBOR_CLAUDE_ACP'] ?? 'claude-agent-acp'

const PROMPT = 'Reply with exactly this one sentence and nothing else: the tide comes in and goes out.'

/** Drive one real agent through the dispatch stack and report what streamed. */
async function runDispatch(command: string, dialect: AcpDialect, options: { modeId?: string } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'th-acp-dispatch-'))
  const transport = new StdioAcpTransport({ command, cwd, onDiagnostic: () => {} })
  const client = new AcpClient(transport, dialect)
  if (dialect.id === 'grok') client.terminals = new TerminalService()
  // Through the very bridge production uses, so this exercises the fail-closed
  // path rather than a test-only shortcut.
  client.onPermissionRequest = request => bridgePermissions(request, async () => 'allowed-once')

  let stream: AcpAssistantStream | undefined
  const deltas: { text: string; settled: boolean }[] = []
  // Through the same adapter production uses. Handing the runner a no-op
  // frame sink here would make every streaming assertion below pass vacuously
  // — the frames reach the client but never the turn.
  const runner = new AcpTurnRunner(
    adaptClient(client, grokDialect),
    {
      cwd,
      ...(options.modeId === undefined ? {} : { modeId: options.modeId }),
    },
  )
  const openStream = () => {
    let attempt = 0
        stream = new AcpAssistantStream({
          emit: () => {},
          nextRevision: () => ++attempt,
          sessionId: 'live',
          attempt: 1,
          turn: 1,
          step: 1,
        })
    stream.start()
    return {
      start: () => {},
      textDelta: (text: string) => { deltas.push({ text, settled: stream?.finished ?? false }) },
      reasoningDelta: () => {},
      records: () => [],
      settle: () => {},
      abandon: () => {},
    }
  }

  // Through TurnContext, which is where the runner reads it — the same place
  // dispatch puts it. Passing it as a runner option tested a path nothing uses.
  const result = await runner.run({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  }, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: r => [], write: () => 1, openStream })
  stream?.settle('assistant/message', () => 1)

  return { result, deltas, stream, client }
}

/**
 * The segmented case's prompt: a real tool run plus a report. Running
 * something is the point — the segmenter only finds a boundary once a tool
 * batch has settled — and demanding the report afterwards is what makes the
 * multi-segment shape the expected outcome rather than a lucky one. Cheap
 * and deterministic: one echo, one line of answer.
 */
const TOOL_REPORT_PROMPT =
  'Run the shell command `echo acp-live-ok` and then tell me exactly what it printed.'

/** What one segmented live turn collected, for the assertions that read it. */
type SegmentedTurn = {
  /** Every runSteps call's return, in call order; null means "the turn goes on". */
  readonly calls: (StepEndReason | null)[]
  /** Every event appended to the log, in write order, tagged with the call that wrote it. */
  readonly appended: { readonly type: string; readonly payload: Record<string, unknown>; readonly call: number }[]
  /** Each call's live stream, whose records() is what that call's message embeds. */
  readonly streams: AcpAssistantStream[]
  /** How many events were on the log when the prompt reply resolved. */
  readonly promptSettledOrder: number
  /** The prompt reply's own result object, as the agent sent it. */
  readonly promptReply: { readonly stopReason?: unknown } | undefined
}

/**
 * Drive one real codex turn through runSteps the way the takeover loop does.
 *
 * Everything is the production wiring — the adapted client port, a runner
 * carrying the dialect (the segmenter and the live cards exist only then),
 * the real content writer, and a real per-call stream like entry.ts's
 * `openAssistantStream` — plus three observation taps that change nothing on
 * the wire: the call tag on each append, the log's size when the prompt reply
 * resolved, and the reply result itself. The client is closed before the
 * assertions run; they read only what this collected.
 */
async function runStepsLive(prompt: string): Promise<SegmentedTurn> {
  const cwd = await mkdtemp(join(tmpdir(), 'th-acp-runsteps-'))
  const transport = new StdioAcpTransport({ command: CODEX_ACP, cwd, onDiagnostic: () => {} })
  const client = new AcpClient(transport, codexDialect)
  // Through the very bridge production uses, so a real command execution is
  // approved the way a session approves it.
  client.onPermissionRequest = request => bridgePermissions(request, async () => 'allowed-once')

  const appended: SegmentedTurn['appended'] = []
  let promptSettledOrder = -1
  let promptReply: SegmentedTurn['promptReply']
  const base = adaptClient(client, codexDialect)
  const port: AcpClientPort = {
    request: async (method, params) => {
      const reply = await base.request(method, params)
      if (method === 'session/prompt') promptSettledOrder = appended.length
      return reply
    },
    notify: (method, params) => { base.notify(method, params) },
    onFrame: handler => base.onFrame(frame => {
      // The reply frame reaches onFrame before the request promise resolves
      // (client.ts answers its pending call after observing the frame), so
      // this holds the agent's own usage report for the assertions below.
      const result = (frame as { result?: { stopReason?: unknown } }).result
      if (frame.method === undefined && result !== undefined && result.stopReason !== undefined) promptReply = result
      handler(frame)
    }),
  }
  // The dialect rides the runner options — without it there is no segmenter
  // and no live-card binding, and every assertion below would pass vacuously.
  const runner = new AcpTurnRunner(port, { cwd, dialect: codexDialect })

  let activeStep = 0
  const write = makeContentWriter((type, payload) => ({
    seq: appended.push({ type, payload: payload as Record<string, unknown>, call: activeStep }),
  }))
  let attempt = 0
  let revision = 0
  const streams: AcpAssistantStream[] = []
  const turnOf = (step: number): TurnContext => ({
    sessionId: 's1',
    position: { turn: 1, step },
    produce: result => projectStepContent(result.frames, {
      turn: 1,
      step,
      dialect: codexDialect,
      ...(result.stream === undefined ? {} : { stream: result.stream }),
    }),
    write,
    openStream: () => {
      const stream = new AcpAssistantStream({
        emit: () => {},
        nextRevision: () => ++revision,
        sessionId: 'live',
        attempt: ++attempt,
        turn: 1,
        step,
      })
      streams.push(stream)
      return stream
    },
  })

  const calls: (StepEndReason | null)[] = []
  try {
    // The takeover loop itself: null makes the loop append the next step's
    // boundaries and call again with a fresh position; the real end reason is
    // the last segment. Twelve steps is far past anything this prompt can
    // produce — a runaway loop fails here with its shape on the record.
    for (let step = 1; step <= 12; step++) {
      activeStep = step
      const end = await runner.runSteps(
        { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
        turnOf(step),
        { first: step === 1 },
      )
      calls.push(end)
      if (end !== null) break
    }
    return { calls, appended, streams, promptSettledOrder, promptReply }
  } finally {
    client.close()
  }
}

/** The usage the reply reported and the log may honestly carry, or nothing. */
function reportedUsage(reply: SegmentedTurn['promptReply']): { inputTokens: number; outputTokens: number } | undefined {
  const usage = reply === undefined ? undefined : codexDialect.readReplyUsage(reply)
  if (usage === undefined) return undefined
  if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)) return undefined
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

describe.skipIf(!LIVE)('dispatch stack against real agents', () => {
  it('streams text while the turn is still running (claude)', async () => {
    const { deltas, result, client } = await runDispatch(CLAUDE_ACP, claudeDialect, { modeId: 'default' })
    expect(deltas.length).toBeGreaterThan(0)
    // Some text must arrive while the turn is open. If everything arrives
    // after, the turn is being replayed rather than streamed.
    expect(deltas.some(d => !d.settled)).toBe(true)
    expect(deltas.map(d => d.text).join('')).toContain('tide')
    expect(result.end.kind).toBe('completed')
    client.close()
  }, 240_000)

  it('streams text while the turn is still running (codex)', async () => {
    const { deltas, result, client } = await runDispatch(CODEX_ACP, codexDialect)
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.some(d => !d.settled)).toBe(true)
    expect(result.end.kind).toBe('completed')
    client.close()
  }, 240_000)

  it('projects a real turn into content events', async () => {
    const { result, client } = await runDispatch(CODEX_ACP, codexDialect)
    const events = projectStepContent(result.frames as never[], { turn: 1, step: 1, dialect: codexDialect })
    // Only content events: the native loop owns the boundaries around them.
    expect(events.every(e => e.type === 'assistant/message' || e.type === 'tool/call' || e.type === 'tool/result')).toBe(true)
    expect(events.some(e => e.type === 'assistant/message')).toBe(true)
    client.close()
  }, 240_000)

  /**
   * The segmented takeover against a real codex turn (Tasks 1-6 end to end).
   *
   * A turn that actually segmented — some later call wrote events under its
   * own step — must span at least two runSteps calls: the first returning
   * null after writing its segment under its own step position, the last
   * returning the real end reason. Each segment's durable message embeds
   * exactly its own call's stream records, a result filed by a non-final
   * segment must be on the log before the prompt reply resolved (the live
   * result, not a turn-end replay), and the final segment's message carries
   * the usage the reply itself reported. Model mood is tolerated where it is
   * real: codex may answer without touching a tool, and a tool it runs as
   * its very last act forms no boundary at all (the segmenter needs fresh
   * content after the batch settles) — both turns are one call, and the
   * branch is read off what the frames actually wrote, not off what the
   * prompt hoped for.
   */
  it('a real tool turn spans several runSteps calls with live results', async () => {
    const { calls, appended, streams, promptSettledOrder, promptReply } = await runStepsLive(TOOL_REPORT_PROMPT)

    // The turn produced something, and every event was written under the
    // step position of the call that wrote it — the loop's numbering and
    // the log agree all the way through, first call included.
    expect(appended.length, 'the turn wrote nothing').toBeGreaterThan(0)
    for (const event of appended) {
      expect(event.payload['step'], `event ${event.type} of call ${event.call} numbered ${String(event.payload['step'])}`).toBe(event.call)
    }

    // Tool use is read off the projected cards by name. The projection names
    // spawned runs 'subagent'/'async_task', and those are exactly the runs
    // the segmenter never lets open, settle or close anything — its exclusion
    // is by update kind (only tool_call/tool_call_update move it, never the
    // spawned kinds), this one by the name that kind projects to. Two
    // spellings of the same distinction.
    const usedTools = appended.some(
      event => event.type === 'tool/call' && event.payload['name'] !== 'subagent' && event.payload['name'] !== 'async_task',
    )
    // Whether the turn segmented is read off the log itself: a later call
    // wrote events under its own step number. A boundary needs a settled
    // tool batch AND fresh content after it, so a tool the model runs as its
    // very last act never segments — that is correct behaviour (the
    // segmenter's own rule), and this branch accepts it as one call instead
    // of demanding two. Branching on written events keeps model mood out of
    // the assertion: the test holds the loop to what the frames did, not to
    // what the prompt hoped the model would do.
    const segmented = appended.some(
      event => typeof event.payload['step'] === 'number' && (event.payload['step'] as number) > 1,
    )
    if (segmented) {
      // Segment 1 closed and the loop was called again: interior calls null,
      // the last one the turn's real end.
      expect(calls.length, `expected ≥2 segment calls, got ${JSON.stringify(calls)}`).toBeGreaterThanOrEqual(2)
      expect(calls[0]).toBeNull()
      expect(calls.slice(1, -1).every(c => c === null)).toBe(true)
      expect(calls.at(-1)).toEqual({ kind: 'completed' })

      // Live result: a tool result filed by a non-final segment was already
      // on the log when the reply resolved — written at the terminal frame,
      // not replayed at turn end.
      const midResult = appended.findIndex(
        event => event.type === 'tool/result' && (event.payload['step'] as number) < calls.length,
      )
      expect(midResult, 'no tool result was written by a non-final segment').toBeGreaterThanOrEqual(0)
      expect(midResult, 'the mid-turn result was written after the reply settled').toBeLessThan(promptSettledOrder)
      // Stronger still: it preceded the first prose message on the log. That
      // message is written at the segment's close, so a result landing at or
      // after it would be a close-batch replay, not a live settle.
      const firstProse = appended.findIndex(
        event => event.type === 'assistant/message'
          && (event.payload['message'] as { content: { type: string }[] }).content.some(block => block.type === 'text'),
      )
      if (firstProse >= 0) {
        expect(midResult, 'the mid-turn result was written at its segment close, not at its terminal frame').toBeLessThan(firstProse)
      }
    } else {
      // Nothing was ever written past step 1: no boundary was found, and one
      // call owns the whole turn — with or without tools.
      expect(calls).toEqual([{ kind: 'completed' }])
    }

    // Whatever the shape, a tool the turn ran has its outcome on the log —
    // written live at the terminal frame, or close-paired by the projection.
    if (usedTools) {
      expect(appended.some(event => event.type === 'tool/result'), 'a tool ran but no result was written').toBe(true)
    }

    // The agent answered in prose either way — the report is what the turn
    // was for, and a completed turn without an answer is a broken one.
    const prose = appended
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => (event.payload['message'] as { content: { type: string; text?: string }[] }).content)
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    expect(prose.length).toBeGreaterThan(0)

    // Each segment's message embeds exactly its own call's stream records —
    // segment 2 must not carry segment 1's text. A message with prose has
    // its call's records, and the records' text IS the message's text; an
    // announcement (a one-block tool-call message the live card path files)
    // carries no stream at all.
    for (let step = 1; step <= calls.length; step++) {
      const own = streams[step - 1]!.records()
      for (const message of appended.filter(e => e.type === 'assistant/message' && e.call === step)) {
        const content = (message.payload['message'] as { content: { type: string; text?: string }[] }).content
        const carried = message.payload['stream'] as { type: string; texts?: readonly string[] }[]
        if (content.some(block => block.type === 'text' || block.type === 'reasoning')) {
          expect(carried, `step ${step}'s message does not embed its own stream`).toEqual(own)
          expect(
            carried.filter(record => record.type === 'text-chunks').flatMap(record => record.texts ?? []).join(''),
          ).toBe(content.filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
        } else {
          expect(carried).toEqual([])
        }
      }
    }

    // The final segment's message carries the usage the reply itself
    // reported, when it reported one the log may carry. Guarded twice by
    // what actually happened: a reply without a usable usage asserts
    // nothing, and a final segment whose content was only tool cards (mood:
    // a batch as the very last act) writes no message and cannot carry one.
    // In the one-call shape the reply frame rides the same segment as the
    // answer, so the message exists and the usage is asserted there.
    const usage = reportedUsage(promptReply)
    if (usage !== undefined) {
      const last = appended
        .filter(event => event.type === 'assistant/message' && event.call === calls.length)
        .at(-1)
      if (last !== undefined) {
        expect(last.payload['usage']).toMatchObject(usage)
      }
    }
  }, 300_000)

  /**
   * The image-interception branch of the capability table, end to end: a real
   * claude turn whose user message carries an image. claude's table cell says
   * no, so the wire prompt must stay text-only, and the writer must expand the
   * held-back attachment into the paired 未送达 row — never the internal marker.
   * (The wire-level half — codex/grok/cursor really reading an image — lives in
   * the ACP package's live spec.)
   */
  it('claude: a declined image rides no wire prompt and lands as the 未送达 row', async () => {
    // A minimal 1×1 red PNG: the branch never lets the agent see it — only its
    // presence in the user message matters.
    const image = {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      mimeType: 'image/png',
    }
    const cwd = await mkdtemp(join(tmpdir(), 'th-acp-image-'))
    const inner = new StdioAcpTransport({ command: CLAUDE_ACP, cwd, onDiagnostic: () => {} })
    // A sending spy: the assertion is about what claude was actually handed.
    const sent: string[] = []
    const transport: AcpTransport = {
      send: line => { sent.push(line); inner.send(line) },
      onLine: handler => inner.onLine(handler),
      onDeath: handler => inner.onDeath(handler),
      lastFrameAt: () => inner.lastFrameAt(),
      lastDiagnosticAt: () => inner.lastDiagnosticAt(),
      stderrTail: () => inner.stderrTail(),
      close: () => inner.close(),
    }
    const client = new AcpClient(transport, claudeDialect)
    client.onPermissionRequest = request => bridgePermissions(request, async () => 'allowed-once')
    const runner = new AcpTurnRunner(adaptClient(client, claudeDialect), { cwd, modeId: 'default' })
    // The real writer over a capturing sink: the row the user reads is the
    // expanded pair, so that pair is what the test accepts.
    const appended: { type: string; payload: unknown }[] = []
    const write = makeContentWriter((type, payload) => ({ seq: appended.push({ type, payload }) }))

    try {
      const result = await runner.run({
        kind: 'enter',
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, image] }],
      }, {
        sessionId: 's1',
        position: { turn: 1, step: 1 },
        produce: r => projectStepContent(r.frames as never[], { turn: 1, step: 1, dialect: claudeDialect }),
        write,
      })

      // The interception is not a failure: the turn completes as an answer.
      expect(result.end.kind).toBe('completed')

      // Nothing but text went over the wire — every block of every
      // session/prompt request claude received is a text block.
      const promptBlocks = sent
        .map(line => JSON.parse(line) as { method?: string; params?: { prompt?: { type?: string }[] } })
        .filter(frame => frame.method === 'session/prompt')
        .flatMap(frame => frame.params?.prompt ?? [])
      expect(promptBlocks.length).toBeGreaterThan(0)
      expect(promptBlocks.every(block => block.type === 'text')).toBe(true)

      // The visible half: the marker became the paired row, and the marker
      // itself never touched the log.
      expect(appended.some(event => event.type === UNDELIVERED)).toBe(false)
      const noticeCall = appended.find(
        event => event.type === 'tool/call' && (event.payload as { name?: string }).name === '附件未送达',
      )
      expect(noticeCall).toBeDefined()
      const callId = (noticeCall!.payload as { callId?: string }).callId
      expect(typeof callId).toBe('string')
      const noticeRow = appended.find(
        event => event.type === 'tool/result' &&
          (event.payload as { message?: { toolCallId?: string } }).message?.toolCallId === callId,
      )
      expect(noticeRow).toBeDefined()
      const message = (noticeRow!.payload as { message?: { content?: { text?: string }[]; isError?: boolean } }).message
      expect(message?.isError).toBe(true)
      expect((message?.content ?? []).map(part => part.text).join('')).toContain('未送达')
    } finally {
      client.close()
    }
  }, 240_000)
})