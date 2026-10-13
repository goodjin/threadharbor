/**
 * The question bridge: the agent's `cursor/ask_question` in, the DSH
 * question card's answer out.
 *
 * Direction of the translation, fixed here: the bridge speaks the **host's**
 * question shape (`userQuestions.ask`) on the way in and returns the answer as
 * the plain text the agent should read. The cursor reply envelope is assembled
 * in the agent-side client, which owns the wire. A host that throws — no
 * question service, no answerer, a non-live agent — propagates, and the client
 * answers `skipped` in its place, so an unpresentable question still releases
 * the turn.
 */

import { describe, expect, it } from 'vitest'
import { makeQuestionBridge } from '../src/question-bridge.ts'
import type { AskQuestionRequest } from '@threadharbor/dsh-acp-agent'

const REQUEST: AskQuestionRequest = {
  sessionId: 's1',
  toolCallId: 'call_123',
  title: 'Need input',
  questions: [{
    id: 'q1',
    prompt: 'Which mode should I use?',
    options: [{ id: 'agent', label: 'Agent' }, { id: 'plan', label: 'Plan' }],
    allowMultiple: false,
  }],
}

describe('makeQuestionBridge', () => {
  it('asks the host in the host\'s question shape, naming who owns the session', async () => {
    const seen: unknown[] = []
    const bridge = makeQuestionBridge(
      async request => { seen.push(request); return { answers: [{ id: 'q1', selected: ['Plan'] }] } },
      sessionId => (sessionId === 's1' ? { id: 'a1' } : undefined),
    )
    const answer = await bridge(REQUEST)
    expect(seen[0]).toEqual({
      questions: [{
        id: 'q1',
        question: 'Which mode should I use?',
        header: 'Need input',
        options: [{ label: 'Agent' }, { label: 'Plan' }],
      }],
      agent: { id: 'a1' },
    })
    expect(answer).toEqual({ answer: 'Plan' })
  })

  it('marks a multi-select question so the card renders one', async () => {
    const seen: unknown[] = []
    const bridge = makeQuestionBridge(
      async request => { seen.push(request); return { answers: [{ id: 'q1', selected: ['A'] }] } },
      () => undefined,
    )
    const { title: _untitled, ...untitled } = REQUEST
    await bridge({ ...untitled, questions: [{ ...REQUEST.questions[0]!, allowMultiple: true }] })
    expect(seen[0]).toEqual({
      questions: [{
        id: 'q1',
        question: 'Which mode should I use?',
        options: [{ label: 'Agent' }, { label: 'Plan' }],
        multiSelect: true,
      }],
    })
  })

  it('prefers the user\'s typed answer over the selection, and joins selections of several questions', async () => {
    const bridge = makeQuestionBridge(
      async () => ({ answers: [{ id: 'q1', selected: ['Agent'], custom: 'Agent, but keep plan mode' }] }),
      () => undefined,
    )
    expect(await bridge(REQUEST)).toEqual({ answer: 'Agent, but keep plan mode' })

    const both = makeQuestionBridge(
      async () => ({ answers: [{ id: 'q1', selected: ['Agent', 'Plan'] }, { id: 'q2', selected: ['Ship it'] }] }),
      () => undefined,
    )
    expect(await both(REQUEST)).toEqual({ answer: 'Agent, Plan | Ship it' })
  })

  it('asks without an agent when the session has no live one', async () => {
    // The host's service takes an unscoped request (the native tool does the
    // same when its caller has no agent); guessing an agent would attach the
    // question to the wrong conversation.
    const seen: unknown[] = []
    const bridge = makeQuestionBridge(
      async request => { seen.push(request); return { answers: [{ id: 'q1', selected: ['Plan'] }] } },
      () => undefined,
    )
    const { sessionId: _unowned, ...anonymous } = REQUEST
    await bridge(anonymous)
    expect(seen[0]).toEqual({ questions: [expect.objectContaining({ id: 'q1' })] })
  })

  it('propagates the host\'s refusal — the client turns it into a skip', async () => {
    // Swallowing here would look like a user who answered nothing; letting it
    // throw is what lets the client answer skipped with a structural reason.
    const bridge = makeQuestionBridge(
      async () => { throw new Error('no user-questions answerer accepted the request') },
      () => undefined,
    )
    await expect(bridge(REQUEST)).rejects.toThrow(/no user-questions answerer/)
  })
})
