/**
 * Result card for a turn's final answer: a header with the thinking icon and a
 * copy button (shows a checkmark after a successful copy), then the native answer
 * content below. Thinking keeps its own fold/expand inside the content.
 */
import { useState, type ReactNode } from 'react'
import {
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  IconThinkOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { writeClipboardText } from './copy-for-ai.ts'
import styles from './acp-process.module.css'

/** Plain-prose copyable text from the answer's text/reasoning blocks. */
function answerText(blocks: readonly { readonly kind: string; readonly text?: string }[]): string {
  return blocks
    .filter(block => (block.kind === 'text' || block.kind === 'reasoning') && (block.text?.trim() ?? '') !== '')
    .map(block => block.text ?? '')
    .join('\n\n')
}

export function AnswerCard(props: {
  readonly children: ReactNode
  readonly blocks: readonly { readonly kind: string; readonly text?: string }[]
  readonly t: (key: string) => string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const text = answerText(props.blocks)
  const run = (): void => {
    void writeClipboardText(text).then(ok => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 2000)
    })
  }
  return (
    <div className={styles.answerCard} data-acp-answer-card>
      <div className={styles.answerCardHeader}>
        <IconThinkOutlineRegular size={14} className={styles.answerCardIcon} />
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
      <div className={styles.answerCardBody}>{props.children}</div>
    </div>
  )
}
