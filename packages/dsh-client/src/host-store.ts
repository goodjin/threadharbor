/**
 * The storage that follows the machine, not the browser.
 *
 * The host registry and this machine's default identity used to live in
 * `window.localStorage`: one browser context later they were gone. This module
 * is the replacement the design settled on
 * (docs/design/dsh-multi-host-migration.md, the persistence note near line
 * 343): when the page is served by the machine in front of the user
 * (`isLoopback`), settings persist **on that machine** through DSH's settings
 * channel; when it is served by some other machine, they stay in this page's
 * memory only — writing them to the serving machine would store the user's
 * list on the wrong computer.
 *
 * The face is deliberately the same two-method Web Storage shape the registry
 * and the identity settings already speak, so both swap to it together — the
 * two were stored separately before, and separately is how one of them gets
 * left behind next time.
 *
 * Honesty rules, in code:
 * - `posture()` is the single place the panel reads to say where data lives,
 *   including "it could not be saved" — a silent fallback is the failure mode
 *   this project keeps getting burned by.
 * - A write that cannot reach the machine keeps its value in the page and is
 *   retried on the next write; the page never pretends it saved.
 * - A write that lands before the first read completes is merged with what
 *   the machine returns (registry entries union by hostId; everything else,
 *   the page's newer intent wins), never clobbered by it.
 */

import { fallbackT } from './locales.ts'
import type { RuntimeT } from './locales.ts'

/** One per-key change to push to the machine. */
export type StoreOp =
  | { readonly kind: 'set'; readonly key: string; readonly value: string }
  | { readonly kind: 'unset'; readonly key: string }

/** The narrow face of `ctx.remote.settings` this storage needs. */
export type HostStoreChannel = {
  /** The stored document, or undefined when the namespace does not exist. */
  loadDocument(): Promise<Record<string, string> | undefined>
  /** Apply per-key operations; sets and unsets touch only their own key. */
  mutateDocument(ops: readonly StoreOp[]): Promise<void>
}

/** Where the data stands right now — the panel renders this as-is. */
export type HostStorePosture =
  | { readonly kind: 'loading' }
  | { readonly kind: 'host' }
  | { readonly kind: 'memory'; readonly reason: 'remote-page' | 'no-channel' }
  | { readonly kind: 'degraded'; readonly detail: string }

/** What the panel and the wiring read. */
export type HostStorePort = {
  /** Web Storage face for the registry and the identity default layer. */
  storage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
  }
  posture(): HostStorePosture
  /** Fires when hydration, refresh, or a posture change lands. */
  subscribe(listener: () => void): () => void
  /** Re-read the machine's document; an invalidation from another tab calls this. */
  refresh(): void
  /** Resolves once the first hydration attempt has settled, either way. */
  settled(): Promise<void>
}

/** A stored value whose entries carry a stable id, merged by union on load. */
export type ListKeyDescriptor = {
  readonly key: string
  idOf(entry: unknown): string | undefined
}

export type HostStoreDeps = {
  /** Whether the page is served by the machine in front of the user. */
  loopback(): boolean
  /** The settings channel; undefined means this host offers none at all. */
  channel: HostStoreChannel | undefined
  /** Stored values that merge by entry id instead of whole-value precedence. */
  listKeys?: readonly ListKeyDescriptor[]
  /**
   * Where the data used to live (localStorage), read once for migration.
   * Keys below that the machine's document lacks are carried over — a user's
   * registered hosts must not vanish because the storage moved.
   */
  migrateFrom?: { getItem(key: string): string | null }
  migrateKeys?: readonly string[]
  /** Where failures are said out loud. */
  log(message: string): void
}

/**
 * Start the machine-backed storage.
 * @param deps - the page-supplied ports; see {@link HostStoreDeps}.
 * @param t - reads the degraded details in the active language; absent
 * (tests, no locale service) it falls back to the dictionary's source text.
 * The details land in the `degraded` posture the panel renders as-is.
 * @returns the port the panel and the wiring read.
 */
export function startHostStore(deps: HostStoreDeps, t: RuntimeT = fallbackT): HostStorePort {
  const listeners = new Set<() => void>()
  let posture: HostStorePosture = { kind: 'loading' }
  const mirror = new Map<string, string>()
  /** The machine's document as of the last successful read. */
  let doc: Record<string, string> = {}
  /** Keys this page changed and may be ahead of the machine's document on. */
  const dirty = new Set<string>()
  /**
   * Whether the first read has settled. Before it has, writes only mark keys
   * dirty: a flush racing the first read would interleave two writers on the
   * document, and whichever continuation won the microtask race decided
   * whether the machine's existing entries survived. Held writes merge at the
   * read (by entry id for list keys) and flush once, after it.
   */
  let ready = false
  let flushing = false
  const listDescriptors = new Map<string, ListKeyDescriptor>((deps.listKeys ?? []).map(descriptor => [descriptor.key, descriptor]))

  const isHostMode = (): boolean => deps.loopback() && deps.channel !== undefined

  const setPosture = (next: HostStorePosture): void => {
    const changed = JSON.stringify(posture) !== JSON.stringify(next)
    posture = next
    if (changed) notify()
  }

  function notify(): void {
    for (const listener of [...listeners]) listener()
  }

  let settleFirstRead: () => void = () => {}
  const firstRead = new Promise<void>(resolve => { settleFirstRead = resolve })

  if (!isHostMode()) {
    const reason = deps.loopback() ? 'no-channel' : 'remote-page'
    // Said here AND in the posture: a list that quietly stops surviving
    // browsers is exactly the silent downgrade this panel must never do.
    deps.log(reason === 'remote-page'
      ? 'host store: page served by a remote machine; the registry and default identity stay in this page only and are lost when it closes'
      : 'host store: this host offers no settings channel; the registry and default identity stay in this page only and are lost when it closes')
    setPosture({ kind: 'memory', reason })
    markReady()
    settleFirstRead()
  } else {
    void hydrate(true)
  }

  /** Read the machine's document, merge it under the page's touched keys, flush. */
  async function hydrate(initial: boolean): Promise<void> {
    try {
      const loaded = await deps.channel?.loadDocument()
      deps.log(`[vtrace] hydrate loaded=${JSON.stringify(loaded)}`)
      // The read has landed: held writes may merge against it and flush from
      // here on, whatever the rest of this function goes on to do.
      if (initial) markReady()
      if (loaded === undefined) {
        // The channel answers but our namespace is not in it: the composition
        // row is missing on this host, so writes cannot land either.
        doc = {}
        mergeUnderTouched()
        setPosture({ kind: 'degraded', detail: t('panel.posture.degradedNoNamespace') })
      } else {
        doc = { ...loaded }
        mergeUnderTouched()
        await carryLegacyIntoMirror()
        await flushDirty()
      }
    } catch (error) {
      if (initial) markReady()
      setPosture({ kind: 'degraded', detail: t('panel.posture.degradedReadFailed', { message: messageOf(error) }) })
      deps.log(`host store: hydrate failed: ${messageOf(error)}`)
    }
    notify()
    // Settled means the first read AND the merge/flush it drove are done —
    // the wiring re-reads identity on this, so it must not fire early.
    if (initial) settleFirstRead()
  }

  /**
   * Fold the machine's document into the mirror without overwriting what this
   * page changed before the read came back. A key this page removed without
   * ever having read it (a pre-read remove of a value only the machine had)
   * is restored: removing what you have not seen says nothing.
   */
  function mergeUnderTouched(): void {
    for (const [key, value] of Object.entries(doc)) {
      if (dirty.has(key)) continue
      mirror.set(key, value)
    }
    for (const key of [...dirty]) {
      const local = mirror.get(key)
      if (local === undefined) {
        // Removed (or written-before-read-then-removed) without a local value:
        // the machine's value stands back up, and the key stops counting as
        // dirty so no flush can unset something this page never saw.
        const remote = doc[key]
        if (remote !== undefined) {
          mirror.set(key, remote)
          dirty.delete(key)
        }
        continue
      }
      const descriptor = listDescriptors.get(key)
      const remote = doc[key]
      if (descriptor === undefined || remote === undefined) continue
      mirror.set(key, unionById(local, remote, descriptor))
    }
    // Keys the machine no longer has, and this page never touched, leave too.
    for (const key of [...mirror.keys()]) {
      if (doc[key] === undefined && !dirty.has(key)) mirror.delete(key)
    }
  }

  /** One-time migration: keys the browser used to own, if the machine lacks them. */
  async function carryLegacyIntoMirror(): Promise<void> {
    const source = deps.migrateFrom
    const keys = deps.migrateKeys ?? []
    if (source === undefined) return
    for (const key of keys) {
      if (doc[key] !== undefined || dirty.has(key)) continue
      const legacy = source.getItem(key)
      if (legacy === null) continue
      mirror.set(key, legacy)
      dirty.add(key)
      deps.log(`host store: migrated ${key} from browser storage into this machine's settings document`)
    }
  }

  /** Push every touched key that differs from the machine's document. */
  async function flushDirty(): Promise<void> {
    if (flushing || !ready || !isHostMode()) return
    if (dirty.size > 0) deps.log(`[vtrace] flush start dirty=${JSON.stringify([...dirty])} doc=${JSON.stringify(doc)}`)
    const ops: StoreOp[] = []
    for (const key of dirty) {
      const local = mirror.get(key)
      if (local === undefined) {
        if (doc[key] !== undefined) ops.push({ kind: 'unset', key })
        else dirty.delete(key)
      } else if (doc[key] !== local) {
        ops.push({ kind: 'set', key, value: local })
      } else {
        // Already identical on the machine: nothing owed for this key.
        dirty.delete(key)
      }
    }
    deps.log(`[vtrace] flush ops=${JSON.stringify(ops)} dirtyLeft=${JSON.stringify([...dirty])}`)
    if (ops.length === 0) {
      // Nothing owed to the machine — which, right after hydration, is the
      // normal case: the read itself is what proves host storage works.
      if (posture.kind !== 'host') setPosture({ kind: 'host' })
      return
    }
    flushing = true
    let saved = false
    try {
      await deps.channel?.mutateDocument(ops)
      for (const op of ops) {
        if (op.kind === 'set') doc[op.key] = op.value
        else delete doc[op.key]
        // Only clear the dirty mark when the mirror still holds exactly what
        // this flush saved: a write that landed while the flush was in flight
        // (the rename's remove→add in one tick) re-marked the key, and this
        // loop must not sign its newer value off as saved. The kept mark is
        // what the coalesce below — or the next write — pushes.
        if (mirror.get(op.key) === (op.kind === 'set' ? op.value : undefined)) dirty.delete(op.key)
      }
      setPosture({ kind: 'host' })
      saved = true
    } catch (error) {
      // The page keeps its value and stays honest about the machine: the next
      // write (or refresh) retries everything still marked dirty. A failed
      // flush does NOT re-arm here on its own: an automatic retry would hide
      // the failure and hammer a host that cannot answer.
      setPosture({ kind: 'degraded', detail: t('panel.posture.degradedWriteFailed', { message: messageOf(error) }) })
      deps.log(`host store: flush failed: ${messageOf(error)}`)
    } finally {
      flushing = false
    }
    // Coalesce writes that landed while this flush ran — only after a save,
    // and only once the re-entrancy guard above is down again.
    if (saved && dirty.size > 0) void flushDirty()
  }

  /** Open the internal gate: held writes may merge and flush from here on. */
  function markReady(): void {
    ready = true
  }

  return {
    storage: {
      getItem: key => mirror.get(key) ?? null,
      setItem: (key, value) => {
        mirror.set(key, value)
        if (!isHostMode()) return
        dirty.add(key)
        // Before the first read lands this only marks the key dirty; the
        // merge at the read decides what the machine ends up with.
        if (ready) void flushDirty()
      },
      removeItem: key => {
        if (!mirror.has(key)) return
        mirror.delete(key)
        if (!isHostMode()) return
        dirty.add(key)
        if (ready) void flushDirty()
      },
    },
    posture: () => posture,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: () => {
      if (isHostMode() && ready) void hydrate(false)
    },
    settled: () => firstRead,
  }
}

/**
 * Union two stored JSON lists by entry id: the machine's entries that this
 * page has not produced come first, the page's own (including same-id
 * replacements) after. Either side failing to parse means the page's raw
 * value wins — a value this page just wrote is never lost to a merge guess.
 */
function unionById(local: string, remote: string, descriptor: ListKeyDescriptor): string {
  const localParsed = parseEntries(local)
  const remoteParsed = parseEntries(remote)
  if (localParsed === undefined || remoteParsed === undefined) return local
  const localIds = new Set(localParsed.map(entry => descriptor.idOf(entry)).filter(id => id !== undefined))
  const carried = remoteParsed.filter(entry => {
    const id = descriptor.idOf(entry)
    return id === undefined || !localIds.has(id)
  })
  return JSON.stringify([...carried, ...localParsed])
}

function parseEntries(value: string): readonly unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
