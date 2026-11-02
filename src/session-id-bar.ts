import { useEffect, useRef, useState } from 'react'
import { createElement } from 'react'
import type { RuntimeT } from './locales.ts'
import { NAMESPACE, fallbackT } from './locales.ts'

type BarProps = {
  readonly sessionId: string
  readonly t?: RuntimeT
}

type UtilitiesSlotHost = {
  inject(key: string, callback: () => unknown): unknown
  register(options: {
    name: string
    id?: string
    locale?: string
    inject?: (sessionId: string) => unknown
  }, component: unknown): () => void
}

/** The short form shown in the bar; the full id rides the title attribute. */
const shortId = (sessionId: string): string => sessionId.replace(/^session-/, '').slice(0, 8)

export function SessionIdBar({ sessionId, t = fallbackT }: BarProps) {
  const [state, setState] = useState<'idle' | 'copied' | { failed: string }>('idle')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => { if (timer.current !== undefined) window.clearTimeout(timer.current) }, [])

  const copy = (): void => {
    navigator.clipboard?.writeText(sessionId).then(() => {
      setState('copied')
      timer.current = window.setTimeout(() => { setState('idle') }, 2000)
    }, (error: unknown) => {
      setState({ failed: error instanceof Error ? error.message : String(error) })
    })
  }

  return createElement('div', {
    'data-session-id-bar': true,
    title: sessionId,
    style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', opacity: 0.75 },
  },
    createElement('code', { style: { fontVariantNumeric: 'tabular-nums' } }, shortId(sessionId)),
    createElement('button', {
      type: 'button',
      'data-action': 'copy-session-id',
      onClick: copy,
      style: { border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px', borderRadius: '4px' },
    }, t('panel.sessionBar.copy')),
    state === 'idle' ? null : createElement('span', { 'data-copy-state': true },
      state === 'copied' ? t('panel.sessionBar.copied') : `${t('panel.sessionBar.copyFailed')}${state.failed}`),
  )
}

/**
 * Register the id bar into the conversation header's utilities row. The slot
 * is session-scoped: the framework hands the registrant's inject callback the
 * sessionId as its first argument (the conversation package's own header does
 * the same for its view switcher).
 */
export function registerSessionIdBar(slots: UtilitiesSlotHost): void {
  slots.inject('conversation.session.header.utilities', () => slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'threadharbor-session-id',
      locale: NAMESPACE,
      inject: (sessionId: string) => ({ sessionId }),
    },
    (props: { readonly sessionId?: string; readonly t?: RuntimeT }) => {
      const sessionId = props.sessionId
      if (sessionId === undefined) return null
      return createElement(SessionIdBar, { sessionId, ...(props.t === undefined ? {} : { t: props.t }) })
    },
  ))
}
