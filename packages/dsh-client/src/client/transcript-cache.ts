/** Browser-local transcript cache. Persistent across refreshes so a stale
 *  page reload can still render recent conversation content while the
 *  `transcript.read` round-trip is in flight, and so a transient gateway
 *  outage does not leave the user staring at an empty thread.
 *
 *  Design contract (feasibility validation, not production wiring):
 *  - Storage is pluggable (`openDb`) so tests can supply an in-memory shim
 *    without pulling in `fake-indexeddb`. The default `openIndexedDb` opens
 *    a real IndexedDB database and is the only piece that needs a browser.
 *  - Per-session ring cap: a single session keeps at most
 *    `maxEntriesPerSession` entries (default 10 000, matching the gateway
 *    cap so the cache can never outgrow the source of truth). Trim drops
 *    the lowest-`seq` entries and rewrites `lastSeq`.
 *  - Total byte cap: across every session, the cache may not exceed
 *    `maxBytesTotal` (default 50 MB). When the cap is breached, the
 *    least-recently-updated session is evicted until the cap fits. The
 *    accounting is best-effort: `bytes` is the JSON length of the record
 *    because that is what the browser actually has to serialise.
 *  - Writes are debounced per session (`debounceMs`, default 200 ms). A
 *    burst of `putEntries` calls for the same session lands as one IDB
 *    transaction; cross-session writes still happen independently.
 *  - Quota errors are not fatal: a write that the storage layer rejects
 *    is reported through the `quota-error` channel and the cache stays
 *    usable (the in-memory shadow still reflects what was asked).
 *  - No React. No DOM. Pure data layer the store can drive.
 */

import type { RemoteSessionId, RemoteTranscriptEntry } from '@threadharbor/protocol'

/** One durable row kept in the underlying object store. */
export interface CachedTranscriptSession {
  readonly sessionId: ReturnType<typeof RemoteSessionId>
  readonly entries: readonly RemoteTranscriptEntry[]
  readonly lastSeq: number
  updatedAt: number
  /** Pre-computed JSON length; the cache trims by this field to keep
   *  the accounting math off the hot path. */
  bytes: number
}

/** Minimal storage interface the cache drives. Production code uses
 *  `openIndexedDb`; tests substitute an in-memory implementation. */
export interface TranscriptDb {
  get(sessionId: ReturnType<typeof RemoteSessionId>): Promise<CachedTranscriptSession | undefined>
  put(record: CachedTranscriptSession): Promise<void>
  delete(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void>
  list(): Promise<readonly CachedTranscriptSession[]>
  close(): void
}

/** Events the cache surfaces to its subscribers. The union is open so a
 *  future `version-mismatch` or `corruption` channel can plug in without
 *  breaking existing listeners. */
export type TranscriptCacheEvent =
  | { readonly type: 'quota-error'; readonly sessionId: ReturnType<typeof RemoteSessionId>; readonly error: unknown }
  | { readonly type: 'evicted'; readonly sessionId: ReturnType<typeof RemoteSessionId>; readonly reason: 'ring-trim' | 'lru-cap' }
  | { readonly type: 'persisted'; readonly sessionId: ReturnType<typeof RemoteSessionId>; readonly entryCount: number }

export interface TranscriptCacheOptions {
  /** Override the storage factory. Defaults to `openIndexedDb` in browsers. */
  readonly openDb?: () => Promise<TranscriptDb>
  /** Hard cap on entries kept per session. Defaults to 10 000. */
  readonly maxEntriesPerSession?: number
  /** Hard cap on total cached bytes. Defaults to 50 MiB. */
  readonly maxBytesTotal?: number
  /** Coalesce burst writes inside this window. Defaults to 200 ms. */
  readonly debounceMs?: number
  /** Clock for tests; defaults to `Date.now`. */
  readonly now?: () => number
  /** Timer factory for tests; defaults to `setTimeout` / `clearTimeout`. */
  readonly scheduler?: {
    readonly setTimeout: (callback: () => void, delay: number) => unknown
    readonly clearTimeout: (handle: unknown) => void
  }
}

const DEFAULT_MAX_ENTRIES_PER_SESSION = 10_000
const DEFAULT_MAX_BYTES_TOTAL = 50 * 1024 * 1024
const DEFAULT_DEBOUNCE_MS = 200
const INDEXED_DB_NAME = 'threadharbor'
const INDEXED_DB_VERSION = 1
const INDEXED_DB_STORE = 'transcript-sessions'

/** A subscriber handle that detaches on invocation. */
export type Unsubscribe = () => void

/** Default IndexedDB factory. Kept out of the constructor so SSR / Node
 *  environments can still import the module without crashing. */
export function openIndexedDb(): Promise<TranscriptDb> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment'))
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION)
    request.addEventListener('upgradeneeded', () => {
      const db = request.result
      if (!db.objectStoreNames.contains(INDEXED_DB_STORE)) {
        db.createObjectStore(INDEXED_DB_STORE, { keyPath: 'sessionId' })
      }
    })
    request.addEventListener('success', () => {
      const db = request.result
      resolve({
        get(sessionId) {
          return new Promise((res, rej) => {
            const tx = db.transaction(INDEXED_DB_STORE, 'readonly')
            const req = tx.objectStore(INDEXED_DB_STORE).get(sessionId)
            req.addEventListener('success', () => { res(req.result as CachedTranscriptSession | undefined) })
            req.addEventListener('error', () => { rej(req.error ?? new Error('IndexedDB get failed')) })
          })
        },
        put(record) {
          return new Promise((res, rej) => {
            const tx = db.transaction(INDEXED_DB_STORE, 'readwrite')
            tx.objectStore(INDEXED_DB_STORE).put(record)
            tx.addEventListener('complete', () => { res() })
            tx.addEventListener('error', () => { rej(tx.error ?? new Error('IndexedDB put failed')) })
            tx.addEventListener('abort', () => { rej(tx.error ?? new Error('IndexedDB put aborted')) })
          })
        },
        delete(sessionId) {
          return new Promise((res, rej) => {
            const tx = db.transaction(INDEXED_DB_STORE, 'readwrite')
            tx.objectStore(INDEXED_DB_STORE).delete(sessionId)
            tx.addEventListener('complete', () => { res() })
            tx.addEventListener('error', () => { rej(tx.error ?? new Error('IndexedDB delete failed')) })
            tx.addEventListener('abort', () => { rej(tx.error ?? new Error('IndexedDB delete aborted')) })
          })
        },
        list() {
          return new Promise((res, rej) => {
            const tx = db.transaction(INDEXED_DB_STORE, 'readonly')
            const req = tx.objectStore(INDEXED_DB_STORE).getAll()
            req.addEventListener('success', () => { res((req.result ?? []) as CachedTranscriptSession[]) })
            req.addEventListener('error', () => { rej(req.error ?? new Error('IndexedDB list failed')) })
          })
        },
        close() {
          db.close()
        },
      })
    })
    request.addEventListener('error', () => { reject(request.error ?? new Error('IndexedDB open failed')) })
    request.addEventListener('blocked', () => { reject(new Error('IndexedDB open blocked by stale connection')) })
  })
}

/** Estimate the JSON footprint of one cache row. Cheap, deterministic,
 *  and good enough for the LRU accounting. The `bytes` field itself is
 *  recomputed when the entry is trimmed so the value always matches what
 *  IndexedDB will store on the next `put`. */
function measureRecord(record: Pick<CachedTranscriptSession, 'entries'>): number {
  return JSON.stringify(record.entries).length
}

/** Apply the per-session ring trim. Keeps the highest-`seq` slice and
 *  returns the updated entries plus the new `lastSeq`. Pure function so
 *  the storage layer does not need to know about caps. */
function applyRingTrim(
  entries: readonly RemoteTranscriptEntry[],
  maxEntries: number,
): { readonly entries: RemoteTranscriptEntry[]; readonly lastSeq: number } {
  if (entries.length <= maxEntries) {
    const lastSeq = entries.reduce((max, candidate) => candidate.seq > max ? candidate.seq : max, -1)
    return { entries: [...entries], lastSeq }
  }
  const sorted = entries.slice().sort((left, right) => left.seq - right.seq)
  const kept = sorted.slice(sorted.length - maxEntries)
  return { entries: kept, lastSeq: kept[kept.length - 1]?.seq ?? -1 }
}

/** Pick the session that should be evicted next: lowest `updatedAt`.
 *  Returns `undefined` when the cache is empty. */
function pickEvictionTarget(
  index: ReadonlyMap<ReturnType<typeof RemoteSessionId>, { readonly bytes: number; readonly updatedAt: number }>,
): ReturnType<typeof RemoteSessionId> | undefined {
  let oldest: ReturnType<typeof RemoteSessionId> | undefined
  let oldestAt = Number.POSITIVE_INFINITY
  for (const [sessionId, meta] of index) {
    if (meta.updatedAt < oldestAt) {
      oldestAt = meta.updatedAt
      oldest = sessionId
    }
  }
  return oldest
}

export class TranscriptCache {
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly scheduler: TranscriptCacheOptions['scheduler']
  private readonly dbPromise: Promise<TranscriptDb>
  /** In-memory shadow of every cached session. IndexedDB is the source of
   *  truth at restart; the shadow lets the LRU/ring logic stay synchronous
   *  and lets a `getEntries` call answer before the DB has returned. */
  private readonly records = new Map<ReturnType<typeof RemoteSessionId>, CachedTranscriptSession>()
  private readonly pendingWrites = new Map<ReturnType<typeof RemoteSessionId>, { readonly timer: unknown; readonly next: CachedTranscriptSession }>()
  private readonly listeners = new Set<(event: TranscriptCacheEvent) => void>()
  private totalBytes = 0
  private indexReady: Promise<void> | undefined
  private disposed = false

  constructor(options: TranscriptCacheOptions = {}) {
    this.maxEntries = options.maxEntriesPerSession ?? DEFAULT_MAX_ENTRIES_PER_SESSION
    this.maxBytes = options.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.now = options.now ?? Date.now
    this.scheduler = options.scheduler
    this.dbPromise = options.openDb ? options.openDb() : openIndexedDb()
  }

  /** Read the full entry list for one session. Returns `undefined` when the
   *  cache has never seen this session — callers must fall back to the
   *  gateway in that case. */
  async getEntries(sessionId: ReturnType<typeof RemoteSessionId>): Promise<readonly RemoteTranscriptEntry[] | undefined> {
    await this.ensureIndex()
    return this.records.get(sessionId)?.entries
  }

  /** Highest `seq` the cache holds for a session. `-1` means "no entries". */
  async getLatestSeq(sessionId: ReturnType<typeof RemoteSessionId>): Promise<number> {
    await this.ensureIndex()
    return this.records.get(sessionId)?.lastSeq ?? -1
  }

  /** Merge a batch of entries into one session. Entries are deduplicated by
   *  `transcriptId` (later wins) and sorted by `seq`. A debounce window
   *  collapses bursts; the storage write is asynchronous and never awaited
   *  by callers. */
  putEntries(sessionId: ReturnType<typeof RemoteSessionId>, entries: readonly RemoteTranscriptEntry[]): void {
    if (this.disposed || entries.length === 0) return
    this.ensureIndexSync(sessionId)
    const existing = this.records.get(sessionId)
    const merged = mergeEntries(existing?.entries ?? [], entries)
    const trimmed = applyRingTrim(merged, this.maxEntries)
    const updatedAt = this.now()
    const next: CachedTranscriptSession = {
      sessionId,
      entries: trimmed.entries,
      lastSeq: trimmed.lastSeq,
      updatedAt,
      bytes: measureRecord({ entries: trimmed.entries }),
    }
    const previousBytes = existing?.bytes ?? 0
    // Emit on actual loss: `trimmed` is shorter than the merged input.
    if (trimmed.entries.length < merged.length) {
      this.emit({ type: 'evicted', sessionId, reason: 'ring-trim' })
    }
    this.totalBytes += next.bytes - previousBytes
    this.records.set(sessionId, next)
    this.enforceLru(sessionId)
    this.scheduleWrite(sessionId, next)
  }

  /** Drop one session from the cache. No-op if the session is unknown. */
  async forget(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    await this.ensureIndex()
    const existing = this.records.get(sessionId)
    if (existing === undefined) return
    this.totalBytes -= existing.bytes
    this.records.delete(sessionId)
    const pending = this.pendingWrites.get(sessionId)
    if (pending !== undefined) {
      this.scheduler?.clearTimeout(pending.timer) ?? clearTimeoutIfPresent(pending.timer)
      this.pendingWrites.delete(sessionId)
    }
    try {
      const db = await this.dbPromise
      await db.delete(sessionId)
    } catch {
      // ignore — the in-memory shadow is already consistent
    }
  }

  /** Drop every cached session. Used by the "clear cache" button. */
  async clear(): Promise<void> {
    this.records.clear()
    this.totalBytes = 0
    for (const { timer } of this.pendingWrites.values()) {
      this.scheduler?.clearTimeout(timer) ?? clearTimeoutIfPresent(timer)
    }
    this.pendingWrites.clear()
    try {
      const db = await this.dbPromise
      const all = await db.list()
      await Promise.all(all.map(record => db.delete(record.sessionId)))
    } catch {
      // ignore
    }
  }

  /** Subscribe to cache events. Returns an unsubscribe handle. */
  subscribe(listener: (event: TranscriptCacheEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stop background timers and detach listeners. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const { timer } of this.pendingWrites.values()) {
      this.scheduler?.clearTimeout(timer) ?? clearTimeoutIfPresent(timer)
    }
    this.pendingWrites.clear()
    this.listeners.clear()
    this.dbPromise.then(db => { try { db.close() } catch { /* ignore */ } }).catch(() => undefined)
  }

  /** Force a flush of every pending write. Awaiting this lets tests assert
   *  that the debounce actually let the storage layer see the latest state. */
  async flush(): Promise<void> {
    await this.ensureIndex()
    const pending = [...this.pendingWrites.values()]
    await Promise.all(pending.map(item => this.commit(item.next)))
  }

  /** Lazily load the on-disk records into the in-memory shadow. */
  private ensureIndex(): Promise<void> {
    if (this.indexReady === undefined) {
      this.indexReady = this.loadIndex()
    }
    return this.indexReady
  }

  /** Best-effort fast path for the synchronous `putEntries` entry point:
   *  trigger the index load but do not block the call. */
  private ensureIndexSync(sessionId: ReturnType<typeof RemoteSessionId>): void {
    if (this.indexReady === undefined) {
      void this.ensureIndex().catch(() => undefined)
    }
    void sessionId
  }

  private async loadIndex(): Promise<void> {
    try {
      const db = await this.dbPromise
      const records = await db.list()
      let total = 0
      for (const record of records) {
        this.records.set(record.sessionId, {
          ...record,
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
          bytes: typeof record.bytes === 'number' ? record.bytes : measureRecord(record),
        })
        total += this.records.get(record.sessionId)!.bytes
      }
      this.totalBytes = total
    } catch {
      // IndexedDB unavailable; the cache keeps an empty shadow and writes
      // will surface the failure on the next `flush`.
      this.totalBytes = 0
    }
  }

  /** Schedule a debounced write for one session. The pending entry is
   *  overwritten if a newer `putEntries` lands inside the same window. */
  private scheduleWrite(sessionId: ReturnType<typeof RemoteSessionId>, next: CachedTranscriptSession): void {
    const previous = this.pendingWrites.get(sessionId)
    if (previous !== undefined) {
      this.scheduler?.clearTimeout(previous.timer) ?? clearTimeoutIfPresent(previous.timer)
    }
    const scheduler = this.scheduler
    const timer = scheduler !== undefined
      ? scheduler.setTimeout(() => { void this.commit(next) }, this.debounceMs)
      : setTimeout(() => { void this.commit(next) }, this.debounceMs)
    this.pendingWrites.set(sessionId, { timer, next })
  }

  /** Push one record to the storage layer. Surfaces quota errors through
   *  the event channel and never throws. */
  private async commit(record: CachedTranscriptSession): Promise<void> {
    this.pendingWrites.delete(record.sessionId)
    if (this.disposed) return
    try {
      const db = await this.dbPromise
      await db.put(record)
      this.emit({ type: 'persisted', sessionId: record.sessionId, entryCount: record.entries.length })
    } catch (error) {
      this.emit({ type: 'quota-error', sessionId: record.sessionId, error })
    }
  }

  /** Evict the oldest session until the total fits inside `maxBytes`. The
   *  session that just received a write is protected so a brand-new session
   *  is never dropped before its first persist. */
  private enforceLru(protectedSession: ReturnType<typeof RemoteSessionId>): void {
    const index = new Map<ReturnType<typeof RemoteSessionId>, { bytes: number; updatedAt: number }>()
    for (const [sessionId, record] of this.records) {
      index.set(sessionId, { bytes: record.bytes, updatedAt: record.updatedAt })
    }
    while (this.totalBytes > this.maxBytes) {
      const target = pickEvictionTarget(index)
      if (target === undefined) return
      if (target === protectedSession) {
        // The protected session alone exceeds the cap; trim its own entries
        // down to a single empty placeholder and bail.
        const record = this.records.get(target)
        if (record === undefined) return
        this.totalBytes -= record.bytes
        this.records.set(target, { ...record, entries: [], lastSeq: -1, bytes: measureRecord({ entries: [] }) })
        this.totalBytes += this.records.get(target)!.bytes
        this.emit({ type: 'evicted', sessionId: target, reason: 'lru-cap' })
        return
      }
      const targetRecord = this.records.get(target)
      if (targetRecord !== undefined) {
        this.totalBytes -= targetRecord.bytes
        this.records.delete(target)
        this.emit({ type: 'evicted', sessionId: target, reason: 'lru-cap' })
      }
      index.delete(target)
    }
  }

  private emit(event: TranscriptCacheEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* listener errors must not break the publish loop */ }
    }
  }
}

/** Deduplicate and sort entries by `transcriptId` (later wins) then `seq`. */
function mergeEntries(
  existing: readonly RemoteTranscriptEntry[],
  incoming: readonly RemoteTranscriptEntry[],
): RemoteTranscriptEntry[] {
  if (incoming.length === 0) return [...existing]
  const byId = new Map<string, RemoteTranscriptEntry>()
  for (const entry of existing) byId.set(entry.transcriptId, entry)
  for (const entry of incoming) byId.set(entry.transcriptId, entry)
  const merged = [...byId.values()]
  merged.sort((left, right) => left.seq - right.seq || left.transcriptId.localeCompare(right.transcriptId))
  return merged
}

function clearTimeoutIfPresent(handle: unknown): void {
  if (typeof handle === 'number' || typeof handle === 'object') {
    try { clearTimeout(handle as Parameters<typeof clearTimeout>[0]) } catch { /* ignore */ }
  }
}