/**
 * The browser half of the host plugin.
 *
 * Everything below already exists as plain functions; this entry is the wiring
 * that makes it a plugin a page can load. It also owns the two failures that
 * would otherwise be silent and hard to trace: a page with no BroadcastChannel
 * (which degrades to doing nothing) and a heartbeat that never fires (which
 * would let every other tab think this host is gone). Both are reported.
 *
 * DSH-facing pieces arrive as ports, for the same reason the dispatch entry
 * avoids the runtime packages: the published versions lag far behind what runs.
 */

import { startHostView } from './view.ts'
import type { HostView } from './view.ts'
import { browserChannel } from './channel.ts'
import type { FederationBus } from './federation.ts'
import type { HostIdentity } from './identity.ts'

/** Settings key every per-host value is filed under. */
export const SETTINGS_PREFIX = 'dsh.host-settings.'

export type HostFederationConfig = {
  /** How often to re-announce, in milliseconds. */
  readonly heartbeatMs: number
  /** How long a host may go unheard before it is dropped. */
  readonly staleMs: number
  /** Channel name; one name means one roll-up. */
  readonly channelName?: string
}

/** The part of a page this entry touches. */
export type HostFederationContext = {
  /** The host id and title, as configured. */
  settings: { get(): { hostId?: string; hostTitle?: string } }
  storage: { get(key: string): unknown; set(key: string, value: unknown): void }
  /** Cross-tab channel, if this page can have one. */
  bus?: FederationBus
  /** Sessions this host holds, for its own row in the roll-up. */
  sessions(): readonly { projectId: string; sessionId: string; title: string }[]
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
  /** How about anything that fails without stopping. */
  report: { warn(message: string): void }
}

export type HostFederationHandle = HostView & {
  /** Where this host's own settings live. */
  settingsKey(): string
  /** Publish what this host holds; call whenever that changes. */
  publishSessions(): void
  dispose(): void
}

/**
 * Start the roll-up for this tab.
 *
 * Settings are read defensively: a settings service that is not up yet is an
 * ordinary state on a page that just loaded, not a reason to take the tab down.
 */
export function applyHostFederation(
  ctx: HostFederationContext,
  config: HostFederationConfig,
): HostFederationHandle {
  let configured: { hostId?: string; hostTitle?: string }
  try {
    configured = ctx.settings.get()
  } catch (error) {
    configured = {}
    ctx.report.warn(`host settings could not be read: ${messageOf(error)}`)
  }

  const bus = ctx.bus ?? browserChannel(config.channelName ?? 'dsh-host-federation')
  if (ctx.bus === undefined && typeof BroadcastChannel === 'undefined') {
    ctx.report.warn(
      'no BroadcastChannel on this page: the cross-tab roll-up stays empty and other hosts will not appear',
    )
  }

  const view = startHostView(
    {
      getSnapshot: () => ({ base: configured }),
      subscribe: () => () => {},
    },
    bus,
    {
      origin: originOf(),
      pathname: typeof location === 'undefined' ? '/' : location.pathname,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      heartbeatMs: config.heartbeatMs,
      staleMs: config.staleMs,
      listSessions: () => ctx.sessions(),
    },
  )

  // The view does not own a clock; the page does. Owning the timer here means
  // dispose can clear it — a heartbeat left running after the tab puts the view
  // away would keep announcing a host nobody is listening for.
  const timer = ctx.setInterval(() => {
    try {
      view.tick()
    } catch (error) {
      ctx.report.warn(`host heartbeat failed: ${messageOf(error)}`)
    }
  }, config.heartbeatMs)

  const originalDispose = view.dispose.bind(view)
  // Publish through the view's own method, captured before it is wrapped.
  // Assigning a wrapper that calls `view.publishSessions()` onto `view` replaces
  // the very method it calls, so the second call recurses forever and never
  // returns — which is why nothing that used this had ever run to completion.
  const originalPublish = view.publishSessions.bind(view)
  return Object.assign(view as HostFederationHandle, {
    settingsKey: () => `${SETTINGS_PREFIX}${view.identity().hostId}`,
    publishSessions: () => { originalPublish() },
    dispose: () => {
      ctx.clearInterval(timer)
      originalDispose()
    },
  })
}

function originOf(): string {
  if (typeof location !== 'undefined') return location.origin
  return ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-exported so a host entry can build the identity the same way. */
export type { HostIdentity } from './identity.ts'
