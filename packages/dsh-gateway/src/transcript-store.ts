/**
 * Gateway-owned transcript persistence.
 *
 * The DSH storage domain publishes every record write by rewriting its whole
 * JSON unit (serialize + fsync + rename). That is fine for the small catalog
 * tables, but the projected transcript grows to tens of thousands of rows and
 * a single journal page appends a dozen of them — each append was rewriting a
 * 100 MB file, which is where multi-second projection lag came from.
 *
 * This store keeps the transcript in memory and persists it as one
 * append-only JSONL file per session: an append is one `appendFile`, a
 * rotation drop is a tombstone line, and a session file is compacted
 * (rewritten from memory) only when tombstones pile up. Without a directory
 * the store is memory-only (tests).
 */

import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoteSessionId, RemoteTranscriptEntry, RemoteTranscriptId } from '@threadharbor/protocol'

type SessionId = ReturnType<typeof RemoteSessionId>
type TranscriptId = ReturnType<typeof RemoteTranscriptId>

/** Only file-name-safe session ids are persisted; ids are UUIDs in practice. */
const SESSION_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
const FILE_SUFFIX = '.jsonl'
const LEGACY_IMPORT_MARKER = 'legacy-domain-imported'

export interface TranscriptStoreOptions {
  /** Per-session file directory; omit for a memory-only store. */
  readonly directory?: string
  /** Tombstones tolerated in one session file before it is compacted. */
  readonly compactAfterTombstones?: number
}

interface SessionBucket {
  readonly entries: Map<TranscriptId, RemoteTranscriptEntry>
  sorted: readonly RemoteTranscriptEntry[] | undefined
  tombstones: number
}

function isTranscriptEntry(value: unknown): value is RemoteTranscriptEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['transcriptId'] === 'string'
    && typeof record['sessionId'] === 'string'
    && typeof record['seq'] === 'number'
    && typeof record['role'] === 'string'
    && typeof record['kind'] === 'string'
    && typeof record['text'] === 'string'
}

function bySeq(left: RemoteTranscriptEntry, right: RemoteTranscriptEntry): number {
  return left.seq - right.seq
}

export class TranscriptStore {
  private readonly byId = new Map<TranscriptId, RemoteTranscriptEntry>()
  private readonly sessions = new Map<SessionId, SessionBucket>()
  /** Per-session write chain so appends, tombstones and compactions stay ordered. */
  private readonly chains = new Map<SessionId, Promise<void>>()
  private readonly directory: string | undefined
  private readonly compactAfterTombstones: number
  private opened = false

  constructor(options: TranscriptStoreOptions = {}) {
    this.directory = options.directory
    this.compactAfterTombstones = options.compactAfterTombstones ?? 256
  }

  /** Load every session file into memory (no-op for a memory-only store). */
  async open(): Promise<void> {
    if (this.opened) return
    this.opened = true
    if (this.directory === undefined) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const names = await readdir(this.directory)
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue
      const sessionId = name.slice(0, -FILE_SUFFIX.length) as SessionId
      let text: string
      try {
        text = await readFile(join(this.directory, name), 'utf8')
      } catch (error) {
        process.stderr.write(`threadharbor-gateway: transcript file unreadable ${name}: ${String(error)}\n`)
        continue
      }
      const bucket = this.bucket(sessionId)
      let malformed = 0
      for (const line of text.split('\n')) {
        if (line === '') continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { malformed += 1; continue }
        if (parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['del'] === 'string') {
          const id = (parsed as Record<string, unknown>)['del'] as TranscriptId
          if (bucket.entries.delete(id)) this.byId.delete(id)
          bucket.tombstones += 1
          continue
        }
        if (!isTranscriptEntry(parsed) || parsed.sessionId !== sessionId) { malformed += 1; continue }
        bucket.entries.set(parsed.transcriptId, parsed)
        this.byId.set(parsed.transcriptId, parsed)
      }
      bucket.sorted = undefined
      if (malformed > 0) {
        process.stderr.write(`threadharbor-gateway: transcript file ${name} skipped ${malformed} malformed line(s)\n`)
      }
      if (bucket.entries.size === 0) this.sessions.delete(sessionId)
    }
  }

  /** Whether the one-time import from the legacy storage-domain table still has to run. */
  async needsLegacyImport(): Promise<boolean> {
    if (this.directory === undefined) return false
    try {
      await readFile(join(this.directory, LEGACY_IMPORT_MARKER))
      return false
    } catch {
      return true
    }
  }

  /**
   * Import rows that used to live in the storage domain's `transcript` table.
   * Existing ids win; touched session files are rewritten from memory.
   */
  async importLegacy(entries: Iterable<RemoteTranscriptEntry>): Promise<number> {
    const touched = new Set<SessionId>()
    let imported = 0
    for (const entry of entries) {
      if (this.byId.has(entry.transcriptId)) continue
      this.set(entry)
      touched.add(entry.sessionId)
      imported += 1
    }
    for (const sessionId of touched) await this.enqueue(sessionId, () => this.rewrite(sessionId))
    if (this.directory !== undefined) {
      await writeFile(join(this.directory, LEGACY_IMPORT_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 })
    }
    return imported
  }

  get(id: TranscriptId): RemoteTranscriptEntry | undefined {
    return this.byId.get(id)
  }

  get size(): number {
    return this.byId.size
  }

  /** Entries of one session ordered by seq (cached until the session changes). */
  session(sessionId: SessionId): readonly RemoteTranscriptEntry[] {
    const bucket = this.sessions.get(sessionId)
    if (bucket === undefined) return []
    if (bucket.sorted === undefined) bucket.sorted = [...bucket.entries.values()].sort(bySeq)
    return bucket.sorted
  }

  /**
   * Append entries to a session, then rotate out the lowest-seq rows beyond
   * `maxEntries`. Returns the rotated rows in ascending seq order.
   */
  async append(
    sessionId: SessionId,
    entries: readonly RemoteTranscriptEntry[],
    maxEntries: number,
  ): Promise<readonly RemoteTranscriptEntry[]> {
    if (entries.length === 0) return []
    for (const entry of entries) this.set(entry)
    const bucket = this.bucket(sessionId)
    const excess = bucket.entries.size > maxEntries
      ? this.session(sessionId).slice(0, bucket.entries.size - maxEntries)
      : []
    for (const entry of excess) this.remove(entry.transcriptId)
    bucket.tombstones += excess.length
    const lines = entries.map(entry => `${JSON.stringify(entry)}\n`).join('')
      + excess.map(entry => `${JSON.stringify({ del: entry.transcriptId })}\n`).join('')
    await this.enqueue(sessionId, async () => {
      if (bucket.tombstones > this.compactAfterTombstones) {
        await this.rewrite(sessionId)
        return
      }
      const path = this.pathFor(sessionId)
      if (path === undefined) return
      await appendFile(path, lines, { mode: 0o600 })
    })
    return excess
  }

  /** Drop every entry of a session and its file. */
  async deleteSession(sessionId: SessionId): Promise<void> {
    const bucket = this.sessions.get(sessionId)
    if (bucket !== undefined) {
      for (const id of bucket.entries.keys()) this.byId.delete(id)
      this.sessions.delete(sessionId)
    }
    await this.enqueue(sessionId, async () => {
      const path = this.pathFor(sessionId)
      if (path !== undefined) await rm(path, { force: true })
    })
  }

  /** Wait for every pending file write (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()])
  }

  private set(entry: RemoteTranscriptEntry): void {
    this.byId.set(entry.transcriptId, entry)
    const bucket = this.bucket(entry.sessionId)
    bucket.entries.set(entry.transcriptId, entry)
    bucket.sorted = undefined
  }

  private remove(id: TranscriptId): void {
    const entry = this.byId.get(id)
    if (entry === undefined) return
    this.byId.delete(id)
    const bucket = this.sessions.get(entry.sessionId)
    if (bucket === undefined) return
    bucket.entries.delete(id)
    bucket.sorted = undefined
  }

  private bucket(sessionId: SessionId): SessionBucket {
    let bucket = this.sessions.get(sessionId)
    if (bucket === undefined) {
      bucket = { entries: new Map(), sorted: undefined, tombstones: 0 }
      this.sessions.set(sessionId, bucket)
    }
    return bucket
  }

  private pathFor(sessionId: SessionId): string | undefined {
    if (this.directory === undefined) return undefined
    if (!SESSION_FILE_RE.test(sessionId)) {
      process.stderr.write(`threadharbor-gateway: transcript for session ${sessionId} kept in memory only (unsafe id)\n`)
      return undefined
    }
    return join(this.directory, `${sessionId}${FILE_SUFFIX}`)
  }

  /** Rewrite one session file from memory (atomic tmp + rename), clearing its tombstones. */
  private async rewrite(sessionId: SessionId): Promise<void> {
    const path = this.pathFor(sessionId)
    const bucket = this.sessions.get(sessionId)
    if (bucket !== undefined) bucket.tombstones = 0
    if (path === undefined) return
    const entries = bucket === undefined ? [] : this.session(sessionId)
    if (entries.length === 0) {
      await rm(path, { force: true })
      return
    }
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
    await rename(tmp, path)
  }

  private enqueue(sessionId: SessionId, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task).catch((error: unknown) => {
      process.stderr.write(`threadharbor-gateway: transcript write failed session=${sessionId}: ${String(error)}\n`)
    })
    this.chains.set(sessionId, current)
    void current.finally(() => {
      if (this.chains.get(sessionId) === current) this.chains.delete(sessionId)
    })
    return current
  }
}
