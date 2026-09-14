import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteSessionId, RemoteTranscriptId, type RemoteTranscriptEntry } from '@threadharbor/protocol'
import { TranscriptStore } from '../src/transcript-store.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'th-store-'))
  dirs.push(dir)
  return dir
}

const sessionA = RemoteSessionId('aaaaaaaa-0000-4000-8000-000000000001')
const sessionB = RemoteSessionId('bbbbbbbb-0000-4000-8000-000000000002')

function row(session: ReturnType<typeof RemoteSessionId>, seq: number, extra: Partial<RemoteTranscriptEntry> = {}): RemoteTranscriptEntry {
  return {
    transcriptId: RemoteTranscriptId(`${session}:${seq}`),
    sessionId: session,
    seq,
    role: 'tool',
    kind: 'tool-result',
    text: `row ${seq}`,
    createdAt: '2026-09-12T00:00:00.000Z',
    ...extra,
  }
}

function lines(dir: string, session: string): string[] {
  return readFileSync(join(dir, `${session}.jsonl`), 'utf8').split('\n').filter(line => line !== '')
}

describe('TranscriptStore', () => {
  it('appends rows as one file write per batch and reloads them on reopen', async () => {
    const dir = tempDir()
    const store = new TranscriptStore({ directory: dir })
    await store.open()
    await store.append(sessionA, [row(sessionA, 0), row(sessionA, 1)], 100)
    await store.append(sessionB, [row(sessionB, 0)], 100)
    await store.flush()
    expect(lines(dir, sessionA)).toHaveLength(2)
    expect(store.session(sessionA).map(entry => entry.seq)).toEqual([0, 1])

    const reopened = new TranscriptStore({ directory: dir })
    await reopened.open()
    expect(reopened.size).toBe(3)
    expect(reopened.get(RemoteTranscriptId(`${sessionA}:1`))?.text).toBe('row 1')
    expect(reopened.session(sessionB).map(entry => entry.seq)).toEqual([0])
  })

  it('rotates the oldest rows past the cap with tombstones and compacts once they pile up', async () => {
    const dir = tempDir()
    const store = new TranscriptStore({ directory: dir, compactAfterTombstones: 2 })
    await store.open()
    await store.append(sessionA, [row(sessionA, 0), row(sessionA, 1), row(sessionA, 2)], 3)
    const dropped1 = await store.append(sessionA, [row(sessionA, 3)], 3)
    expect(dropped1.map(entry => entry.seq)).toEqual([0])
    await store.flush()
    expect(lines(dir, sessionA).some(line => line.includes('"del"'))).toBe(true)
    const dropped2 = await store.append(sessionA, [row(sessionA, 4), row(sessionA, 5)], 3)
    expect(dropped2.map(entry => entry.seq)).toEqual([1, 2])
    await store.flush()
    // Three tombstones exceed the threshold: the file is rewritten from memory.
    expect(lines(dir, sessionA)).toHaveLength(3)
    expect(lines(dir, sessionA).some(line => line.includes('"del"'))).toBe(false)
    expect(store.session(sessionA).map(entry => entry.seq)).toEqual([3, 4, 5])

    const reopened = new TranscriptStore({ directory: dir })
    await reopened.open()
    expect(reopened.session(sessionA).map(entry => entry.seq)).toEqual([3, 4, 5])
  })

  it('honours tombstones that were not compacted yet when reloading', async () => {
    const dir = tempDir()
    const store = new TranscriptStore({ directory: dir })
    await store.open()
    await store.append(sessionA, [row(sessionA, 0), row(sessionA, 1)], 2)
    await store.append(sessionA, [row(sessionA, 2)], 2)
    await store.flush()
    expect(lines(dir, sessionA)).toHaveLength(4)
    const reopened = new TranscriptStore({ directory: dir })
    await reopened.open()
    expect(reopened.session(sessionA).map(entry => entry.seq)).toEqual([1, 2])
  })

  it('deletes a session with its file and stays memory-only without a directory', async () => {
    const dir = tempDir()
    const store = new TranscriptStore({ directory: dir })
    await store.open()
    await store.append(sessionA, [row(sessionA, 0)], 10)
    await store.deleteSession(sessionA)
    expect(store.session(sessionA)).toEqual([])
    expect(existsSync(join(dir, `${sessionA}.jsonl`))).toBe(false)

    const memory = new TranscriptStore()
    await memory.open()
    await memory.append(sessionA, [row(sessionA, 0)], 10)
    expect(memory.size).toBe(1)
    expect(await memory.needsLegacyImport()).toBe(false)
  })

  it('imports legacy rows once, keeping existing ids, and records the marker', async () => {
    const dir = tempDir()
    const store = new TranscriptStore({ directory: dir })
    await store.open()
    expect(await store.needsLegacyImport()).toBe(true)
    await store.append(sessionA, [row(sessionA, 0, { text: 'already here' })], 10)
    const imported = await store.importLegacy([row(sessionA, 0, { text: 'legacy copy' }), row(sessionA, 1), row(sessionB, 0)])
    expect(imported).toBe(2)
    expect(store.get(RemoteTranscriptId(`${sessionA}:0`))?.text).toBe('already here')
    expect(await store.needsLegacyImport()).toBe(false)
    await store.flush()
    const reopened = new TranscriptStore({ directory: dir })
    await reopened.open()
    expect(reopened.session(sessionA).map(entry => entry.seq)).toEqual([0, 1])
    expect(reopened.session(sessionB).map(entry => entry.seq)).toEqual([0])
  })
})
