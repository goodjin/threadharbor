import type { HostSession } from '@threadharbor/dsh-host-federation'

/** Mutable remote session cache keyed by hostId (read by roll-up, written by panel polls). */
export type RemoteSessionStore = {
  set(hostId: string, sessions: readonly HostSession[], note?: string): void
  get(hostId: string): { readonly sessions: readonly HostSession[]; readonly note?: string } | undefined
  snapshot(): ReadonlyMap<string, readonly HostSession[]>
  /** The same cache, failures included: entries carry their note when a fetch failed. */
  snapshotWithNotes(): ReadonlyMap<string, { readonly sessions: readonly HostSession[]; readonly note?: string }>
  subscribe(listener: () => void): () => void
}

export function createRemoteSessionStore(): RemoteSessionStore {
  const byHost = new Map<string, { sessions: readonly HostSession[]; note?: string }>()
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  return {
    set: (hostId, sessions, note) => {
      byHost.set(hostId, { sessions, ...(note === undefined ? {} : { note }) })
      notify()
    },
    get: hostId => byHost.get(hostId),
    snapshot: () => {
      const map = new Map<string, readonly HostSession[]>()
      for (const [hostId, entry] of byHost) map.set(hostId, entry.sessions)
      return map
    },
    snapshotWithNotes: () => new Map(byHost),
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
