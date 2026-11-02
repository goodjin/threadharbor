/**
 * Result card for a turn's final answer: a header with the thinking icon, an edit
 * toggle and a copy button (shows a checkmark after a successful copy), then the
 * native answer content below. Editing swaps the body for a one-screen textarea
 * whose prose can be sent to the session or a new session as a task — the same
 * affordance the file reader offers, applied to the answer itself. Thinking keeps
 * its own fold/expand inside the content.
 */
import { useState, type ReactNode } from 'react'
import {
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconCopyOutlineRegular,
  IconEditOutlineRegular,
  IconNewChatOutlineRegular,
  IconSendOutlineRegular,
  IconThinkOutlineRegular,
  IconWarningOutlineRegular,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownTurnReaders } from './markdown-turn-sources.ts'
import styles from './acp-process.module.css'

async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard === undefined) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Plain-prose copyable text from the answer's text/reasoning blocks. */
function answerText(blocks: readonly { readonly kind: string; readonly text?: string }[]): string {
  return blocks
    .filter(block => (block.kind === 'text' || block.kind === 'reasoning') && (block.text?.trim() ?? '') !== '')
    .map(block => block.text ?? '')
    .join('\n\n')
}

/** 新建会话时，给内容加一句「来自结果框」的前缀，便于助手识别出处。 */
const NEW_SESSION_HEADER = '以下为会话结果框中的内容：'

export function AnswerCard(props: {
  readonly children: ReactNode
  readonly blocks: readonly { readonly kind: string; readonly text?: string }[]
  readonly sessionId: string | undefined
  readonly readers: MarkdownTurnReaders | undefined
  readonly t: (key: string) => string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string; ok: boolean } | null>(null)
  const text = answerText(props.blocks)
  const canEdit = props.sessionId !== undefined && props.readers !== undefined

  const run = (): void => {
    void writeClipboardText(text).then(ok => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 2000)
    })
  }
  const notify = (message: string): void => {
    setToast({ seq: (toast?.seq ?? 0) + 1, text: message, ok: false })
  }
  const sendText = (body: string): void => {
    if (body === '' || props.sessionId === undefined || props.readers === undefined) return
    void props.readers.sendToSession(props.sessionId, body)
      .catch(() => notify(props.t('markdownTurn.sendFailed')))
  }
  const sendToNewSession = (body: string): void => {
    if (body === '' || props.readers === undefined) return
    const prompt = `${NEW_SESSION_HEADER}\n\n${body}`
    void props.readers.createSession()
      .then(newId => props.readers!.sendToSession(newId, prompt))
      .catch(() => notify(props.t('markdownTurn.newSessionFailed')))
  }
  const readEditValue = (): string => {
    const ta = document.querySelector('[data-answer-edit-input]') as HTMLTextAreaElement | null
    return ta?.value ?? ''
  }

  return (
    <div className={styles.answerCard} data-acp-answer-card>
      <div className={styles.answerCardHeader}>
        <IconThinkOutlineRegular size={14} className={styles.answerCardIcon} />
        <div className={styles.answerHeaderActions}>
          {canEdit && !editing && (
            <button
              type="button"
              className={styles.answerCardCopy}
              data-action="edit-answer"
              aria-label={props.t('answerCard.edit')}
              title={props.t('answerCard.edit')}
              onClick={() => setEditing(true)}
            >
              <IconEditOutlineRegular size={14} className={styles.answerCardIcon} />
            </button>
          )}
          <button
            type="button"
            className={styles.answerCardCopy}
            data-action="copy-answer"
            data-copied={copied || undefined}
            aria-label={copied ? props.t('answerCard.copied') : props.t('answerCard.copy')}
            title={copied ? props.t('answerCard.copied') : props.t('answerCard.copy')}
            onClick={run}
          >
            {copied
              ? <IconCheckOutlineRegular size={14} className={styles.answerCardIcon} />
              : <IconCopyOutlineRegular size={14} className={styles.answerCardIcon} />}
          </button>
        </div>
      </div>
      {editing
        ? (
          <div className={styles.answerEditBox} data-answer-edit-box="">
            <textarea
              className={styles.answerEditInput}
              data-answer-edit-input=""
              defaultValue={text}
              aria-label={props.t('answerCard.edit')}
              style={{ minHeight: '50dvh' }}
            />
            <div className={styles.answerEditActions}>
              <button
                type="button"
                className={styles.answerEditCancel}
                data-action="cancel-answer"
                aria-label={props.t('markdownTurn.cancel')}
                title={props.t('markdownTurn.cancel')}
                onClick={() => setEditing(false)}
              >
                <IconCloseOutlineRegular size={15} /> {props.t('markdownTurn.cancel')}
              </button>
              <button
                type="button"
                className={styles.answerEditCancel}
                data-action="new-session-answer"
                aria-label={props.t('markdownTurn.newSession')}
                title={props.t('markdownTurn.newSession')}
                onClick={() => { sendToNewSession(readEditValue()); setEditing(false) }}
              >
                <IconNewChatOutlineRegular size={15} /> {props.t('markdownTurn.newSession')}
              </button>
              <button
                type="button"
                className={styles.answerEditSend}
                data-action="send-answer"
                onClick={() => { sendText(readEditValue()); setEditing(false) }}
              >
                <IconSendOutlineRegular size={15} /> {props.t('markdownTurn.send')}
              </button>
            </div>
          </div>
        )
        : <div className={styles.answerCardBody}>{props.children}</div>}
      {toast !== null && <Toast
        key={toast.seq}
        text={toast.text}
        icon={<IconWarningOutlineRegular />}
        onDone={() => { setToast(null) }}
      />}
    </div>
  )
}
