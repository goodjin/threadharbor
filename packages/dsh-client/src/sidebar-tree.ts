/**
 * The shadow that takes over `sidebar.workspaces`.
 *
 * The slot system renders the lowest priority number, so registering at -10
 * shadows DSH's native workspace list (its default registration is 0) — the
 * takeover is the mechanism's documented face, not a hack. A localStorage kill
 * switch (`threadharbor.sidebarTree` = `off`) skips the registration entirely
 * and the native list comes back: the honest retreat when an upgrade drifts.
 *
 * This module owns the plumbing the pure tree refuses to do: reading this
 * machine's sessions from DSH's services, polling the registry's deployed
 * hosts, and merging both into one `RollUpView` for `HostSessionTree`.
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HostRegistration, HostRoll, HostSession, RollUp } from '@threadharbor/dsh-host-federation'
import { hostRegistry } from '@threadharbor/dsh-host-federation'
import { HostSessionTree } from './host-session-tree.tsx'
import { showNativeConversation, showRemoteSessionPanel } from './remote-conversation.tsx'
import { sharedRemoteConversation } from './remote-conversation-store.ts'
import { remoteTreeActions } from './remote-tree-actions.ts'
import { rollUpViewWithRegistry, groupByProject } from './host-roll-up.ts'
import { createRemoteSessionStore } from './remote-session-store.ts'
import { buildHostSessions, currentSessionId, readSessionSources } from './session-source.ts'
import type { SessionRead } from './session-source.ts'
import { fetchHostSessions, settleHostFetch } from './remote-session-poll.ts'
import type { HostSessionsResult } from './remote-session-poll.ts'
import type { RuntimeT } from './locales.ts'
import { NAMESPACE, fallbackT } from './locales.ts'

/** The kill switch: `off` restores DSH's native workspace list. */
export const TREE_STORAGE_KEY = 'threadharbor.sidebarTree'

/** The slot face the client entry hands in; tests build a recording fake. */
export type TreeSlotHost = {
  inject(slot: string, callback: () => unknown): unknown
  // The real register takes the full options table (children/locale/store/…);
  // this module only ever passes name+priority, and the return is a dispose.
  register(options: { name: string; priority?: number; locale?: string }, component: unknown): () => void
}

type ServicesCtx = { get(name: string): unknown }
type RegistryLike = { list(): readonly HostRegistration[] }

const registeredHosts = new WeakSet<TreeSlotHost>()

const safeStorage = (): Storage | { getItem(): null; setItem(): void; removeItem(): void } => {
  try {
    return window.localStorage
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  }
}

/**
 * Register the tree once per slot host, at a priority that shadows the native
 * workspace list. HMR re-runs land in the WeakSet guard and stay silent.
 */
export function maybeRegisterSidebarTree(slots: TreeSlotHost, ctx: ServicesCtx, registry?: RegistryLike): void {
  if (registeredHosts.has(slots)) return
  registeredHosts.add(slots)
  let off = false
  try {
    off = localStorage.getItem(TREE_STORAGE_KEY) === 'off'
  } catch {
    off = false
  }
  if (off) return
  // The entry hands in the panel's own registry (the settings-channel storage);
  // the localStorage default only serves tests and standalone mounts, and
  // would silently disagree with what the panel shows.
  const bound: RegistryLike = registry ?? hostRegistry(safeStorage())
  slots.inject('sidebar.workspaces', () => slots.register(
    { name: 'sidebar.workspaces', priority: -10, locale: NAMESPACE },
    (props: { readonly t?: RuntimeT }) =>
      createElement(ShadowTreeHost, {
        ctx,
        registry: bound,
        ...(props.t === undefined ? {} : { t: props.t }),
      }),
  ))
}

const LOCAL_POLL_MS = 30_000
const REMOTE_POLL_MS = 60_000

type ShadowProps = {
  /** The open session, when the conversation owns the main area; null while a panel is active. */
  readonly currentSessionId?: string
  readonly ctx: ServicesCtx
  readonly registry: RegistryLike
  readonly t?: RuntimeT
  /** From the sidebar parent's inject; absent in tests and in-panel mounts. */
  /** Test seam: one remote fetch. Production default hits the host-side route. */
  readonly fetchNow?: (launchUrl: string) => Promise<HostSessionsResult>
  readonly pollMs?: number
}

export function ShadowTreeHost({ ctx, registry, t = fallbackT, fetchNow, pollMs }: ShadowProps) {
  // Selected-state source of truth: re-derived on every read, so the tree's
  // highlight follows both service publishes and panel switches.
  const [currentId, setCurrentId] = useState<string | undefined>(undefined)
  const [selfRead, setSelfRead] = useState<SessionRead>({ ok: false, note: t('panel.tree.noSessions') })
  const store = useMemo(() => createRemoteSessionStore(), [])
  // registry.list() returns a fresh array every call; keying an effect on it
  // would refetch on every render and loop forever. A ref carries the latest
  // list; the state copy below only exists to re-render the tree when it changes.
  const registrationsRef = useRef(registry.list())
  const [registrations, setRegistrations] = useState(() => registry.list())

  const refreshRegistrations = useCallback(() => {
    const next = registry.list()
    registrationsRef.current = next
    setRegistrations(next)
  }, [registry])

  const readLocal = useCallback(() => {
    const sources = readSessionSources({
      workspaces: ctx.get('workspaces'),
      sessions: ctx.get('sessions'),
    })
    setSelfRead(buildHostSessions(sources.workspaces, sources.sessions))
    // Native rule: no highlight while a panel owns the main area.
    const panelActive = (() => {
      try {
        const layout = ctx.get('layout') as { panelInfo?: { getSnapshot(): { activePanelId?: string | null } } } | undefined
        return layout?.panelInfo?.getSnapshot().activePanelId != null
      } catch {
        return false
      }
    })()
    setCurrentId(panelActive ? undefined : currentSessionId(sources.sessions))
    refreshRegistrations()
  }, [ctx, refreshRegistrations])

  const pullGeneration = useRef(new Map<string, number>())
  const pull = useCallback(async (launchUrl: string, hostId: string) => {
    const attempt = fetchNow ?? ((url: string) => fetchHostSessions(url, t))
    const generation = (pullGeneration.current.get(hostId) ?? 0) + 1
    pullGeneration.current.set(hostId, generation)
    const result = await attempt(launchUrl)
    // A slower earlier pull must not overwrite a newer answer.
    if (pullGeneration.current.get(hostId) !== generation) return
    const settled = settleHostFetch(store.get(hostId)?.sessions, result)
    store.set(hostId, settled.sessions, settled.note)
    refreshRegistrations()
  }, [fetchNow, store, t, refreshRegistrations])

  useEffect(() => {
    readLocal()
    // Services publish their own changes; the interval is only the fallback
    // for projections without a subscribe seat — otherwise a fresh page shows
    // 「还在加载」 for up to a full poll period after hydration.
    const sources = readSessionSources({
      workspaces: ctx.get('workspaces'),
      sessions: ctx.get('sessions'),
    })
    const layoutSubscribe = (() => {
      try {
        const layout = ctx.get('layout') as { panelInfo?: { subscribe(listener: () => void): () => void } } | undefined
        return layout?.panelInfo?.subscribe
      } catch {
        return undefined
      }
    })()
    const unsubscribes = [sources.workspaces?.subscribe, sources.sessions?.subscribe, layoutSubscribe]
      .filter((subscribe): subscribe is (listener: () => void) => () => void => typeof subscribe === 'function')
      .map(subscribe => subscribe(readLocal))
    const localTimer = window.setInterval(readLocal, pollMs ?? LOCAL_POLL_MS)
    return () => {
      for (const dispose of unsubscribes) dispose()
      window.clearInterval(localTimer)
    }
  }, [readLocal, pollMs, ctx])

  useEffect(() => {
    const run = (): void => {
      // Read through the ref: fresh every tick, never an effect dependency.
      for (const row of registrationsRef.current) {
        if (row.launchUrl !== undefined && row.launchUrl !== '') void pull(row.launchUrl, row.hostId)
      }
    }
    run()
    const remoteTimer = window.setInterval(run, REMOTE_POLL_MS)
    return () => { window.clearInterval(remoteTimer) }
  }, [pull])

  const launchUrls = useMemo(() => {
    const map: Record<string, string> = {}
    for (const row of registrations) {
      if (row.launchUrl !== undefined && row.launchUrl !== '') map[row.hostId] = row.launchUrl
    }
    return map
  }, [registrations])
  const conversation = useMemo(() => sharedRemoteConversation(), [])
  const remoteActions = useMemo(() => {
    const raw = remoteTreeActions(t)
    const refresh = async (launchUrl: string): Promise<void> => {
      const host = registrationsRef.current.find(row => row.launchUrl === launchUrl)
      if (host !== undefined) await pull(launchUrl, host.hostId)
    }
    return {
      ...raw,
      startSession: async (launchUrl: string, projectId: string) => {
        const created = await raw.startSession(launchUrl, projectId)
        if (created.error === undefined) await refresh(launchUrl)
        return created
      },
      renameWorkspace: async (launchUrl: string, projectId: string, title: string) => {
        const error = await raw.renameWorkspace(launchUrl, projectId, title)
        if (error === undefined) await refresh(launchUrl)
        return error
      },
      deleteWorkspace: async (launchUrl: string, projectId: string) => {
        const error = await raw.deleteWorkspace(launchUrl, projectId)
        if (error === undefined) await refresh(launchUrl)
        return error
      },
      renameSession: async (launchUrl: string, sessionId: string, title: string) => {
        const error = await raw.renameSession(launchUrl, sessionId, title)
        if (error === undefined) await refresh(launchUrl)
        return error
      },
      archiveSession: async (launchUrl: string, sessionId: string) => {
        const error = await raw.archiveSession(launchUrl, sessionId)
        if (error === undefined) await refresh(launchUrl)
        return error
      },
      pinSession: async (launchUrl: string, sessionId: string, pinned: boolean) => {
        const error = await raw.pinSession(launchUrl, sessionId, pinned)
        if (error === undefined) await refresh(launchUrl)
        return error
      },
      forkSession: async (launchUrl: string, sessionId: string) => {
        const forked = await raw.forkSession(launchUrl, sessionId)
        if (forked.error === undefined) await refresh(launchUrl)
        return forked
      },
    }
  }, [t, pull])

  const view = useMemo(() => {
    const selfRoll: HostRoll = selfRead.ok
      ? {
          hostId: 'local', hostTitle: t('panel.tree.selfHost'), lastSeen: Date.now(), self: true,
          sessions: selfRead.sessions as readonly HostSession[],
          projects: groupByProject(selfRead.sessions as readonly HostSession[]),
          ...(selfRead.sessions.length === 0 ? { note: t('panel.tree.noSessions') } : {}),
        }
      : {
          hostId: 'local', hostTitle: t('panel.tree.selfHost'), lastSeen: 0, self: true,
          sessions: [], projects: [], note: selfRead.note,
        }
    const rollUp: RollUp = { hosts: [selfRoll] }
    return rollUpViewWithRegistry(rollUp, registrations, store.snapshotWithNotes())
  }, [selfRead, registrations, store, t])

  return createElement(HostSessionTree, {
    view,
    ctx,
    currentSessionId: currentId,
    t,
    launchUrls,
    remoteActions,
    onLeaveRemote: () => {
      conversation.close()
      showNativeConversation(ctx)
    },
    onOpenRemote: target => {
      conversation.open(target)
      return showRemoteSessionPanel(ctx)
    },
  })
}
