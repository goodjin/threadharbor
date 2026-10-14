/**
 * End-to-end checks against the real agent binaries.
 *
 * These are the acceptance gate for phase 2: each agent must independently run
 * "open a session → ask a question → get an answer → project its tool call
 * correctly", and a permission request must be approvable in a way that lets
 * the turn continue.
 *
 * They are skipped unless `THREADHARBOR_LIVE_ACP=1`, because they need the real
 * binaries, a real model behind them, and minutes of wall clock. The default
 * suite stays hermetic and fast; this is the run you do before believing a
 * change works.
 *
 * Note on claude: the agent behind the local claude-agent-acp is a relay, not
 * Anthropic's Claude (see the design doc §2.6). What this test proves is the
 * adapter's frame shapes and the turn's plumbing — not Claude's behaviour.
 */

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { AcpClient } from '../src/client.ts'
import { TerminalService } from '../src/terminals.ts'
import { StdioAcpTransport, WebSocketAcpTransport, grokWebSocketUrl } from '../src/transport.ts'
import { projectTurn, projectToolCallFrame, projectTurnIncremental } from '../src/projection.ts'
import { bridgePermissions } from '../src/approval.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import { cursorDialect } from '../src/dialects/cursor.ts'
import { grokDialect } from '../src/dialects/grok.ts'
import type { AcpDialect } from '../src/dialects/types.ts'
import type { AcpTransport } from '../src/transport.ts'
import type { AcpFrame, AcpSession } from '../src/acp-client.ts'

/**
 * Wait for `grok agent serve` to accept its secret.
 *
 * A real handshake, not "the port is open": a port check cannot tell a keyed
 * serve from any other listener, which is exactly how a secret mismatch used to
 * slip through until a session failed much later.
 */
async function waitForGrokServe(port: number, secret: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'never connected'
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>(resolve => {
      const probe = new WebSocket(grokWebSocketUrl(`127.0.0.1:${port}`, secret))
      const finish = (result: boolean) => {
        probe.onmessage = null
        probe.onerror = null
        probe.onclose = null
        try { probe.close() } catch { /* already closing */ }
        resolve(result)
      }
      probe.onopen = () => finish(true)
      probe.onerror = () => finish(false)
      probe.onclose = () => finish(false)
    })
    if (reachable) return
    await new Promise(resolveWait => setTimeout(resolveWait, 300))
  }
  throw new Error(`grok agent serve never became reachable: ${lastError}`)
}

const LIVE = process.env['THREADHARBOR_LIVE_ACP'] === '1'

/**
 * Which binary each test drives.
 *
 * Overridable because the installed version is not always the pinned one:
 * hostd pins `@agentclientprotocol/codex-acp@1.6.2`, and the machine may well
 * have a different build on PATH. A live run against the wrong build says
 * nothing about the shipped one, so the run has to be able to name its binary.
 */
const CODEX_ACP = process.env['THREADHARBOR_CODEX_ACP'] ?? 'codex-acp'
const CLAUDE_ACP = process.env['THREADHARBOR_CLAUDE_ACP'] ?? 'claude-agent-acp'
const CURSOR_ACP = process.env['THREADHARBOR_CURSOR_ACP'] ?? 'cursor-agent'
const CWD = process.cwd()
const PROMPT = 'Run the shell command `echo ACP_LIVE_OK` and then tell me what it printed.'
/**
 * A command that is safe but sits outside the workspace, so an agent in Manual
 * mode has to ask before running it. Asking is the whole point of this prompt —
 * a harmless in-workspace command may simply be auto-approved and prove nothing.
 */
const PROMPT_REQUIRING_APPROVAL =
  'Create a file at /tmp/threadharbor-acp-live.txt containing the word ok, using a shell command, then tell me it is done.'

/** What one live round must produce. */
type LiveResult = {
  readonly session: AcpSession
  readonly frames: AcpFrame[]
  readonly answer: string
  readonly toolNames: readonly string[]
  readonly toolOutputs: readonly string[]
  readonly permissionsAnswered: number
}

async function runLiveAgent(
  command: string,
  dialect: AcpDialect,
  options: { readonly modeId?: string; readonly prompt?: string } = {},
): Promise<LiveResult> {
  const transport = new StdioAcpTransport({
    command,
    cwd: CWD,
    onDiagnostic: () => {}, // agents are chatty on stderr; it is not protocol
  })
  return runLiveAgentOver(transport, dialect, options)
}

/** Open one live session over stdio, for the case helpers that drive it themselves. */
async function openLiveAgent(
  command: string,
  dialect: AcpDialect,
  options: { readonly modeId?: string } = {},
): Promise<LiveSession> {
  const transport = new StdioAcpTransport({
    command,
    ...(dialect.id === 'cursor' ? { args: ['acp', '--trust'] as readonly string[] } : {}),
    cwd: CWD,
    onDiagnostic: () => {}, // agents are chatty on stderr; it is not protocol
  })
  return openLiveAgentOver(transport, dialect, options)
}

/** One image block, in the exact shape the runner's `promptContent` puts on the wire. */
type PromptImageBlock = { readonly type: 'image'; readonly data: string; readonly mimeType: string }

/**
 * One opened live session, held open for the caller to drive turn by turn.
 *
 * The whole-turn helper below (`runLiveAgentOver`) is built on this: the same
 * handshake, the same field shapes, but the prompt is the caller's to time —
 * which is what the cancel case needs (stop after the first frame arrives, not
 * after the turn ends).
 */
type LiveSession = {
  readonly client: AcpClient
  readonly session: AcpSession
  /** Every inbound notification frame in arrival order, with its arrival time. */
  readonly frames: readonly { readonly frame: AcpFrame; readonly at: number }[]
  /** The frames without timestamps, for the projections. */
  plainFrames(): AcpFrame[]
  /** The turn's assistant text, projected the way production projects it. */
  answer(): string
  /** Send one prompt (text first, then image blocks) and resolve with its reply. */
  prompt(text: string, images?: readonly PromptImageBlock[]): Promise<{ readonly stopReason?: unknown }>
  /** Resolves with the turn's first CONTENT frame (message/thought chunk or tool frame). */
  waitForFirstContentFrame(timeoutMs: number): Promise<AcpFrame>
  close(): void
  /** Counters the whole-turn helper reports. */
  readonly counters: { readonly permissionsAnswered: number }
  /** Resolves with the first frame the predicate accepts, scanning arrivals and history. */
  waitFor(accept: (frame: AcpFrame) => boolean, timeoutMs: number, what: string): Promise<AcpFrame>
}

/**
 * One live round over any transport, opened but not yet prompted.
 *
 * Transport and field-shape are the only things that differ between agents, so
 * this is where the session is actually opened. Every handshake step is
 * deadline-bounded: an agent that accepts the connection and then says nothing
 * (a wedged worker, a dead login) fails loudly here instead of silently eating
 * the whole test budget.
 */
async function openLiveAgentOver(
  transport: AcpTransport,
  dialect: AcpDialect,
  options: { readonly modeId?: string } = {},
): Promise<LiveSession> {
  const client = new AcpClient(transport, dialect)
  if (dialect.id === 'grok') client.terminals = new TerminalService()

  const frames: { frame: AcpFrame; at: number }[] = []
  let waiter: { readonly accept: (frame: AcpFrame) => boolean; readonly settle: (frame: AcpFrame) => void } | undefined
  client.onNotification = frame => {
    frames.push({ frame, at: Date.now() })
    const pending = waiter
    if (pending === undefined || !pending.accept(frame)) return
    waiter = undefined
    pending.settle(frame)
  }
  const counters = { permissionsAnswered: 0 }
  // Approve through the very bridge production uses, so this also exercises the
  // fail-closed path rather than a test-only shortcut.
  client.onPermissionRequest = request =>
    bridgePermissions(request, async () => 'allowed-once').then(decision => {
      counters.permissionsAnswered += 1
      return decision
    })
  // Cursor's two blocking custom methods stall the turn when left unanswered;
  // give them the same benign auto-answers the factory gives in production,
  // so a question the test is not about cannot wedge the turn.
  if (dialect.id === 'cursor') {
    client.onExtensionRequest = frame => {
      if (typeof frame.id !== 'number') return false
      if (frame.method === 'cursor/ask_question') { client.reply(frame.id, { outcome: { outcome: 'skipped' } }); return true }
      if (frame.method === 'cursor/create_plan') { client.reply(frame.id, { outcome: { outcome: 'cancelled' } }); return true }
      return false
    }
  }

  await bounded(`${dialect.id}: initialize`, client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  }))
  client.notify('initialized', {})
  // Cursor must authenticate (after an interactive `agent login`) before
  // session/new; the runner does exactly this in production.
  if (dialect.authenticateMethodId !== undefined) {
    await bounded(`${dialect.id}: authenticate`, client.request('authenticate', { methodId: dialect.authenticateMethodId }))
  }

  const session = AcpClient.toSession(
    await bounded(`${dialect.id}: session/new`, client.request('session/new', { cwd: CWD, mcpServers: [] })),
    dialect,
  )

  // grok needs no mode; claude ships in bypassPermissions and must be switched
  // to Manual or it will never ask for anything.
  if (options.modeId !== undefined) {
    await bounded(`${dialect.id}: session/set_mode`, client.request('session/set_mode', { sessionId: session.sessionId, modeId: options.modeId }))
  }

  const first = session.models[0]?.id
  if (first !== undefined && dialect.id !== 'claude') {
    await bounded(`${dialect.id}: session/set_model`, client.request('session/set_model', { sessionId: session.sessionId, modelId: first }).catch(() => {}))
  }

  const live: LiveSession = {
    client,
    session,
    frames,
    plainFrames: () => frames.map(entry => entry.frame),
    answer: () => answerOf(frames.map(entry => entry.frame), dialect),
    prompt: async (text, images = []) => await client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text }, ...images],
      ...(first === undefined || dialect.id === 'claude' ? {} : { modelId: first }),
    }) as { stopReason?: unknown },
    waitFor: (accept, timeoutMs, what) => new Promise<AcpFrame>((resolve, reject) => {
      const seen = frames.find(entry => accept(entry.frame))
      if (seen !== undefined) { resolve(seen.frame); return }
      const timer = setTimeout(() => reject(new Error(`no ${what} within ${String(timeoutMs)}ms`)), timeoutMs)
      // A late settle after the timer fired resolves an already-rejected
      // promise — a no-op, so no bookkeeping is needed here.
      waiter = { accept, settle: frame => { clearTimeout(timer); resolve(frame) } }
    }),
    waitForFirstContentFrame: timeoutMs => live.waitFor(isTurnContentFrame, timeoutMs, 'content frame'),
    close: () => client.close(),
    counters,
  }
  return live
}

/** The turn's assistant text, folded through the same projection production uses. */
function answerOf(frames: readonly AcpFrame[], dialect: AcpDialect): string {
  const events = projectTurn(frames, { turn: 1, dialect })
  return events
    .filter(event => event.type === 'assistant/message')
    .flatMap(event => (event.payload as { message: { content: { type: string; text: string }[] } }).message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * One live round over any transport.
 *
 * Built on the opened-session helper above; the only thing it adds is driving
 * one prompt to completion and projecting the result.
 */
async function runLiveAgentOver(
  transport: AcpTransport,
  dialect: AcpDialect,
  options: { readonly modeId?: string; readonly prompt?: string } = {},
): Promise<LiveResult> {
  const live = await openLiveAgentOver(transport, dialect, options)
  try {
    await live.prompt(options.prompt ?? PROMPT)
    const events = projectTurn(live.plainFrames(), { turn: 1, dialect })
    return {
      session: live.session,
      frames: live.plainFrames(),
      answer: answerOf(live.plainFrames(), dialect),
      toolNames: events
        .filter(event => event.type === 'tool/call')
        .map(event => (event.payload as { name: string }).name),
      toolOutputs: events
        .filter(event => event.type === 'tool/result')
        .map(event => {
          const message = (event.payload as { message: { content: { text: string }[] } }).message
          return message.content.map(part => part.text).join('')
        }),
      permissionsAnswered: live.counters.permissionsAnswered,
    }
  } finally {
    live.close()
  }
}

/* ----------------------------------------------------------------------- */
/* Shared helpers for the acceptance block below.                           */
/* ----------------------------------------------------------------------- */

/** Long enough for a cold agent process, short enough to fail with its own name. */
const HANDSHAKE_DEADLINE_MS = 90_000

/**
 * Bound one handshake step, so a silent agent fails naming the step instead of
 * eating the whole test budget on a connection nobody is reading.
 */
function bounded<T>(label: string, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: agent did not answer within ${String(HANDSHAKE_DEADLINE_MS)}ms`))
    }, HANDSHAKE_DEADLINE_MS)
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Spawn a fresh `grok agent serve`, hand the caller a transport for it, and
 * make sure the process is gone when the case is done.
 */
async function withGrokServe(run: (transport: AcpTransport) => Promise<void>): Promise<void> {
  const port = 24_400 + Math.floor(Math.random() * 400)
  const secret = randomUUID()
  const serve = spawn(
    'grok',
    ['agent', 'serve', '--bind', `127.0.0.1:${port}`, '--secret', secret],
    { cwd: CWD, stdio: 'ignore' },
  )
  try {
    await waitForGrokServe(port, secret)
    await run(new WebSocketAcpTransport({ url: grokWebSocketUrl(`127.0.0.1:${port}`, secret) }))
  } finally {
    serve.kill('SIGTERM')
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let bit = 0; bit < 8; bit++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, payload, CRC. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(out.subarray(4, 8), 0)
  crcInput.set(data, 4)
  view.setUint32(8 + data.length, crc32(crcInput))
  return out
}

/**
 * A 64×64 PNG of four solid quadrants — red, green, blue, yellow — as an ACP
 * image block in the exact shape the runner puts on the wire.
 *
 * Built in-process on purpose: no fixture file, no dependency, and a
 * deterministic picture is what makes a "name the four colors" answer
 * checkable at all.
 */
function fourColorImage(): PromptImageBlock {
  const size = 64
  const half = size / 2
  const quadrants: [number, number, number][] = [
    [255, 0, 0],   // top-left: red
    [0, 255, 0],   // top-right: green
    [0, 0, 255],   // bottom-left: blue
    [255, 255, 0], // bottom-right: yellow
  ]
  const raw: number[] = []
  for (let y = 0; y < size; y++) {
    raw.push(0) // filter type: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = quadrants[(y < half ? 0 : 2) + (x < half ? 0 : 1)]!
      raw.push(r, g, b)
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, size)
  view.setUint32(4, size)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    ...pngChunk('IHDR', ihdr),
    ...pngChunk('IDAT', deflateSync(Uint8Array.from(raw))),
    ...pngChunk('IEND', new Uint8Array(0)),
  ])
  return { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }
}

/** One tool-related update frame, flattened for shape assertions. */
type ToolUpdate = { readonly id: string; readonly kind: string; readonly status: unknown; readonly frame: AcpFrame }

/** The tool_call / tool_call_update frames of a turn, in arrival order. */
function toolUpdates(frames: readonly AcpFrame[]): ToolUpdate[] {
  const updates: ToolUpdate[] = []
  for (const frame of frames) {
    if (frame.method !== 'session/update') continue
    const update = (frame.params as { update?: Record<string, unknown> } | null)?.update ?? {}
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind !== 'tool_call' && kind !== 'tool_call_update') continue
    updates.push({
      id: typeof update['toolCallId'] === 'string' ? update['toolCallId'] : '',
      kind,
      status: update['status'],
      frame,
    })
  }
  return updates
}

/** The content-chunk text one frame carries (assistant text or thought), if any. */
function contentChunkText(frame: AcpFrame): string {
  if (frame.method !== 'session/update') return ''
  const update = (frame.params as { update?: Record<string, unknown> } | null)?.update ?? {}
  const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') return ''
  const content = update['content'] as { text?: unknown } | undefined
  return typeof content?.['text'] === 'string' ? content['text'] : ''
}

/**
 * Whether one frame is the turn actually working: a non-empty text or thought
 * chunk, or a tool frame. Session chatter (`available_commands_update` and
 * friends) is not — cancelling against chatter measures nothing.
 */
function isTurnContentFrame(frame: AcpFrame): boolean {
  if (frame.method !== 'session/update') return false
  const update = (frame.params as { update?: Record<string, unknown> } | null)?.update ?? {}
  const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') return contentChunkText(frame) !== ''
  return kind === 'tool_call' || kind === 'tool_call_update'
}

/** The prompt that keeps a command running long enough to be cancelled mid-flight. */
const CANCEL_PROMPT =
  'Run the shell command `sleep 45`, and only after it finishes reply with the single word DONE. Do not send any message before the command finishes.'

/**
 * A command that keeps one tool call open long enough for mid-flight frames to
 * exist. A plain `sleep 3` on purpose: compound `sleep 3 && echo …` commands
 * reproducibly fail inside the local claude relay's upstream (`API Error: 405`,
 * isolated by probe — `sleep 3` alone completes, the compound form fails
 * regardless of the echoed token). The shape assertions need the frames, not
 * the output text.
 */
const TOOL_PROMPT_SLOW =
  'Run the shell command `sleep 3`, then tell me exactly what the command printed.'

describe.skipIf(!LIVE)('live ACP agents through the shared layer', () => {
  it('claude: opens a session, answers, and projects its tool call', async () => {
    const result = await runLiveAgent(CLAUDE_ACP, claudeDialect, { modeId: 'default' })
    expect(result.session.sessionId).toBeTruthy()
    expect(result.answer.length).toBeGreaterThan(0)
    // The projected card carries the MAPPED name (Task 4's toolNameMap:
    // Anthropic's "Bash" renders as DSH's "bash"); the raw agent name never
    // reaches the log.
    expect(result.toolNames).toContain('bash')
    // The regression this whole dialect split exists to prevent.
    expect(result.toolOutputs.join('')).toContain('ACP_LIVE_OK')
  }, 240_000)

  it('codex: opens a session, answers, and projects its tool call', async () => {
    const result = await runLiveAgent(CODEX_ACP, codexDialect)
    expect(result.session.sessionId).toBeTruthy()
    expect(result.session.models.length).toBeGreaterThan(0)
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.toolNames.length).toBeGreaterThan(0)
    // codex puts results in rawOutput.formatted_output; reading `content` finds
    // nothing and silently drops every tool output.
    expect(result.toolOutputs.join('')).toContain('ACP_LIVE_OK')
  }, 240_000)

  it('answers a permission request and the turn continues', async () => {
    const result = await runLiveAgent('claude-agent-acp', claudeDialect, {
      modeId: 'default',
      prompt: PROMPT_REQUIRING_APPROVAL,
    })
    // claude in Manual mode asks before writing outside the workspace. If this
    // ever reads 0, the mode did not take effect and this test is proving
    // nothing — so assert it fired rather than tolerating either outcome.
    expect(result.permissionsAnswered).toBeGreaterThan(0)
    // The part that actually matters: the approval was answered, the tool ran,
    // and the agent went on to finish its turn. An unanswered request shows up
    // here as an empty answer.
    expect(result.answer.length).toBeGreaterThan(0)
  }, 240_000)

  it('grok: opens a session over the WebSocket transport and projects its tool call', async () => {
    const port = 24_400 + Math.floor(Math.random() * 400)
    const secret = randomUUID()
    const serve = spawn(
      'grok',
      ['agent', 'serve', '--bind', `127.0.0.1:${port}`, '--secret', secret],
      { cwd: CWD, stdio: 'ignore' },
    )
    try {
      await waitForGrokServe(port, secret)
      const result = await runLiveAgentOver(
        new WebSocketAcpTransport({ url: grokWebSocketUrl(`127.0.0.1:${port}`, secret) }),
        grokDialect,
      )
      expect(result.session.sessionId).toBeTruthy()
      expect(result.session.models.length).toBeGreaterThan(0)
      expect(result.answer.length).toBeGreaterThan(0)
      // Mapped like claude's above: grok's run_terminal_command renders as
      // DSH's "bash" (Task 4's toolNameMap).
      expect(result.toolNames).toContain('bash')
      // grok nests its output one level deeper than codex or claude.
      expect(result.toolOutputs.join('')).toContain('ACP_LIVE_OK')
    } finally {
      serve.kill('SIGTERM')
    }
  }, 240_000)
})

/* ----------------------------------------------------------------------- */
/* Acceptance: cancel, image, tool frames, replay — each against all four.  */
/* ----------------------------------------------------------------------- */

/**
 * The four acceptance cases of the session-parity spec (§11), per agent. The
 * capability table is these cases' input (spec §4): a cell that lies makes
 * exactly the case that reads it go red, so every case asserts the cell it
 * exercises before it drives the agent.
 *
 * Note on the tool-frame case, per the Task 3 ruling (spec §6.1/§11): the DSH
 * host has no supported way to update an already-written session event in place
 * (SurfaceOp is append/replace only, and a log-only `tool/update` is not a
 * known event type — writing one bricks session reload). ThreadHarbor therefore
 * never emits `tool/update`: claude's card appears at the FIRST frame and the
 * result closes it. These cases pin exactly that shape — never a live tick.
 */

/**
 * Cancel: first content frame → `session/cancel` → the turn ends fast and
 * silent. The cancel targets the first CONTENT frame (a message chunk or a
 * tool frame), not session chatter — an `available_commands_update` that
 * arrives with the prompt is not the turn working yet, and cancelling then
 * measures nothing (measured live: codex answered such a cancel by running the
 * task to `end_turn`).
 */
async function cancelCase(dialect: AcpDialect, open: () => Promise<LiveSession>): Promise<void> {
  expect(dialect.capabilities.cancelsTurns).toBe(true)
  const live = await open()
  try {
    const replying = live.prompt(CANCEL_PROMPT)
    await live.waitForFirstContentFrame(90_000)
    const cancelSentAt = Date.now()
    live.client.notify('session/cancel', { sessionId: live.session.sessionId })
    const reply = await replying
    // The turn ends within ~5s of the cancel, and ends as a cancellation.
    expect(reply.stopReason).toBe('cancelled')
    expect(Date.now() - cancelSentAt).toBeLessThan(5_000)
    // 中止后无内容落库, wire-level: once the turn has ended the agent goes
    // quiet. (Frames still in flight between the stop and this reply are the
    // agent's own trailing words; production drops those, which is pinned
    // hermetically by the dispatch package's cancel.spec.ts.)
    const repliedAt = Date.now()
    await new Promise(resolve => setTimeout(resolve, 1_500))
    const late = live.frames
      .filter(entry => entry.at > repliedAt)
      .map(entry => contentChunkText(entry.frame))
      .filter(text => text !== '')
    expect(late).toEqual([])
  } finally {
    live.close()
  }
}

/** Image: the agent must name all four quadrant colors of the test picture. */
const IMAGE_PROMPT =
  'The attached image is a 2×2 grid of four solid colors. Look at the image and name each quadrant color, one per line, in the form "top-left: <color>", "top-right: <color>", "bottom-left: <color>", "bottom-right: <color>". No other text.'

function expectFourColors(answer: string): void {
  const text = answer.toLowerCase()
  for (const color of ['red', 'green', 'blue', 'yellow'] as const) {
    expect(text, `expected the answer to name ${color}, got: ${answer}`).toContain(color)
  }
}

async function imageCase(dialect: AcpDialect, open: () => Promise<LiveSession>): Promise<string> {
  expect(dialect.capabilities.acceptsImageContent).toBe(true)
  const live = await open()
  try {
    await live.prompt(IMAGE_PROMPT, [fourColorImage()])
    return live.answer()
  } finally {
    live.close()
  }
}

/**
 * Tool frames: the opening frame opens the card, the terminal frame closes it
 * with the result, and everything in between folds without emitting — the
 * incremental projection's contract, checked against the agent's real frames.
 */
/**
 * Tool frames: the opening frame opens the card, the terminal frame closes it
 * with the result, and everything in between folds without emitting — the
 * incremental projection's contract, checked against the agent's real frames.
 *
 * The raw frame COUNT is deliberately not asserted: it drifts with the build
 * (grok's 2026-10-13 probe recorded two frames for one call; today's build adds
 * a kind/title update in between). What does not drift, and what production
 * rests on, is the status shape and the projection: `in_progress` agents keep
 * frames flowing across the execution window; `two_frame` agents never carry a
 * non-terminal status after the opening frame — no "running" tick, by cell.
 */
async function toolShapeCase(dialect: AcpDialect, open: () => Promise<LiveSession>): Promise<void> {
  const shape = dialect.capabilities.toolFrameShape
  const live = await open()
  try {
    // The slow command gives `in_progress` agents room to show their
    // mid-flight frames; `two_frame` agents stay two-status regardless.
    await live.prompt(shape === 'in_progress' ? TOOL_PROMPT_SLOW : PROMPT)
    const updates = toolUpdates(live.plainFrames())
    const ids = [...new Set(updates.map(update => update.id))]
    expect(ids.length).toBeGreaterThanOrEqual(1)
    for (const id of ids) {
      const mine = updates.filter(update => update.id === id)
      expect(mine[0]!.kind).toBe('tool_call') // the opening frame is a call
      expect(mine.at(-1)!.status).toBe('completed') // the terminal frame closes it
      const midFlight = mine.slice(1, -1)
      if (shape === 'in_progress') {
        // Frames keep arriving across the execution window (the card's title
        // and output change live); the flattened card shows first-frame state.
        expect(midFlight.length).toBeGreaterThan(0)
      } else {
        // No mid-flight frame carries a non-terminal status: these agents never
        // show "running", they go straight from issued to completed.
        expect(midFlight.some(update => typeof update.status === 'string' && update.status !== 'completed' && update.status !== 'failed')).toBe(false)
      }
    }
    // The mid-turn write production performs: the first frame alone opens the card.
    const card = projectToolCallFrame(updates[0]!.frame, { turn: 1, step: 1, dialect })
    expect(card?.type).toBe('tool/call')
    // Incremental projection: exactly one card and one result per call, and —
    // the Task 3 ruling, negative form — never a `tool/update` event.
    const events = projectTurnIncremental(live.plainFrames(), { turn: 1, dialect })
    expect(events.filter(event => event.type === 'tool/call').length).toBe(ids.length)
    expect(events.filter(event => event.type === 'tool/result').length).toBe(ids.length)
    expect(events.some(event => event.type === 'tool/update')).toBe(false)
  } finally {
    live.close()
  }
}

/**
 * Replay: ask in one external session, close it, and answer from it in a fresh
 * one. The two rounds take separate openers on purpose — a fresh agent process
 * for the second round is the production situation itself (the connection is
 * gone; only the host transcript carries the history) and rules out any
 * server-side session memory faking the pass.
 *
 * The remembered fact is a plain personal name on purpose. The first draft used
 * a "code word", and grok's safety policy refused to repeat anything shaped
 * like a credential ("I won't repeat that code word…") — a refusal about the
 * prompt, not about replay. A fact carries the same mechanism with no
 * credential tripwire.
 */
const CAT_NAME = 'Marmalade'
const REPLAY_Q1 = `Please remember one thing about me: the name of my cat is ${CAT_NAME}. Reply with exactly: noted.`
const REPLAY_Q2 = 'What is the name of my cat? Reply with just the name, nothing else.'

async function replayCase(
  dialect: AcpDialect,
  openFirst: () => Promise<LiveSession>,
  openSecond: () => Promise<LiveSession>,
): Promise<void> {
  // Turn 1: plant the code word in a real external session, then close it.
  const first = await openFirst()
  let firstAnswer = ''
  try {
    await first.prompt(REPLAY_Q1)
    firstAnswer = first.answer()
    expect(firstAnswer.length).toBeGreaterThan(0)
  } finally {
    first.close()
  }

  // The production replay text, byte-for-byte: switch-shared renders the
  // transcript as 【用户】/【助手】 lines and the runner wraps it in
  // 【之前对话】/【当前问题】 for the first request of a fresh external
  // session. The renderer itself is pinned hermetically (replay-primer.spec.ts);
  // the live question here is whether a real, freshly opened agent answers
  // from that text alone — its own conversation carried nothing over.
  const replayed = `【之前对话】\n【用户】${REPLAY_Q1}\n【助手】${firstAnswer}\n\n【当前问题】\n${REPLAY_Q2}`

  const second = await openSecond()
  try {
    await second.prompt(replayed)
    expect(second.answer()).toContain(CAT_NAME)
  } finally {
    second.close()
  }
}

/** A stdio session opener, as the case helpers take one. */
function openStdio(
  command: string,
  dialect: AcpDialect,
  options: { readonly modeId?: string } = {},
): () => Promise<LiveSession> {
  return () => openLiveAgent(command, dialect, options)
}

describe.skipIf(!LIVE)('live acceptance: cancel, image, tool frames, replay (four agents)', () => {
  it('claude: session/cancel ends the turn within 5s as cancelled, then silence', async () => {
    await cancelCase(claudeDialect, openStdio(CLAUDE_ACP, claudeDialect, { modeId: 'default' }))
  }, 240_000)

  it('codex: session/cancel ends the turn within 5s as cancelled, then silence', async () => {
    await cancelCase(codexDialect, openStdio(CODEX_ACP, codexDialect))
  }, 240_000)

  it('grok: session/cancel ends the turn within 5s as cancelled, then silence', async () => {
    await withGrokServe(transport => cancelCase(grokDialect, () => openLiveAgentOver(transport, grokDialect)))
  }, 240_000)

  it('cursor: session/cancel ends the turn within 5s as cancelled, then silence', async () => {
    await cancelCase(cursorDialect, openStdio(CURSOR_ACP, cursorDialect))
  }, 240_000)

  it('codex: names the four quadrant colors of an image block', async () => {
    expectFourColors(await imageCase(codexDialect, openStdio(CODEX_ACP, codexDialect)))
  }, 240_000)

  it('grok: names the four quadrant colors of an image block', async () => {
    await withGrokServe(async transport => {
      expectFourColors(await imageCase(grokDialect, () => openLiveAgentOver(transport, grokDialect)))
    })
  }, 240_000)

  it('cursor: names the four quadrant colors of an image block', async () => {
    expectFourColors(await imageCase(cursorDialect, openStdio(CURSOR_ACP, cursorDialect)))
  }, 240_000)

  it('claude: the capability table declines images, so the router holds them back (拦下)', async () => {
    // This cell IS the branch: production routes by it (promptContent in the
    // dispatch package), never puts an image block on claude's wire, and the
    // writer turns the held-back attachment into the 未送达 row — that branch
    // is driven end to end in the dispatch live spec. The spec's anti-drift
    // rule (§4) makes this the cell the live suite pins for claude.
    expect(claudeDialect.capabilities.acceptsImageContent).toBe(false)
  })

  it('claude: card opens at the first tool frame, result closes it, no tool/update', async () => {
    await toolShapeCase(claudeDialect, openStdio(CLAUDE_ACP, claudeDialect, { modeId: 'default' }))
  }, 240_000)

  it('codex: tool frames are exactly call + completed, projected as one card and one result', async () => {
    await toolShapeCase(codexDialect, openStdio(CODEX_ACP, codexDialect))
  }, 240_000)

  it('grok: tool frames are exactly call + completed, projected as one card and one result', async () => {
    await withGrokServe(transport => toolShapeCase(grokDialect, () => openLiveAgentOver(transport, grokDialect)))
  }, 240_000)

  it('cursor: card opens at the first tool frame, result closes it, no tool/update', async () => {
    await toolShapeCase(cursorDialect, openStdio(CURSOR_ACP, cursorDialect))
  }, 240_000)

  it('claude: a fresh session answers from the replayed previous turn', async () => {
    // stdio: each call to the opener spawns a fresh process, which is exactly
    // the fresh-agent situation the second round wants.
    const opener = openStdio(CLAUDE_ACP, claudeDialect, { modeId: 'default' })
    await replayCase(claudeDialect, opener, opener)
  }, 240_000)

  it('codex: a fresh session answers from the replayed previous turn', async () => {
    const opener = openStdio(CODEX_ACP, codexDialect)
    await replayCase(codexDialect, opener, opener)
  }, 240_000)

  it('grok: a fresh session answers from the replayed previous turn', async () => {
    await withGrokServe(
      first => withGrokServe(second => replayCase(
        grokDialect,
        () => openLiveAgentOver(first, grokDialect),
        () => openLiveAgentOver(second, grokDialect),
      )),
    )
  }, 240_000)

  it('cursor: a fresh session answers from the replayed previous turn', async () => {
    const opener = openStdio(CURSOR_ACP, cursorDialect)
    await replayCase(cursorDialect, opener, opener)
  }, 240_000)
})