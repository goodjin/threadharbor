/**
 * Client-side handling of the agent's ask-the-user request.
 *
 * Cursor's `cursor/ask_question` is blocking: left unanswered the turn stalls
 * with no error. The auto-answer (`skipped`, via the extension hook) keeps the
 * turn alive but throws the question away; the `onAskQuestion` hook is how the
 * question reaches a human and the human's answer reaches the agent.
 *
 * The reply envelope is cursor's own (`docs/agent-acp/cursor.md`, verified
 * against an independent implementation of the same bridge): an answered
 * question is `{outcome:{outcome:"answered",answers:[{questionId,
 * selectedOptionIds}]}}` — option **ids**, not the labels a user picks from.
 */

import { describe, expect, it } from 'vitest'
import { AcpClient } from '../src/client.ts'
import type { AskQuestionRequest } from '../src/client.ts'
import type { AcpTransport } from '../src/transport.ts'
import { cursorDialect } from '../src/dialects/cursor.ts'

/** A transport that records what was written, and can push frames in. */
function fakeTransport(): AcpTransport & { readonly sent: string[]; deliver: (line: string) => void } {
  const sent: string[] = []
  let handler: (line: string) => void = () => {}
  return {
    sent,
    send: (line: string) => { sent.push(line) },
    onLine: (next: (line: string) => void) => { handler = next },
    onDeath: () => {},
    close: () => {},
    deliver: (line: string) => { handler(line) },
  }
}

/** Let queued microtasks run, so the async answer path has settled. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

/** `cursor/ask_question` params as cursor documents them: `prompt`, `allowMultiple`, options of `{id,label}`. */
const ASK_QUESTION = JSON.stringify({
  jsonrpc: '2.0',
  id: 7,
  method: 'cursor/ask_question',
  params: {
    toolCallId: 'call_123',
    title: 'Need input',
    questions: [{
      id: 'q1',
      prompt: 'Which mode should I use?',
      options: [
        { id: 'agent', label: 'Agent' },
        { id: 'plan', label: 'Plan' },
      ],
      allowMultiple: false,
    }],
  },
})

describe('AcpClient asks the user (cursor/ask_question)', () => {
  it('cursor 的提问交给钩子、答案回传', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, cursorDialect)
    const seen: AskQuestionRequest[] = []
    client.onAskQuestion = async request => {
      seen.push(request)
      return { answer: 'Plan' }
    }
    transport.deliver(ASK_QUESTION)
    await flush()

    // The hook saw the question, flattened out of the frame.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      toolCallId: 'call_123',
      title: 'Need input',
      questions: [{
        id: 'q1',
        prompt: 'Which mode should I use?',
        options: [
          { id: 'agent', label: 'Agent' },
          { id: 'plan', label: 'Plan' },
        ],
        allowMultiple: false,
      }],
    })
    // The answer went back in cursor's answered envelope — the label the user
    // chose mapped onto the option id cursor expects, under the request's own id.
    expect(transport.sent).toHaveLength(1)
    const answer = JSON.parse(transport.sent[0]!) as { id: number; result: unknown }
    expect(answer.id).toBe(7)
    expect(answer.result).toEqual({
      outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['plan'] }] },
    })
  })

  it('falls back to the extension hook when no ask hook is wired, so the auto-answer is unchanged', async () => {
    // The no-regression path: a host that cannot ask keeps today's behavior —
    // the wired extension hook answers skipped and the turn proceeds.
    const transport = fakeTransport()
    const client = new AcpClient(transport, cursorDialect)
    client.onExtensionRequest = frame => {
      if (frame.method === 'cursor/ask_question') { client.reply(frame.id as number, { outcome: { outcome: 'skipped' } }); return true }
      return false
    }
    transport.deliver(ASK_QUESTION)
    await flush()

    const answer = JSON.parse(transport.sent[0]!) as { id: number; result: { outcome: { outcome: string } } }
    expect(answer.id).toBe(7)
    expect(answer.result.outcome.outcome).toBe('skipped')
  })

  it('sends the default error when neither hook is wired, exactly as before', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, cursorDialect)
    transport.deliver(ASK_QUESTION)
    await flush()

    expect(transport.sent).toHaveLength(1)
    const answer = JSON.parse(transport.sent[0]!) as { id: number; error?: unknown }
    expect(answer.id).toBe(7)
    expect(answer.error).toBeDefined()
  })

  it('answers skipped with the user\'s words when the answer is not one of the offered options', async () => {
    // Cursor's answered envelope can only name option ids — there is no
    // free-text channel. Replying `answered` with an empty selection would
    // tell the agent the user chose nothing and drop what they typed, so the
    // answer travels in the skipped reason instead.
    const transport = fakeTransport()
    const client = new AcpClient(transport, cursorDialect)
    client.onAskQuestion = async () => ({ answer: 'neither — use review mode' })
    transport.deliver(ASK_QUESTION)
    await flush()

    const answer = JSON.parse(transport.sent[0]!) as { id: number; result: { outcome: { outcome: string; reason?: string; answers?: unknown } } }
    expect(answer.id).toBe(7)
    expect(answer.result.outcome.outcome).toBe('skipped')
    expect(answer.result.outcome.answers).toBeUndefined()
    expect(answer.result.outcome.reason).toContain('neither — use review mode')
  })

  it('still answers skipped when the hook throws, so the turn is never stranded', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, cursorDialect)
    client.onAskQuestion = async () => { throw new Error('no question service') }
    transport.deliver(ASK_QUESTION)
    await flush()

    expect(transport.sent).toHaveLength(1)
    const answer = JSON.parse(transport.sent[0]!) as { id: number; result: { outcome: { outcome: string } } }
    expect(answer.id).toBe(7)
    expect(answer.result.outcome.outcome).toBe('skipped')
  })
})
