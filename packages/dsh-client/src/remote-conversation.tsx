/**
 * The main-area view of another host.
 *
 * The iframe loads that host's own DSH through this machine's gateway, so the
 * browser calls the same APIs it would call locally. The session keeps running
 * on that host. This panel does not reimplement the conversation.
 */
import { useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { gatewayPagePath } from '@threadharbor/dsh-host-federation'
import type { RemoteConversationStore } from './remote-conversation-store.ts'
import { NAMESPACE } from './locales.ts'
import type { RuntimeT } from './locales.ts'
import { fallbackT } from './locales.ts'
import styles from './remote-conversation.module.css'

export const REMOTE_SESSION_PANEL_ID = 'threadharbor-remote-session'

type LayoutLike = { selectPanel?: (id: string | null) => void }

/** Show the remote-host panel, or say the layout service is not there. */
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
} & Partial<PropsLocale<typeof NAMESPACE>>

/** Gateway page for this host, with the clicked session in the hash when there is one. */
export function gatewayFrameSrc(hostId: string, sessionId: string | undefined): string {
  const page = gatewayPagePath(hostId)
  if (sessionId === undefined || sessionId === '') return page
  return `${page}#thSession=${encodeURIComponent(sessionId)}`
}

export function RemoteConversationPanel({ remoteSessions, t = fallbackT }: RemoteConversationProps) {
  const selection = useSyncExternalStore(remoteSessions.subscribe, remoteSessions.getSnapshot, remoteSessions.getSnapshot)
  if (selection === null) {
    return (
      <div className={styles.panel} data-remote-conversation>
        <p className={styles.hint} data-remote-empty>{t('remoteSession.pick')}</p>
      </div>
    )
  }
  return (
    <div className={styles.panel} data-remote-conversation data-remote-session={selection.sessionId}>
      <p className={styles.host}>{t('remoteSession.runningOn', { host: selection.hostTitle })}</p>
      <iframe
        key={`${selection.hostId}:${selection.sessionId ?? ''}`}
        className={styles.frame}
        title={selection.hostTitle}
        src={gatewayFrameSrc(selection.hostId, selection.sessionId)}
        data-remote-gateway={selection.hostId}
      />
    </div>
  )
}
