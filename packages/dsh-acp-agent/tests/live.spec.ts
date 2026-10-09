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
import { AcpClient } from '../src/client.ts'
import { StdioAcpTransport } from '../src/transport.ts'
import { projectTurn } from '../src/projection.ts'
import { bridgePermissions } from '../src/approval.ts'
import { claudeDialect } from '../src/dialects/claude.ts'
import { codexDialect } from '../src/dialects/codex.ts'
import type { AcpDialect } from '../src/dialects/types.ts'
import type { AcpFrame, AcpSession } from '../src/acp-client.ts'

const LIVE = process.env['THREADHARBOR_LIVE_ACP'] === '1'
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
  const client = new AcpClient(transport, dialect)

  const frames: AcpFrame[] = []
  let permissionsAnswered = 0
  client.onNotification = frame => { frames.push(frame) }
  // Approve through the very bridge production uses, so this also exercises the
  // fail-closed path rather than a test-only shortcut.
  client.onPermissionRequest = request =>
    bridgePermissions(request, async () => 'allowed-once').then(decision => {
      permissionsAnswered += 1
      return decision
    })

  try {
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    client.notify('initialized', {})

    const session = AcpClient.toSession(await client.request('session/new', { cwd: CWD, mcpServers: [] }), dialect)

    // grok needs no mode; claude ships in bypassPermissions and must be switched
    // to Manual or it will never ask for anything.
    if (options.modeId !== undefined) {
      await client.request('session/set_mode', { sessionId: session.sessionId, modeId: options.modeId })
    }

    const first = session.models[0]?.id
    if (first !== undefined && dialect.id !== 'claude') {
      await client.request('session/set_model', { sessionId: session.sessionId, modelId: first }).catch(() => {})
    }

    await client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: options.prompt ?? PROMPT }],
      ...(first === undefined || dialect.id === 'claude' ? {} : { modelId: first }),
    })

    const events = projectTurn(frames, { turn: 1, dialect })
    const answer = events
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => (event.payload as { message: { content: { type: string; text: string }[] } }).message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')

    return {
      session,
      frames,
      answer,
      toolNames: events
        .filter(event => event.type === 'tool/call')
        .map(event => (event.payload as { name: string }).name),
      toolOutputs: events
        .filter(event => event.type === 'tool/result')
        .map(event => {
          const message = (event.payload as { message: { content: { text: string }[] } }).message
          return message.content.map(part => part.text).join('')
        }),
      permissionsAnswered,
    }
  } finally {
    client.close()
  }
}

describe.skipIf(!LIVE)('live ACP agents through the shared layer', () => {
  it('claude: opens a session, answers, and projects its tool call', async () => {
    const result = await runLiveAgent('claude-agent-acp', claudeDialect, { modeId: 'default' })
    expect(result.session.sessionId).toBeTruthy()
    expect(result.answer.length).toBeGreaterThan(0)
    expect(result.toolNames).toContain('Bash')
    // The regression this whole dialect split exists to prevent.
    expect(result.toolOutputs.join('')).toContain('ACP_LIVE_OK')
  }, 240_000)

  it('codex: opens a session, answers, and projects its tool call', async () => {
    const result = await runLiveAgent('codex-acp', codexDialect)
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
})