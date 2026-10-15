/**
 * Seeing several hosts from one page.
 *
 * One browser tab per host, plus a page that sums them up. Presence is
 * heartbeat-based rather than goodbye-based: a tab that crashes or is closed
 * mid-write never says goodbye, and a roll-up that waits for one would keep
 * showing its host forever.
 *
 * The channel carries presence only — 2026-10-11 用户决定（§8.3）：会话与项目
 * 不进这个面板；2026-10-14 再次执行：SSH 部署分支曾把 `sessions` 报文和
 * 会话树加回来，用户确认那不是原先的设计，随这棵树一起撤掉。看某台主机
 * 的会话，去那台主机自己的页面。
 *
 * The broadcast channel is a port, so all of this runs without a browser.
 */

import type { HostIdentity } from './identity.ts'

/** One message on the channel. */
export type Announcement = {
  readonly kind: 'hello' | 'heartbeat' | 'bye'
  readonly hostId: string
  readonly hostTitle: string
  readonly at: number
}

/** A same-origin channel between tabs. */
export type FederationBus = {
  post(message: unknown): void
  subscribe(listener: (message: unknown) => void): void
}

export type HostSnapshot = {
  readonly hostId: string
  readonly hostTitle: string
  /** When this host last said anything, in the page's clock. */
  readonly lastSeen: number
  readonly self: boolean
}

/** One session as a host reports it. */
export type HostSession = {
  readonly projectId: string
  readonly sessionId: string
  readonly title: string
  /** The project's own name, when the host knows it. */
  readonly projectTitle?: string
  /** Pinned sessions lead their project in the tree (native seating rule). */
  readonly pinned?: boolean
  /** Archived rows stay out of sight until the tree's filter asks for them. */
  readonly archived?: boolean
  /** Last activity stamp; orders the tree's 最近更新 sort. */
  readonly updatedAt?: number
}

export type ProjectGroup = {
  readonly projectId: string
  /**
   * The project's name, taken from whichever session first carried it.
   *
   * Sessions cross the channel one at a time and only some of them know the
   * name, so the first one that does supplies it — better one project's worth of
   * rows reading "Web" and the rest reading its id.
   */
  readonly projectTitle?: string
  readonly sessions: readonly HostSession[]
}

export type HostRoll = HostSnapshot & {
  readonly projects: readonly ProjectGroup[]
  readonly sessions: readonly HostSession[]
  /** Registered but never deployed (registry-side fact, not a channel fact). */
  readonly undeployed?: boolean
  /** Why the last remote fetch produced nothing, verbatim. */
  readonly note?: string
}

export type RollUp = {
  readonly hosts: readonly HostRoll[]
}

export type FederationOptions = {
  /** A host silent for this long is treated as gone. */
  readonly staleMs: number
  /** Injectable clock, so the expiry window can be tested without waiting. */
  now?(): number
  /** Called when the set of hosts changes, so a view can re-render. */
  onChange?(): void
}

export class HostFederation {
  /** Named `presence`, not `hosts`: a field of that name would shadow the method. */
  private readonly presence = new Map<string, HostSnapshot>()
  private running = false

  private identity: HostIdentity

  constructor(
    identity: HostIdentity,
    private readonly bus: FederationBus,
    private readonly options: FederationOptions,
  ) {
    this.identity = identity
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

  /** Say goodbye, so other pages drop this host at once. Releases this host. */
  dispose(): void {
    if (!this.running) return
    this.running = false
    this.announce('bye')
  }

  /** Re-announce; called on a timer while running. */
  emitHeartbeat(): void {
    if (!this.running) return
    this.announce('heartbeat')
  }

  /** Re-title this host without churning the channel with bye/hello. */
  renameSelf(hostTitle: string): void {
    this.identity = { ...this.identity, hostTitle }
    const self = this.presence.get(this.identity.hostId)
    if (self !== undefined) {
      this.presence.set(self.hostId, { ...self, hostTitle })
    }
    this.emitHeartbeat()
  }

  hosts(): readonly HostSnapshot[] {
    return [...this.presence.values()].sort(byHostId)
  }

  /** Every host except this tab's own. */
  foreignHosts(): readonly HostSnapshot[] {
    return this.hosts().filter(host => !host.self)
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

    this.touch(parsed)

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
    this.bus.post({
      kind,
      hostId: this.identity.hostId,
      hostTitle: this.identity.hostTitle,
      at: this.now(),
    })
  }

  /** Record a host as alive, adding it if this is the first word from it. */
  private touch(parsed: Announcement): void {
    const existing = this.presence.get(parsed.hostId)
    if (existing !== undefined) {
      this.presence.set(parsed.hostId, { ...existing, lastSeen: parsed.at, hostTitle: parsed.hostTitle })
      return
    }
    this.presence.set(parsed.hostId, {
      hostId: parsed.hostId,
      hostTitle: parsed.hostTitle,
      lastSeen: parsed.at,
      self: false,
    })
    this.changed()
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
