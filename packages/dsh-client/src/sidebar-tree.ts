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
import { rollUpViewWithRegistry, groupByProject } from './host-roll-up.ts'
import { createRemoteSessionStore } from './remote-session-store.ts'
import { buildHostSessions, readSessionSources } from './session-source.ts'
import type { SessionRead } from './session-source.ts'
import { fetchHostSessions } from './remote-session-poll.ts'
import type { HostSessionsResult } from './remote-session-poll.ts'
import type { RuntimeT } from './locales.ts'
import { fallbackT } from './locales.ts'

/** The kill switch: `off` restores DSH's native workspace list. */
export const TREE_STORAGE_KEY = 'threadharbor.sidebarTree'

/** The panel a host row deep-links into (stage L's bridge to its detail page). */
const PANEL_ID = 'threadharbor-rollup'
export const FOCUS_HOST_EVENT = 'threadharbor:focus-host'

/** The slot face the client entry hands in; tests build a recording fake. */
export type TreeSlotHost = {
  inject(slot: string, callback: () => unknown): unknown
  // The real register takes the full options table (children/locale/store/…);
  // this module only ever passes name+priority, and the return is a dispose.
  register(options: { name: string; priority?: number }, component: unknown): () => void
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
    { name: 'sidebar.workspaces', priority: -10 },
    (props: { readonly t?: RuntimeT; readonly selectPanel?: (id: string) => void }) =>
      createElement(ShadowTreeHost, {
        ctx,
        registry: bound,
        ...(props.t === undefined ? {} : { t: props.t }),
        ...(props.selectPanel === undefined ? {} : { selectPanel: props.selectPanel }),
      }),
  ))
}

const LOCAL_POLL_MS = 30_000
const REMOTE_POLL_MS = 60_000

type ShadowProps = {
  readonly ctx: ServicesCtx
  readonly registry: RegistryLike
  readonly t?: RuntimeT
  /** From the sidebar parent's inject; absent in tests and in-panel mounts. */
  readonly selectPanel?: (id: string) => void
  /** Test seam: one remote fetch. Production default hits the host-side route. */
  readonly fetchNow?: (launchUrl: string) => Promise<HostSessionsResult>
  readonly pollMs?: number
}

export function ShadowTreeHost({ ctx, registry, t = fallbackT, selectPanel, fetchNow, pollMs }: ShadowProps) {
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
    refreshRegistrations()
  }, [ctx, refreshRegistrations])

  const pull = useCallback(async (launchUrl: string, hostId: string) => {
    const attempt = fetchNow ?? ((url: string) => fetchHostSessions(url, t))
    const result = await attempt(launchUrl)
    if ('sessions' in result) store.set(hostId, result.sessions)
    else store.set(hostId, [], result.failed)
    refreshRegistrations()
  }, [fetchNow, store, t, refreshRegistrations])

  useEffect(() => {
    readLocal()
    const localTimer = window.setInterval(readLocal, pollMs ?? LOCAL_POLL_MS)
    return () => { window.clearInterval(localTimer) }
  }, [readLocal, pollMs])

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

  const onOpenHostPage = useCallback((hostId: string) => {
    selectPanel?.(PANEL_ID)
    window.dispatchEvent(new CustomEvent(FOCUS_HOST_EVENT, { detail: { hostId } }))
  }, [selectPanel])

  return createElement(HostSessionTree, { view, ctx, onOpenHostPage, t })
}
