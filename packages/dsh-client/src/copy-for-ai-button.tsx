import { useState, type ReactNode } from 'react'
import type { RuntimeT } from './locales.ts'
import { writeClipboardText } from './copy-for-ai.ts'
import styles from './panel.module.css'

export function CopyForAiButton(props: {
  readonly prompt: string
  readonly t: RuntimeT
  readonly dataAction?: string
  readonly onCopied?: (() => void) | undefined
  readonly onCopyFailed?: (() => void) | undefined
  readonly className?: string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const label = copied ? props.t('panel.copyForAi.copied') : props.t('panel.copyForAi.label')
  const run = (): void => {
    void writeClipboardText(props.prompt).then(ok => {
      if (!ok) {
        props.onCopyFailed?.()
        return
      }
      setCopied(true)
      props.onCopied?.()
      window.setTimeout(() => { setCopied(false) }, 2000)
    })
  }
  return (
    <button
      type="button"
      className={props.className ?? styles.action}
      data-action={props.dataAction ?? 'copy-for-ai'}
      onClick={run}
    >{label}</button>
  )
}
