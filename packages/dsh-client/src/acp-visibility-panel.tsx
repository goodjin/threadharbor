/**
 * The settings section where providers and their models are hidden.
 *
 * It lists the RAW catalog (acp-visibility-catalog.ts), not the filtered
 * directories the pickers consume: a row the user hid must stay on this page,
 * or there would be no way to bring it back. Each provider is one row with a
 * whole-provider switch; its models are listed beneath, each with its own
 * switch. Hiding a provider disables — but does not clear — the per-model
 * choices, so unhiding the provider restores the finer setting.
 *
 * The official Settings → Models page stays untouched, which is what makes
 * hiding safe: the API keys live there and are never part of this choice.
 *
 * Persistence goes through the same machine-backed store as the host registry
 * (host-store.ts); the posture line says where that currently stands, because
 * a choice that is not actually saved must not look saved.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { storagePostureLine } from './panel.tsx'
import type { HostStorePosture } from './host-store.ts'
import { NAMESPACE } from './locales.ts'
import {
  agentHidden,
  emptyAcpVisibility,
  modelHidden,
  setAgentHidden,
  setModelHidden,
} from './acp-visibility.ts'
import type { AcpVisibilityStore } from './acp-visibility.ts'
import type { AcpCatalogAgent, AcpCatalogError, AcpCatalogStore } from './acp-visibility-catalog.ts'
import styles from './acp-visibility.module.css'

/** Shared identity of the settings rail row and the body it mounts. */
export const ACP_VISIBILITY_PANEL_ID = 'threadharbor-acp-visibility'
/** Below the hosts section (100), so it reads as a second setting. */
export const ACP_VISIBILITY_PANEL_ORDER = 110

/** The `t` seat, as the framework synthesizes it for this plugin's namespace. */
export type AcpVisibilityT = PropsLocale<typeof NAMESPACE>['t']

/** What the section reads from the page wiring, without the framework shares. */
export type AcpVisibilityBusinessProps = {
  readonly visibility: AcpVisibilityStore
  readonly catalog: AcpCatalogStore
  readonly hostStore?: {
    posture(): HostStorePosture
    subscribe(listener: () => void): () => void
  } | undefined
}

/** The wiring's face plus the framework's `t` seat. */
export type AcpVisibilityPanelProps = PropsLocale<typeof NAMESPACE> & AcpVisibilityBusinessProps

/**
 * The slot face this section registers through. `settings.section` is a list
 * kind slot declared by the shell; one more id in it is one more rail row.
 */
export type AcpVisibilitySlotHost = {
  inject(key: string, callback: () => unknown): unknown
  register(options: {
    name: string
    id?: string
    order?: number
    label?: () => string
    locale?: string
    inject?: () => unknown
  }, component: unknown): unknown
}

/**
 * Register the section into the settings dialog.
 * @param slots - the page's slot registry face.
 * @param face - what the section reads.
 * @param label - the rail row's label, re-read per render.
 */
export function registerAcpVisibilitySection(
  slots: AcpVisibilitySlotHost,
  face: AcpVisibilityBusinessProps,
  label: () => string,
): void {
  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: ACP_VISIBILITY_PANEL_ID,
      order: ACP_VISIBILITY_PANEL_ORDER,
      label,
      locale: NAMESPACE,
      inject: () => face,
    },
    AcpVisibilityPanel,
  ))
}

const NOOP = (): void => {}

/** The stored choice's summary, in words the dictionary owns. */
function summaryLine(
  visibility: ReturnType<AcpVisibilityStore['get']>,
  t: AcpVisibilityT,
): string {
  const hiddenAgents = visibility.hiddenAgents.length
  const hiddenModels = Object.values(visibility.hiddenModels)
    .reduce((total, models) => total + models.length, 0)
  return hiddenAgents === 0 && hiddenModels === 0
    ? t('acpVisibility.summaryNone')
    : t('acpVisibility.summary', { agents: hiddenAgents, models: hiddenModels })
}

/** One sentence for each way the catalog listing can fail. */
function catalogErrorLine(error: AcpCatalogError, t: AcpVisibilityT): string {
  switch (error.kind) {
    case 'missing':
      return t('acpVisibility.error.missing')
    case 'shape':
      return t('acpVisibility.error.shape')
    case 'failed':
      return t('acpVisibility.error.failed', { detail: error.detail })
  }
}

/**
 * Render the settings section.
 * @param props - injected face plus the locale seat.
 */
export function AcpVisibilityPanel(
  { visibility, catalog, hostStore, t }: AcpVisibilityPanelProps,
): ReactNode {
  const current = useSyncExternalStore(
    useCallback((listener: () => void) => visibility.subscribe(listener), [visibility]),
    () => visibility.get(),
  )
  const listing = useSyncExternalStore(
    useCallback((listener: () => void) => catalog.subscribe(listener), [catalog]),
    () => catalog.getSnapshot(),
  )
  const subscribePosture = useCallback(
    (listener: () => void) => hostStore?.subscribe(listener) ?? NOOP,
    [hostStore],
  )
  const posture = useSyncExternalStore(subscribePosture, () => hostStore?.posture())
  // Every mount asks the host again: ACP presets can be installed or removed
  // between two openings of the settings dialog.
  useEffect(() => {
    void catalog.load()
  }, [catalog])

  const hiddenModelCount = useMemo(
    () => Object.values(current.hiddenModels).reduce((total, models) => total + models.length, 0),
    [current],
  )
  const nothingHidden = current.hiddenAgents.length === 0 && hiddenModelCount === 0
  const postureDisplay = storagePostureLine(posture ?? { kind: 'loading' }, t)

  const toggleAgent = (key: string, hidden: boolean): void => {
    visibility.set(setAgentHidden(visibility.get(), key, hidden))
  }
  const toggleModel = (key: string, modelId: string, hidden: boolean): void => {
    visibility.set(setModelHidden(visibility.get(), key, modelId, hidden))
  }

  const renderAgent = (agent: AcpCatalogAgent): ReactNode => {
    const wholeAgentHidden = agentHidden(current, agent.key)
    return (
      <div className={styles.agent} key={agent.key} data-agent={agent.key}>
        <div className={styles.agentHead}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={wholeAgentHidden}
              aria-label={t('acpVisibility.agentToggleNamed', { name: agent.name })}
              onChange={event => { toggleAgent(agent.key, event.target.checked) }}
            />
            <span className={styles.agentName}>{agent.name}</span>
          </label>
          <code className={styles.route}>{agent.route}</code>
        </div>
        {agent.failure !== undefined && (
          <p className={styles.note}>{t('acpVisibility.agentFailure', { message: agent.failure })}</p>
        )}
        {wholeAgentHidden && <p className={styles.note}>{t('acpVisibility.agentHiddenHint')}</p>}
        {agent.models.length === 0
          ? agent.failure === undefined && <p className={styles.note}>{t('acpVisibility.noModels')}</p>
          : (
            <ul className={styles.models}>
              {agent.models.map(model => (
                <li key={model.id}>
                  <label className={styles.toggle}>
                    <input
                      type="checkbox"
                      checked={modelHidden(current, agent.key, model.id)}
                      disabled={wholeAgentHidden}
                      aria-label={t('acpVisibility.modelToggleNamed', { name: model.name })}
                      onChange={event => { toggleModel(agent.key, model.id, event.target.checked) }}
                    />
                    <span>{model.name}</span>
                    <code className={styles.modelId}>{model.id}</code>
                  </label>
                </li>
              ))}
            </ul>
          )}
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <h2 className={styles.title}>{t('acpVisibility.title')}</h2>
      <p className={styles.intro}>{t('acpVisibility.intro')}</p>
      <div className={styles.toolbar}>
        <span className={styles.summary}>{summaryLine(current, t)}</span>
        <button
          type="button"
          className={styles.action}
          disabled={nothingHidden}
          onClick={() => { visibility.set(emptyAcpVisibility()) }}
        >{t('acpVisibility.reset')}</button>
        <button
          type="button"
          className={styles.action}
          disabled={listing.status === 'loading'}
          onClick={() => { void catalog.load(true) }}
        >{t('acpVisibility.reload')}</button>
      </div>
      {hostStore !== undefined && (
        <p
          data-storage-posture={posture?.kind}
          className={postureDisplay.tone === 'bad' ? styles.stateBad : styles.stateLine}
        >{postureDisplay.text}</p>
      )}
      {listing.status === 'error' && listing.error !== null && (
        <div className={styles.errorRow}>
          <p className={styles.stateBad} role="alert">{catalogErrorLine(listing.error, t)}</p>
          <button
            type="button"
            className={styles.action}
            onClick={() => { void catalog.load(true) }}
          >{t('acpVisibility.retry')}</button>
        </div>
      )}
      {(listing.status === 'idle' || listing.status === 'loading') && (
        <p className={styles.stateLine} role="status">{t('acpVisibility.loading')}</p>
      )}
      {listing.status === 'ready' && (
        listing.agents.length === 0
          ? <p className={styles.stateLine}>{t('acpVisibility.empty')}</p>
          : <div className={styles.agents}>{listing.agents.map(renderAgent)}</div>
      )}
    </div>
  )
}
