/**
 * Browser-side plugin entry for the ACP agent framework.
 *
 * Registers the agent-related UI surfaces into DSH's client slots:
 * - Model label (composer)
 * - Quota pills (below composer)
 * - ACP visibility panel (settings section)
 * - Handover card (agent switch notification)
 * - Switch progress bar
 * - Interrupted turn recovery
 * - ACP process view (session area)
 * - Markdown turn readers (session area)
 * - Mermaid diagrams (session area)
 * - Lost input surface
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime, SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'

import { registerModelLabel } from './model-label.tsx'
import { createQuotaPoller, registerQuotaDockPills, routeQuotaFetcher } from './quota-pill.ts'
import { registerInterruptedTurnRecovery } from './interrupted-turn-recovery.ts'
import { createMarkdownTurnReaders } from './markdown-turn-sources.ts'
import { registerMarkdownTurn } from './markdown-turn.tsx'
import { registerAcpVisibilitySection } from './acp-visibility-panel.tsx'
import { startAcpVisibility } from './acp-visibility.ts'
import type { AcpVisibilityStore } from './acp-visibility.ts'
import { createAcpCatalogStore } from './acp-visibility-catalog.ts'
import { installAcpVisibilityFilter } from './acp-visibility-filter.ts'
import { AgentSwitchHandoverCard, agentSwitchHandoverDefinition, registerAgentSwitchHandoverSurface } from './handover-card.ts'
import { registerLostInputSurface } from './lost-input.ts'
import { registerAcpProcessSurface } from './acp-process-surface.tsx'
import { createSwitchProgressStore, startSwitchProgressSurface } from './switch-progress.ts'
import { startMermaidDiagrams } from './mermaid.ts'
import { NAMESPACE, fallbackT, zh } from './locales.ts'
import type { RuntimeT } from './locales.ts'
import { createElement } from 'react'

export type ClientPanelContext = ClientContext & {
  readonly locale?: {
    readonly register?: (dictionaries: Record<string, unknown>) => void
  }
}

export const inject = ['slots', 'remote', 'remote.settings', 'remote.session', 'remote.workspaceFiles', 'uiConversation', 'uiWorkspace', 'sessions', 'locale']

type Log = (message: string) => void

function propertyOf(obj: unknown, name: string): unknown {
  return obj === null || obj === undefined ? undefined : (obj as unknown as Record<string, unknown>)[name]
}

function boundMethod(obj: unknown, name: string): Function | undefined {
  const fn = propertyOf(obj, name)
  return typeof fn === 'function' ? (fn as Function) : undefined
}

function readService(ctx: ClientContext, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function safeRegister(label: string, fn: () => void | (() => void), log: Log): void {
  try {
    fn()
  } catch (error) {
    log(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx: any, _config: unknown, log: Log): () => void {
  const t: RuntimeT = (key, params) => fallbackT(key, params)

  // Register locale dictionaries
  const registerLocale = propertyOf(ctx, 'locale')
  if (registerLocale !== undefined && typeof registerLocale === 'object') {
    const register = propertyOf(registerLocale, 'register')
    if (typeof register === 'function') {
      (register as Function).call(registerLocale, { [NAMESPACE]: { zh: { ...zh }, en: {} } })
    }
  }

  // Model label in composer
  safeRegister('model label', () => {
    const dispose = registerModelLabel(ctx)
    return dispose
  }, log)

  // Quota pills below composer
  safeRegister('quota pills', () => {
    const fetchQuota = routeQuotaFetcher(fetch)
    const poller = createQuotaPoller({ fetchQuota })
    const dispose = registerQuotaDockPills(ctx.slots, poller, {})
    return dispose
  }, log)

  // Interrupted turn recovery
  safeRegister('interrupted turn recovery', () => {
    return registerInterruptedTurnRecovery(ctx)
  }, log)

  // Markdown turn readers
  safeRegister('markdown turn', () => {
    const readers = createMarkdownTurnReaders(ctx)
    const dispose = registerMarkdownTurn(ctx, readers)
    return dispose
  }, log)

  // Mermaid diagrams
  safeRegister('mermaid', () => {
    startMermaidDiagrams(ctx); return () => {}
  }, log)

  // Handover card (agent switch notification)
  safeRegister('handover card', () => {
    const dispose = registerAgentSwitchHandoverSurface(ctx)
    return dispose
  }, log)

  // Lost input surface
  safeRegister('lost input', () => {
    return registerLostInputSurface(ctx)
  }, log)

  // ACP process view
  safeRegister('acp process surface', () => {
    return registerAcpProcessSurface(ctx)
  }, log)

  // Switch progress bar
  safeRegister('switch progress', () => {
    const store = createSwitchProgressStore()
    startSwitchProgressSurface({ ctx: ctx, store, slots: (ctx).slots })
    return () => {}
  }, log)

  // ACP visibility: store + catalog + filter + settings section
  safeRegister('acp visibility', () => {
    const storage = { getItem: (k: string) => localStorage.getItem(k), setItem: (k: string, v: string) => localStorage.setItem(k, v) }
    const visibility = startAcpVisibility(storage, (msg) => log(`acp visibility: ${msg}`))
    const catalog = createAcpCatalogStore(ctx)
    const report: Log = (msg) => log(`acp visibility: ${msg}`)

    // Install picker filter
    mountAcpVisibilityFilter(ctx, visibility, report)

    // Register settings section
    const slots = (ctx as { slots: unknown }).slots
    const face: Record<string, unknown> = { visibility, catalog, t }
    const reader = catalogReaderOf(ctx)
    if (reader !== undefined) face.catalogReader = reader
    registerAcpVisibilitySection(slots as never, face as never, () => t('acpVisibility.label'))

    return () => {}
  }, log)

  return () => {}
}

function mountAcpVisibilityFilter(
  ctx: any,
  visibility: AcpVisibilityStore,
  report: Log,
): void {
  const attach = (service: unknown, effect: (dispose: () => void) => void): void => {
    const dispose = installAcpVisibilityFilter(service, visibility, report)
    if (dispose !== undefined) effect(dispose)
  }
  const injector = (ctx as any).inject
  if (typeof injector === 'function') {
    (injector as Function).call(ctx, ['modelDirectories'], (child: unknown) => {
      const childEffect = boundMethod(child, 'effect')
      attach(propertyOf(child, 'modelDirectories'), dispose => {
        if (childEffect !== undefined) childEffect(() => dispose)
        else (ctx as any).effect(() => dispose, 'threadharbor: acp visibility picker filter')
      })
    })
    return
  }
  let service: unknown
  try {
    service = ctx.get('modelDirectories')
  } catch {
    service = undefined
  }
  attach(service, dispose => {
    (ctx as any).effect(() => dispose, 'threadharbor: acp visibility picker filter')
  })
}

function catalogReaderOf(ctx: ClientPanelContext): (() => Promise<unknown>) | undefined {
  const direct = readService(ctx, 'remote.session')
  const session = direct ?? propertyOf(readService(ctx, 'remote'), 'session')
  const read = boundMethod(session, 'modelCatalog')
  return read === undefined ? undefined : async () => await read.call(session)
}
