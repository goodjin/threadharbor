/**
 * The roll-up, as a panel section.
 *
 * This is the assembly the roll-up waited for: a real settings source (the
 * panel's identity form, backed by page storage), a real channel, a real
 * heartbeat — and a real session source: this host's sessions, read from DSH's
 * own client projections and published to every other same-origin tab. When
 * that source cannot deliver, the section says exactly why instead of showing
 * a tree that looks caught up.
 *
 * Built directly on the federation's exported pieces. `applyHostFederation`
 * would have been the front door, but its published handle re-points
 * `publishSessions` at itself and recurses until the stack gives out — it has
 * never once run to completion. The steps it meant to take are taken here,
 * each one owned by this file: defensive settings read, channel fallback
 * warning, timer ownership, publish-on-start.
 *
 * Identity changes restart the federation: the old one says goodbye on
 * dispose, the new one announces under the new identity, and no stale host is
 * left behind in the other tabs.
 */

import { HostFederation, browserChannel, resolveHostIdentity } from '@threadharbor/dsh-host-federation'
import type { FederationBus, HostIdentity, HostSnapshot, HostRegistration } from '@threadharbor/dsh-host-federation'
import { mountRollUp } from '@threadharbor/dsh-host-federation/rollup-mount'
import type { SessionTarget } from '@threadharbor/dsh-host-federation/rollup-mount'
import { mountRollUpSurface } from './surface.ts'
import type { RollUpSurface } from './surface.ts'
import type { ConfiguredIdentity, IdentitySettings } from './settings-source.ts'
import { rollUpViewWithRegistry } from './host-roll-up.ts'
import { fallbackT } from './locales.ts'
import type { RuntimeT } from './locales.ts'

/** What one host reports about its sessions, as the federation reads it. */
export type SectionSession = { readonly projectId: string; readonly sessionId: string; readonly title: string; readonly projectTitle?: string }

/** Everything the section needs from the page around it. */
export type RollUpSectionDeps = {
  /** The panel's identity form: what this host is called and where it is kept. */
  settings: IdentitySettings
  /** Sessions this host holds; re-read on every publish. */
  sessions(): readonly SectionSession[]
  /** Registered hosts and remote snapshots for the left-hand session tree. */
  registrations?(): readonly HostRegistration[]
  remoteSessions?(): ReadonlyMap<string, readonly SectionSession[]>
  onSelectSession?(target: SessionTarget): void
  /**
   * Why the tree's rows may be empty or stale, in words the operator can act
   * on. Empty when the session source is healthy: nothing is said about a
   * read that succeeded.
   */
  sourceNotes(): readonly string[]
  /** Cross-tab channel; absent means the section opens a BroadcastChannel. */
  bus?: FederationBus
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
  /** Where failures are said out loud instead of swallowed. */
  report(message: string): void
  /**
   * Reads the section's user-facing notes in the active language. Absent
   * (tests, no locale service) it falls back to the dictionary's source
   * text — the notes reach the screen through the roll-up's mount.
   */
  t?: RuntimeT
  heartbeatMs: number
  staleMs: number
}

/** The roll-up as the panel renders it. */
export type RollUpSection = {
  /** The drawn roll-up, ready to place in the panel. */
  element(): HTMLElement
  /** Who this tab currently says it is. */
  identity(): HostIdentity
  /** What the section cannot show, in words the operator can act on. */
  notices(): readonly string[]
  /** Save a new identity; an id change re-announces under the new one. */
  setIdentity(value: ConfiguredIdentity): void
  /** Re-read identity from settings without writing (host storage hydration). */
  rereadIdentity(): void
  /** Every host currently visible on the channel (presence). */
  hosts(): readonly HostSnapshot[]
  /** The hostIds currently present on the channel, this tab's included. */
  onlineHostIds(): readonly string[]
  /** Re-read this host's sessions and announce them again. */
  republish(): void
  /** Stop the heartbeat and say goodbye. */
  dispose(): void
}

/** The channel name one roll-up shares; one name means one roll-up. */
const CHANNEL_NAME = 'dsh-host-federation'

/**
 * Start the roll-up section.
 * @param deps - the page-supplied ports; see {@link RollUpSectionDeps}.
 * @returns the section; dispose stops the heartbeat and says goodbye.
 */
export function startRollUpSection(deps: RollUpSectionDeps): RollUpSection {
  const say = deps.t ?? fallbackT
  let identity = resolveIdentity()
  // The federation can report changes before the surface exists; the holder
  // lets the first drawings and every later one go through the same path.
  let surface: RollUpSurface | undefined
  let onChange: () => void = () => {}
  let federation = open(identity)
  const timer = deps.setInterval(() => { beat() }, deps.heartbeatMs)

  function beat(): void {
    try {
      // The re-read is the point: sessions opened or closed since the last
      // beat reach the other tabs without anyone pressing anything.
      federation.publishSessions(deps.sessions())
    } catch (error: unknown) {
      deps.report(`session publish failed: ${messageOf(error)}`)
    }
    try {
      federation.emitHeartbeat()
    } catch (error: unknown) {
      deps.report(`host heartbeat failed: ${messageOf(error)}`)
    }
    try {
      federation.expire(Date.now())
    } catch (error: unknown) {
      deps.report(`host expiry failed: ${messageOf(error)}`)
    }
  }

  function resolveIdentity(): HostIdentity {
    let configured: ConfiguredIdentity
    try {
      configured = deps.settings.read()
    } catch (error: unknown) {
      // A settings read that fails is an ordinary not-configured-yet, not a
      // reason to take the roll-up down.
      configured = {}
      deps.report(`host settings could not be read: ${messageOf(error)}`)
    }
    return resolveHostIdentity({
      configuredHostId: configured.hostId,
      configuredHostTitle: configured.hostTitle,
      origin: typeof location === 'undefined' ? '' : location.origin,
      pathname: typeof location === 'undefined' ? '/' : location.pathname,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    })
  }

  function open(next: HostIdentity): HostFederation {
    const bus = deps.bus ?? openChannel()
    return new HostFederation(next, bus, {
      staleMs: deps.staleMs,
      listSessions: () => deps.sessions(),
      onChange: () => { onChange() },
    })
  }

  function openChannel(): FederationBus {
    const bus = browserChannel(CHANNEL_NAME)
    // The channel is how other tabs hear about this host at all; a page
    // without one must not look like a working roll-up that shows nobody.
    if (typeof BroadcastChannel === 'undefined') {
      deps.report('no BroadcastChannel on this page: the cross-tab roll-up stays empty and other hosts will not appear')
    }
    return bus
  }

  // Announced up front: a tab that only said hello would leave its own row
  // empty in every other tab, and nothing is going to come and ask. The
  // surface publishes on start — that is its documented job — so the section
  // does not say it twice.
  federation.start()
  const readView = () => {
    const registrations = deps.registrations?.() ?? []
    const remote = deps.remoteSessions?.() ?? new Map()
    return rollUpViewWithRegistry(federation.rollUp(), registrations, remote)
  }
  surface = mountRollUpSurface({
    read: readView,
    federation: {
      rollUp: () => federation.rollUp(),
      identity: () => identity,
      publishSessions: () => { federation.publishSessions(deps.sessions()) },
      tick: () => { beat() },
      dispose: () => { federation.dispose() },
    },
    ...(deps.onSelectSession === undefined ? {} : { onSelect: deps.onSelectSession }),
    mount: (container, read) => mountRollUp(container, read, {
      ...(deps.onSelectSession === undefined ? {} : { onSelect: deps.onSelectSession }),
      hostNote: host => {
        if (host.self) {
          const notes = deps.sourceNotes()
          return notes.length > 0 ? notes.join(' ') : undefined
        }
        return host.empty ? say('panel.rollup.emptySessions') : undefined
      },
    }),
  })
  onChange = () => { surface?.refresh() }

  function applyIdentity(next: HostIdentity): void {
    if (next.hostId === identity.hostId) {
      const titleChanged = next.hostTitle !== identity.hostTitle
      identity = next
      if (titleChanged) federation.renameSelf(next.hostTitle)
      onChange()
      return
    }
    federation.dispose()
    identity = next
    federation = open(identity)
    federation.start()
    onChange()
  }

  return {
    element: () => surface?.element() ?? document.createElement('div'),
    identity: () => identity,
    notices: () => [
      ...deps.sourceNotes(),
      say('panel.rollup.crossSourceNote'),
    ],
    setIdentity: value => {
      deps.settings.write(value)
      applyIdentity(resolveIdentity())
    },
    rereadIdentity: () => {
      applyIdentity(resolveIdentity())
    },
    hosts: () => federation.hosts(),
    onlineHostIds: () => federation.hosts().map(host => host.hostId),
    republish: () => {
      try {
        federation.publishSessions(deps.sessions())
      } catch (error: unknown) {
        deps.report(`session publish failed: ${messageOf(error)}`)
      }
      onChange()
    },
    dispose: () => {
      // The timer first: a heartbeat left running after the panel is gone
      // would keep announcing a host nobody is listening for.
      deps.clearInterval(timer)
      surface?.dispose()
      federation.dispose()
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
