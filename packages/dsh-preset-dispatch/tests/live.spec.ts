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
import { adaptClient } from '../src/factory.ts'
import { AcpAssistantStream } from '../src/stream.ts'
import { makeContentWriter, UNDELIVERED } from '../src/content-writer.ts'
import { projectStepContent } from '@threadharbor/dsh-acp-agent'
import { claudeDialect } from '@threadharbor/dsh-acp-agent'
import { codexDialect } from '@threadharbor/dsh-acp-agent'
import { grokDialect } from '@threadharbor/dsh-acp-agent'
import { bridgePermissions } from '@threadharbor/dsh-acp-agent'
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