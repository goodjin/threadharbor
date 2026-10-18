/**
 * Which remote session the main area is showing.
 *
 * The session itself stays on its host. This store only remembers which one
 * the person asked to look at, so the sidebar and the main panel agree.
 */

export type RemoteSelection = {
  readonly hostId: string
  readonly hostTitle: string
  readonly launchUrl: string
  /** Absent when the person opened the host itself, not one of its sessions. */
  readonly sessionId?: string
  readonly title?: string
  readonly projectId?: string
}

export type RemoteConversationStore = {
  getSnapshot(): RemoteSelection | null
  subscribe(listener: () => void): () => void
  open(selection: RemoteSelection): void
  close(): void
  retitle(title: string): void
}

export function createRemoteConversationStore(): RemoteConversationStore {
  let snapshot: RemoteSelection | null = null
  const listeners = new Set<() => void>()
  const publish = (next: RemoteSelection | null): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: selection => { publish(selection) },
    close: () => { publish(null) },
    retitle: title => {
      if (snapshot === null) return
      publish({ ...snapshot, title })
    },
  }
}

let shared: RemoteConversationStore | undefined

/** One store for the page: the tree writes it, the main panel reads it. */
export function sharedRemoteConversation(): RemoteConversationStore {
  shared ??= createRemoteConversationStore()
  return shared
}
