/**
 * Bridging the agent's ask-the-user request to the host's question service.
 *
 * Direction of the translation, fixed here: the bridge speaks the **host's**
 * question shape (`userQuestions.ask`) on the way in and returns the answer as
 * the plain text the agent should read. The cursor reply envelope is assembled
 * in the agent-side client, which owns the wire. A host that throws — no
 * question service, no answerer, a non-live agent — propagates, and the client
 * answers `skipped` in its place, so an unpresentable question still releases
 * the turn.
 *
 * Facts verified against `reference/deepseek-harness` (read-only):
 * `interaction/user-questions/src/types.ts` (the request and answer shapes),
 * `interaction/tool-ask-user/src/index.ts:99` (the proven `ask` call — agent
 * optional, unscoped when absent).
 */

import type { AskQuestionAnswer, AskQuestionRequest } from '@threadharbor/dsh-acp-agent'

/** What the host's user-questions service is asked, structurally. */
export type QuestionPort = (request: {
  questions: {
    id: string
    question: string
    header?: string
    options?: { label: string }[]
    multiSelect?: boolean
  }[]
  /** The live host agent owning the session, when one resolves. */
  agent?: unknown
}) => Promise<unknown>

export type QuestionBridge = (request: AskQuestionRequest) => Promise<AskQuestionAnswer>

/**
 * Bridge an agent's question to the host's user-questions service.
 *
 * `agentOf` resolves the live host agent from the session the request names —
 * looked up per request rather than captured, because several sessions can be
 * live at once and a question belongs to the conversation it was asked in.
 */
export function makeQuestionBridge(ask: QuestionPort, agentOf: (sessionId: string | undefined) => unknown): QuestionBridge {
  return async request => {
    const agent = agentOf(request.sessionId)
    const answer = await ask({
      questions: request.questions.map(question => ({
        id: question.id,
        question: question.prompt,
        ...(request.title === undefined ? {} : { header: request.title }),
        ...(question.options.length === 0
          ? {}
          : { options: question.options.map(option => ({ label: option.label })) }),
        ...(question.allowMultiple ? { multiSelect: true } : {}),
      })),
      ...(agent === undefined ? {} : { agent }),
    })
    return { answer: answerTextOf(answer) }
  }
}

/**
 * The answer as one text the agent reads.
 *
 * The host answers per question (`selected` labels, optional free-text
 * `custom`); a typed answer is the user's own words and wins over the
 * selection, and several questions' parts join for the one string the reply
 * carries.
 */
function answerTextOf(answer: unknown): string {
  const answers = (answer as { answers?: unknown } | null | undefined)?.answers
  if (!Array.isArray(answers)) return ''
  const parts = answers.map(item => {
    const one = (item ?? {}) as { custom?: unknown; selected?: unknown }
    const custom = typeof one.custom === 'string' ? one.custom.trim() : ''
    if (custom !== '') return custom
    const selected = Array.isArray(one.selected)
      ? one.selected.filter((label): label is string => typeof label === 'string')
      : []
    return selected.join(', ')
  })
  return parts.filter(part => part !== '').join(' | ')
}
