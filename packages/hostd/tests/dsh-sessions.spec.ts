import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateProjectDshSessions } from '../src/dsh-sessions.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function writeSession(root: string, projectKey: string, sessionId: string, bytes: string): string {
  const directory = join(root, projectKey, sessionId)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'session.jsonl.zstd')
  writeFileSync(file, bytes, { mode: 0o600 })
  return file
}

describe('migrateProjectDshSessions', () => {
  it('is a no-op when the project has no .sessions directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'th-dsh-sessions-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const sessionRoot = join(root, 'dsh-sessions')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionRoot, { recursive: true })
    migrateProjectDshSessions(cwd, sessionRoot)
    expect(existsSync(join(cwd, '.sessions'))).toBe(false)
    expect(existsSync(sessionRoot)).toBe(true)
  })

  it('moves leftover project sessions into the hostd session root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'th-dsh-sessions-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const sessionRoot = join(root, 'dsh-sessions')
    mkdirSync(sessionRoot, { recursive: true, mode: 0o700 })
    writeSession(join(cwd, '.sessions'), '--proj--', 'session-a', 'alpha')
    migrateProjectDshSessions(cwd, sessionRoot)
    expect(existsSync(join(cwd, '.sessions'))).toBe(false)
    expect(readFileSync(join(sessionRoot, '--proj--', 'session-a', 'session.jsonl.zstd'), 'utf8')).toBe('alpha')
  })

  it('keeps the destination copy when the same session already exists there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'th-dsh-sessions-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const sessionRoot = join(root, 'dsh-sessions')
    writeSession(join(cwd, '.sessions'), '--proj--', 'session-a', 'stale-project-copy')
    writeSession(sessionRoot, '--proj--', 'session-a', 'live-hostd-copy')
    migrateProjectDshSessions(cwd, sessionRoot)
    expect(existsSync(join(cwd, '.sessions'))).toBe(false)
    expect(readFileSync(join(sessionRoot, '--proj--', 'session-a', 'session.jsonl.zstd'), 'utf8')).toBe('live-hostd-copy')
  })

  it('moves only the sessions that are missing from the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'th-dsh-sessions-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const sessionRoot = join(root, 'dsh-sessions')
    writeSession(join(cwd, '.sessions'), '--proj--', 'old', 'from-project')
    writeSession(join(cwd, '.sessions'), '--proj--', 'live', 'stale')
    writeSession(sessionRoot, '--proj--', 'live', 'current')
    migrateProjectDshSessions(cwd, sessionRoot)
    expect(existsSync(join(cwd, '.sessions'))).toBe(false)
    expect(readFileSync(join(sessionRoot, '--proj--', 'old', 'session.jsonl.zstd'), 'utf8')).toBe('from-project')
    expect(readFileSync(join(sessionRoot, '--proj--', 'live', 'session.jsonl.zstd'), 'utf8')).toBe('current')
  })

  it('does not follow a .sessions symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'th-dsh-sessions-'))
    roots.push(root)
    const cwd = join(root, 'project')
    const sessionRoot = join(root, 'dsh-sessions')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionRoot, { recursive: true })
    writeSession(sessionRoot, '--proj--', 'session-a', 'keep')
    symlinkSync(sessionRoot, join(cwd, '.sessions'))
    migrateProjectDshSessions(cwd, sessionRoot)
    expect(readFileSync(join(sessionRoot, '--proj--', 'session-a', 'session.jsonl.zstd'), 'utf8')).toBe('keep')
    expect(existsSync(join(cwd, '.sessions'))).toBe(true)
  })
})
