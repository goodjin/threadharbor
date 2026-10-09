/**
 * Seeing several hosts from one page.
 *
 * One browser tab per host, plus a page that sums them up. Presence is
 * heartbeat-based rather than goodbye-based: a tab that crashes or is closed
 * mid-write never says goodbye, and a roll-up that waits for one would keep
 * showing its sessions forever.
 *
 * The broadcast channel is a port, so all of this runs without a browser.
 */

import type { HostIdentity } from './identity.ts'

/** One message on the channel. */
export type Announcement = {
  readonly kind: 'hello' | 'heartbeat' | 'bye'
  readonly hostId: unknown
  readonly hostTitle: unknown
  readonly at: number
}

/** A same-origin channel between tabs. */
export type FederationBus = {
  post(message: unknown): void
  subscribe(listener: (message: unknown) => void): void
}

/** One session as a host reports it. */
export type HostSession = {
  readonly projectId: string
  readonly sessionId: string
  readonly title: string
}

export type HostSnapshot = {
  readonly hostId: string
  readonly hostTitle: string
  /** When this host last said anything, in the page's clock. */
  readonly lastSeen: number
  readonly self: boolean
}

export type ProjectGroup = {
  readonly projectId: string
  readonly sessions: readonly HostSession[]
}

export type HostRoll = HostSnapshot & {
  readonly projects: readonly ProjectGroup[]
  readonly sessions: readonly HostSession[]
}

export type RollUp = {
  readonly hosts: readonly HostRoll[]
}

export type FederationOptions = {
  /** A host silent for this long is treated as gone. */
  readonly staleMs: number
  /** Ask a host for its sessions; absent means it contributes none. */
  readonly listSessions?(hostId: string): readonly HostSession[]
  /** Injectable clock, so the expiry window can be tested without waiting. */
  readonly now?(): number
  /** Called when the set of hosts changes, so a view can re-render. */
  readonly onChange?(): void
}

export class HostFederation {
  /** Named `presence`, not `hosts`: a field of that name would shadow the method. */
  private readonly presence = new Map<string, HostSnapshot>()
  private running = false

  constructor(
    private readonly identity: HostIdentity,
    private readonly bus: FederationBus,
    private readonly options: FederationOptions,
  ) {
    this.presence.set(identity.hostId, {
      hostId: identity.hostId,
      hostTitle: identity.hostTitle,
      lastSeen: this.now(),
      self: true,
    })
    this.bus.subscribe(message => { this.receive(message) })
  }

  /** Announce this host and start counting. */
  start(): void {
    if (this.running) return
    this.running = true
    this.announce('hello')
  }

  /** Say goodbye, so other pages drop this host at once. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.announce('bye')
  }

  /** Re-announce; called on a timer while running. */
  emitHeartbeat(): void {
    if (!this.running) return
    this.announce('heartbeat')
  }

  hosts(): readonly HostSnapshot[] {
    return [...this.presence.values()].sort(byHostId)
  }

  /** Every host except this tab's own. */
  foreignHosts(): readonly HostSnapshot[] {
    return this.hosts().filter(host => !host.self)
  }

  /** Sessions grouped host → project, for one view. */
  rollUp(): RollUp {
    return {
      hosts: this.hosts().map(host => {
        const sessions = host.self ? this.listSelf() : this.listOther(host.hostId)
        return {
          ...host,
          sessions,
          projects: groupByProject(sessions),
        }
      }),
    }
  }

  /**
   * Take one announcement.
   *
   * Exposed so a test can drive the clock, and so a real channel and a fake one
   * go through exactly the same path.
   */
  receive(message: unknown): void {
    const parsed = parseAnnouncement(message)
    if (parsed === undefined) return
    // Our own announcement comes back on the channel; counting it as a second
    // host would list this machine twice.
    if (parsed.hostId === this.identity.hostId) return

    const existing = this.presence.get(parsed.hostId)
    if (existing !== undefined) {
      this.presence.set(parsed.hostId, { ...existing, lastSeen: parsed.at, hostTitle: parsed.hostTitle })
    } else {
      this.presence.set(parsed.hostId, {
        hostId: parsed.hostId,
        hostTitle: parsed.hostTitle,
        lastSeen: parsed.at,
        self: false,
      })
      this.changed()
    }

    if (parsed.kind === 'bye') {
      this.presence.delete(parsed.hostId)
      this.changed()
    }
  }

  /** Drop every host silent for longer than the window. */
  expire(at: number): void {
    let dropped = false
    for (const host of [...this.presence.values()]) {
      if (host.self) continue
      if (at - host.lastSeen > this.options.staleMs) {
        this.presence.delete(host.hostId)
        dropped = true
      }
    }
    if (dropped) this.changed()
  }

  private announce(kind: Announcement['kind']): void {
    this.bus.post({ kind, hostId: this.identity.hostId, hostTitle: this.identity.hostTitle, at: this.now() })
  }

  private listSelf(): readonly HostSession[] {
    return this.options.listSessions?.(this.identity.hostId) ?? []
  }

  private listOther(hostId: string): readonly HostSession[] {
    return this.options.listSessions?.(hostId) ?? []
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private changed(): void {
    this.options.onChange?.()
  }
}

function parseAnnouncement(message: unknown): Announcement | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as Record<string, unknown>
  const kind = record['kind']
  if (kind !== 'hello' && kind !== 'heartbeat' && kind !== 'bye') return undefined
  const hostId = record['hostId']
  const hostTitle = record['hostTitle']
  const at = record['at']
  // A malformed announcement is dropped rather than trusted: a host with a
  // non-string id cannot be listed, and half a host is worse than none.
  if (typeof hostId !== 'string' || hostId === '') return undefined
  if (typeof hostTitle !== 'string') return undefined
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  return { kind, hostId, hostTitle, at }
}

function byHostId(a: HostSnapshot, b: HostSnapshot): number {
  return a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0
}

function groupByProject(sessions: readonly HostSession[]): ProjectGroup[] {
  const byProject = new Map<string, HostSession[]>()
  for (const session of sessions) {
    const bucket = byProject.get(session.projectId)
    if (bucket === undefined) byProject.set(session.projectId, [session])
    else bucket.push(session)
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([projectId, items]) => ({ projectId, sessions: items }))
}
