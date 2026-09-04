/** Feasibility-validation tests for the browser-local transcript cache.
 *  Storage is injected so the suite runs without IndexedDB or
 *  `fake-indexeddb`. The shim mirrors the production contract 1:1. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TranscriptCache,
  type CachedTranscriptSession,
  type TranscriptDb,
  type TranscriptCacheEvent,
} from '../src/client/transcript-cache.ts'
import { RemoteSessionId, RemoteTranscriptId, type RemoteTranscriptEntry } from '@threadharbor/protocol'

class InMemoryDb implements TranscriptDb {
  private readonly records = new Map<string, CachedTranscriptSession>()
  private nextPutShouldFail: Error | undefined

  get(sessionId: ReturnType<typeof RemoteSessionId>): Promise<CachedTranscriptSession | undefined> {
    return Promise.resolve(this.records.get(sessionId))
  }

  put(record: CachedTranscriptSession): Promise<void> {
    if (this.nextPutShouldFail !== undefined) {
      const error = this.nextPutShouldFail
      this.nextPutShouldFail = undefined
      return Promise.reject(error)
    }
    this.records.set(record.sessionId, { ...record })
    return Promise.resolve()
  }

  delete(sessionId: ReturnType<typeof RemoteSessionId>): Promise<void> {
    this.records.delete(sessionId)
    return Promise.resolve()
  }

  list(): Promise<readonly CachedTranscriptSession[]> {
    return Promise.resolve([...this.records.values()].map(record => ({ ...record })))
  }

  close(): void {
    /* nothing to close */
  }

  failNextPut(error: Error): void {
    this.nextPutShouldFail = error
  }

  /** Test helper. Not part of the production interface. */
  rawCount(): number {
    return this.records.size
  }
}

function makeScheduler(): {
  scheduler: { setTimeout: (callback: () => void, delay: number) => unknown; clearTimeout: (handle: unknown) => void }
  fire: () => void
  pending: () => number
} {
  let queue: Array<() => void> = []
  const scheduler = {
    setTimeout(callback: () => void, _delay: number): unknown {
      queue.push(callback)
      return queue.length - 1
    },
    clearTimeout(handle: unknown): void {
      const index = handle as number
      queue = queue.filter((_, i) => i !== index)
    },
  }
  return {
    scheduler,
    fire: () => {
      const drained = queue
      queue = []
      for (const callback of drained) callback()
    },
    pending: () => queue.length,
  }
}

function entry(seq: number, transcriptId: string, text = `entry-${seq}`): RemoteTranscriptEntry {
  return {
    transcriptId: RemoteTranscriptId(transcriptId),
    sessionId: 's' as ReturnType<typeof RemoteSessionId>,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    kind: 'message',
    text,
    createdAt: new Date(2026, 8, 4, 12, 0, seq).toISOString(),
  }
}

const SESSION_A = 'sess-a' as ReturnType<typeof RemoteSessionId>
const SESSION_B = 'sess-b' as ReturnType<typeof RemoteSessionId>

let db: InMemoryDb
let schedulerApi: ReturnType<typeof makeScheduler>

beforeEach(() => {
  db = new InMemoryDb()
  schedulerApi = makeScheduler()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TranscriptCache put/get roundtrip', () => {
  it('returns undefined for a session that has never been written', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db) })
    expect(await cache.getEntries(SESSION_A)).toBeUndefined()
    expect(await cache.getLatestSeq(SESSION_A)).toBe(-1)
  })

  it('persists entries written via putEntries and returns them from getEntries', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 0 })
    cache.putEntries(SESSION_A, [entry(0, 't-0'), entry(1, 't-1'), entry(2, 't-2')])
    await cache.flush()

    const got = await cache.getEntries(SESSION_A)
    expect(got?.map(item => item.seq)).toEqual([0, 1, 2])
    expect(await cache.getLatestSeq(SESSION_A)).toBe(2)
    expect(db.rawCount()).toBe(1)
  })

  it('deduplicates entries by transcriptId and keeps the later write', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 0 })
    cache.putEntries(SESSION_A, [entry(0, 't-0', 'first'), entry(1, 't-1', 'first-1')])
    cache.putEntries(SESSION_A, [entry(1, 't-1', 'overwritten')])
    await cache.flush()

    const got = await cache.getEntries(SESSION_A)
    const t1 = got?.find(item => item.transcriptId === 't-1')
    expect(t1?.text).toBe('overwritten')
  })

  it('isolates sessions so writing to B does not disturb A', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 0 })
    cache.putEntries(SESSION_A, [entry(0, 'a-0')])
    cache.putEntries(SESSION_B, [entry(0, 'b-0'), entry(1, 'b-1')])
    await cache.flush()

    expect((await cache.getEntries(SESSION_A))?.length).toBe(1)
    expect((await cache.getEntries(SESSION_B))?.length).toBe(2)
    expect(db.rawCount()).toBe(2)
  })
})

describe('TranscriptCache ring trim', () => {
  it('drops the lowest-seq entries once the per-session cap is exceeded', async () => {
    const cache = new TranscriptCache({
      openDb: () => Promise.resolve(db),
      debounceMs: 0,
      maxEntriesPerSession: 5,
    })
    const events: TranscriptCacheEvent[] = []
    cache.subscribe(event => events.push(event))

    cache.putEntries(SESSION_A, [entry(0, 't-0'), entry(1, 't-1'), entry(2, 't-2'), entry(3, 't-3')])
    cache.putEntries(SESSION_A, [entry(4, 't-4'), entry(5, 't-5'), entry(6, 't-6')])
    await cache.flush()

    const got = await cache.getEntries(SESSION_A)
    expect(got?.map(item => item.seq)).toEqual([2, 3, 4, 5, 6])
    expect(await cache.getLatestSeq(SESSION_A)).toBe(6)
    const trimEvents = events.filter(event => event.type === 'evicted' && event.reason === 'ring-trim')
    expect(trimEvents.length).toBeGreaterThan(0)
  })

  it('emits exactly one ring-trim event per session when a single oversized batch lands', async () => {
    const cache = new TranscriptCache({
      openDb: () => Promise.resolve(db),
      debounceMs: 0,
      maxEntriesPerSession: 3,
    })
    const events: TranscriptCacheEvent[] = []
    cache.subscribe(event => events.push(event))

    const batch = Array.from({ length: 8 }, (_, i) => entry(i, `t-${i}`))
    cache.putEntries(SESSION_A, batch)
    await cache.flush()

    const trimEvents = events.filter(event => event.type === 'evicted' && event.reason === 'ring-trim')
    expect(trimEvents).toHaveLength(1)
  })
})

describe('TranscriptCache debounce', () => {
  it('coalesces burst writes inside the debounce window into a single persist call', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 200, scheduler: schedulerApi.scheduler })
    const persisted: number[] = []
    cache.subscribe(event => {
      if (event.type === 'persisted') persisted.push(event.entryCount)
    })

    cache.putEntries(SESSION_A, [entry(0, 't-0')])
    cache.putEntries(SESSION_A, [entry(1, 't-1')])
    cache.putEntries(SESSION_A, [entry(2, 't-2')])
    expect(schedulerApi.pending()).toBe(1)
    schedulerApi.fire()
    await cache.flush()

    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toBe(3)
  })

  it('keeps sessions independent so the burst for B does not delay A', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 200, scheduler: schedulerApi.scheduler })
    const persisted: Array<{ sessionId: string; count: number }> = []
    cache.subscribe(event => {
      if (event.type === 'persisted') persisted.push({ sessionId: event.sessionId, count: event.entryCount })
    })

    cache.putEntries(SESSION_A, [entry(0, 'a-0')])
    cache.putEntries(SESSION_B, [entry(0, 'b-0'), entry(1, 'b-1')])
    expect(schedulerApi.pending()).toBe(2)
    schedulerApi.fire()
    await cache.flush()

    expect(persisted).toHaveLength(2)
    const bySession = Object.fromEntries(persisted.map(item => [item.sessionId, item.count]))
    expect(bySession[SESSION_A]).toBe(1)
    expect(bySession[SESSION_B]).toBe(2)
  })

  it('does not schedule a new timer when putEntries is called with an empty batch', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 200 })
    cache.putEntries(SESSION_A, [])
    expect(schedulerApi.pending()).toBe(0)
  })
})

describe('TranscriptCache LRU eviction', () => {
  it('drops the oldest updatedAt session once the total byte cap is exceeded', async () => {
    const cache = new TranscriptCache({
      openDb: () => Promise.resolve(db),
      debounceMs: 0,
      maxEntriesPerSession: 50,
      maxBytesTotal: 1024,
    })
    const events: TranscriptCacheEvent[] = []
    cache.subscribe(event => events.push(event))

    cache.putEntries(SESSION_A, [entry(0, 'a-0', 'a'.repeat(400))])
    cache.putEntries(SESSION_B, [entry(0, 'b-0', 'b'.repeat(400))])
    cache.putEntries(SESSION_A, [entry(1, 'a-1', 'a'.repeat(400))])
    await cache.flush()

    expect(await cache.getEntries(SESSION_A)).toBeDefined()
    expect(await cache.getEntries(SESSION_B)).toBeUndefined()
    const lruEvents = events.filter(event => event.type === 'evicted' && event.reason === 'lru-cap')
    expect(lruEvents.length).toBeGreaterThan(0)
  })

  it('evicts repeatedly until the total fits inside the cap', async () => {
    const cache = new TranscriptCache({
      openDb: () => Promise.resolve(db),
      debounceMs: 0,
      maxBytesTotal: 800,
      maxEntriesPerSession: 100,
    })
    cache.putEntries(SESSION_A, [entry(0, 'a-0', 'x'.repeat(300))])
    cache.putEntries(SESSION_B, [entry(0, 'b-0', 'y'.repeat(300))])
    cache.putEntries('sess-c' as ReturnType<typeof RemoteSessionId>, [entry(0, 'c-0', 'z'.repeat(300))])
    await cache.flush()

    const candidates = ['sess-a', 'sess-b', 'sess-c'] as Array<ReturnType<typeof RemoteSessionId>>
    const surviving: string[] = []
    for (const id of candidates) {
      if ((await cache.getEntries(id)) !== undefined) surviving.push(id)
    }
    expect(surviving.length).toBeLessThan(3)
  })
})

describe('TranscriptCache quota errors', () => {
  it('emits quota-error and never throws when the storage layer rejects a put', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 0 })
    const events: TranscriptCacheEvent[] = []
    cache.subscribe(event => events.push(event))

    db.failNextPut(new DOMException('quota exceeded', 'QuotaExceededError'))
    cache.putEntries(SESSION_A, [entry(0, 't-0')])

    await expect(cache.flush()).resolves.toBeUndefined()
    const quotaErrors = events.filter(event => event.type === 'quota-error')
    expect(quotaErrors).toHaveLength(1)
    expect(quotaErrors[0]?.sessionId).toBe(SESSION_A)
  })

  it('keeps the in-memory shadow intact after a quota error so reads still work', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 0 })
    db.failNextPut(new Error('boom'))
    cache.putEntries(SESSION_A, [entry(0, 't-0'), entry(1, 't-1')])
    await cache.flush()

    expect(await cache.getEntries(SESSION_A)).toHaveLength(2)
    expect(await cache.getLatestSeq(SESSION_A)).toBe(1)
  })
})

describe('TranscriptCache lifecycle', () => {
  it('forget removes the session from both the shadow and the storage layer', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 0 })
    cache.putEntries(SESSION_A, [entry(0, 't-0')])
    cache.putEntries(SESSION_B, [entry(0, 't-0')])
    await cache.flush()
    expect(db.rawCount()).toBe(2)

    await cache.forget(SESSION_A)
    expect(await cache.getEntries(SESSION_A)).toBeUndefined()
    expect(await cache.getEntries(SESSION_B)).toBeDefined()
    expect(db.rawCount()).toBe(1)
  })

  it('clear drops every cached session and is idempotent', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 0 })
    cache.putEntries(SESSION_A, [entry(0, 'a-0')])
    cache.putEntries(SESSION_B, [entry(0, 'b-0')])
    await cache.flush()
    expect(db.rawCount()).toBe(2)

    await cache.clear()
    expect(db.rawCount()).toBe(0)
    await expect(cache.clear()).resolves.toBeUndefined()
  })

  it('dispose detaches listeners and stops further persistence', async () => {
    const cache = new TranscriptCache({ openDb: () => Promise.resolve(db), debounceMs: 0 })
    const listener = vi.fn()
    cache.subscribe(listener)

    cache.putEntries(SESSION_A, [entry(0, 't-0')])
    await cache.flush()
    expect(listener).toHaveBeenCalled()

    listener.mockClear()
    cache.dispose()

    cache.putEntries(SESSION_A, [entry(1, 't-1')])
    await cache.flush()
    expect(listener).not.toHaveBeenCalled()
  })
})