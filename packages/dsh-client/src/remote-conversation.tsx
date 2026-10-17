/**
 * The main-area view of a session that runs on another host.
 *
 * Reading, sending, and stopping all go through this machine's proxy, which
 * talks to that host's own DSH. Nothing here starts an agent locally.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { remoteSessionOp } from './ssh-deploy.ts'
import type { RemoteConversationStore, RemoteSelection } from './remote-conversation-store.ts'
import { NAMESPACE } from './locales.ts'
import type { RuntimeT } from './locales.ts'
import { fallbackT } from './locales.ts'
import styles from './remote-conversation.module.css'

export const REMOTE_SESSION_PANEL_ID = 'threadharbor-remote-session'

const REFRESH_MS = 4_000

export type TranscriptTurn = {
  readonly role: 'user' | 'assistant' | 'note'
  readonly text: string
}

type Load =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly turns: readonly TranscriptTurn[]; readonly hasMore: boolean }
  | { readonly status: 'error'; readonly message: string }

type LayoutLike = { selectPanel?: (id: string | null) => void }

/** Show the remote-session panel, or say the layout service is not there. */
export function showRemoteSessionPanel(ctx: { get(name: string): unknown }): boolean {
  return selectPanel(ctx, REMOTE_SESSION_PANEL_ID)
}

/** Hand the main area back to the native conversation. */
export function showNativeConversation(ctx: { get(name: string): unknown }): void {
  selectPanel(ctx, null)
}

function selectPanel(ctx: { get(name: string): unknown }, id: string | null): boolean {
  try {
    const layout = ctx.get('layout') as LayoutLike | undefined
    if (typeof layout?.selectPanel !== 'function') return false
    layout.selectPanel(id)
    return true
  } catch {
    return false
  }
}

type SlotHost = {
  inject(slot: string, callback: () => unknown): unknown
  register(options: { name: string; key?: string; locale?: string; inject?: () => unknown }, component: unknown): () => void
}

/** Register the main panel. No sidebar icon: the tree is the only way in. */
export function registerRemoteConversation(slots: SlotHost, store: RemoteConversationStore): () => void {
  const dispose = slots.inject('main', () => slots.register(
    { name: 'main', key: REMOTE_SESSION_PANEL_ID, locale: NAMESPACE, inject: () => ({ remoteSessions: store }) },
    RemoteConversationPanel,
  ))
  return typeof dispose === 'function' ? () => { dispose() } : () => {}
}

export type RemoteConversationProps = {
  readonly remoteSessions: RemoteConversationStore
  readonly t?: RuntimeT
  /** Test seam. Production posts to the host-side route. */
  readonly call?: (body: Record<string, unknown>) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>
} & Partial<PropsLocale<typeof NAMESPACE>>

export function RemoteConversationPanel({ remoteSessions, t = fallbackT, call }: RemoteConversationProps) {
  const selection = useSyncExternalStore(remoteSessions.subscribe, remoteSessions.getSnapshot, remoteSessions.getSnapshot)
  const [load, setLoad] = useState<Load>({ status: 'idle' })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const invoke = call ?? ((body: Record<string, unknown>) => remoteSessionOp(body, t))

  const refresh = useCallback(async (current: RemoteSelection, quiet: boolean) => {
    if (!quiet) setLoad(previous => previous.status === 'ready' ? previous : { status: 'loading' })
    const result = await invoke({
      op: 'transcript',
      launchUrl: current.launchUrl,
      sessionId: current.sessionId,
    })
    if (remoteSessions.getSnapshot()?.sessionId !== current.sessionId) return
    if (!result.ok) {
      setLoad({ status: 'error', message: result.error })
      return
    }
    const value = result.value as { turns?: TranscriptTurn[]; hasMore?: boolean }
    setLoad({
      status: 'ready',
      turns: Array.isArray(value.turns) ? value.turns : [],
      hasMore: value.hasMore === true,
    })
  }, [invoke, remoteSessions])

  useEffect(() => {
    if (selection === null) {
      setLoad({ status: 'idle' })
      return
    }
    const current = selection
    void refresh(current, false)
    const timer = window.setInterval(() => { void refresh(current, true) }, REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [selection, refresh])

  useEffect(() => {
    const node = listRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [load])

  const send = useCallback(async () => {
    if (selection === null) return
    const text = draft.trim()
    if (text === '') return
    setBusy(true)
    setNotice(null)
    const result = await invoke({
      op: 'prompt',
      launchUrl: selection.launchUrl,
      sessionId: selection.sessionId,
      text,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    setBusy(false)
    if (!result.ok) {
      setNotice(result.error)
      return
    }
    setDraft('')
    await refresh(selection, true)
  }, [selection, draft, invoke, refresh])

  const stop = useCallback(async () => {
    if (selection === null) return
    setNotice(null)
    const result = await invoke({ op: 'cancel', launchUrl: selection.launchUrl, sessionId: selection.sessionId })
    if (!result.ok) setNotice(result.error)
    else await refresh(selection, true)
  }, [selection, invoke, refresh])

  if (selection === null) {
    return (
      <div className={styles.panel} data-remote-conversation>
        <p className={styles.hint} data-remote-empty>{t('remoteSession.pick')}</p>
      </div>
    )
  }

  const turns = load.status === 'ready' ? load.turns : []
  return (
    <div className={styles.panel} data-remote-conversation data-remote-session={selection.sessionId}>
      <header className={styles.header}>
        <span className={styles.title} data-remote-title>{selection.title}</span>
        <span className={styles.host}>{t('remoteSession.runningOn', { host: selection.hostTitle })}</span>
        <button type="button" className={styles.ghost} data-action="remote-refresh" onClick={() => { void refresh(selection, false) }}>{t('remoteSession.refresh')}</button>
        <button type="button" className={styles.ghost} data-action="remote-stop" onClick={() => { void stop() }}>{t('remoteSession.stop')}</button>
      </header>
      {notice !== null ? <p className={styles.error} data-remote-notice>{notice}</p> : null}
      {load.status === 'error' ? <p className={styles.error} data-remote-error>{load.message}</p> : null}
      <div className={styles.messages} ref={listRef} data-remote-messages>
        {load.status === 'loading' ? <p className={styles.hint}>{t('remoteSession.loading')}</p> : null}
        {load.status === 'ready' && turns.length === 0 ? <p className={styles.hint} data-remote-no-messages>{t('remoteSession.noMessages')}</p> : null}
        {turns.map((turn, index) => (
          <p key={`${turn.role}-${index}`} className={styles[turn.role]} data-remote-turn={turn.role}>{turn.text}</p>
        ))}
        {load.status === 'ready' && load.hasMore ? <p className={styles.hint}>{t('remoteSession.hasMore')}</p> : null}
      </div>
      <form
        className={styles.composer}
        data-remote-composer
        onSubmit={event => {
          event.preventDefault()
          void send()
        }}
      >
        <input
          className={styles.input}
          data-remote-input
          value={draft}
          placeholder={t('remoteSession.placeholder')}
          onChange={event => { setDraft(event.target.value) }}
        />
        <button type="submit" className={styles.button} data-action="remote-send" disabled={busy || draft.trim() === ''}>{t('remoteSession.send')}</button>
      </form>
    </div>
  )
}
