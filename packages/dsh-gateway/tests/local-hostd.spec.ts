import { describe, expect, it } from 'vitest'
import {
  hostdRestartArgv,
  isEphemeralHostdDataDir,
  parseHostdCommand,
  resolveLoopbackHostdDataDir,
} from '../src/local-hostd.ts'
import { join } from 'node:path'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local hostd restart argv', () => {
  it('reads port and data-dir from a workspace hostd command line', () => {
    expect(parseHostdCommand('node packages/hostd/lib/bin.js --data-dir /Users/good/.local/state/threadharbor --port 62846'))
      .toEqual({ port: 62846, dataDir: '/Users/good/.local/state/threadharbor' })
  })

  it('rejects ssh tunnels and other listeners', () => {
    expect(parseHostdCommand('ssh -L 127.0.0.1:50862:127.0.0.1:3091 mini')).toBeUndefined()
  })

  it('rebuilds argv against the current artifact bin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-local-hostd-'))
    roots.push(root)
    const bin = join(root, 'bin.js')
    await writeFile(bin, '#!/usr/bin/env node\n')
    expect(hostdRestartArgv(
      'node packages/hostd/lib/bin.js --data-dir /Users/good/.local/state/threadharbor --port 62846',
      bin,
      62846,
    )).toEqual([bin, '--host', '127.0.0.1', '--port', '62846', '--data-dir', '/Users/good/.local/state/threadharbor'])
  })
})

describe('ephemeral hostd dataDir detection', () => {
  it('matches /tmp and /private/tmp prefixes', () => {
    expect(isEphemeralHostdDataDir('/tmp/threadharbor-hostd-run.abc')).toBe(true)
    expect(isEphemeralHostdDataDir('/private/tmp/threadharbor-hostd-run.abc')).toBe(true)
  })

  it('matches macOS /var/folders per-user temp dirs', () => {
    expect(isEphemeralHostdDataDir('/var/folders/xx/yy/T/threadharbor-run')).toBe(true)
  })

  it('matches the OS tmpdir itself', () => {
    expect(isEphemeralHostdDataDir(tmpdir())).toBe(true)
  })

  it('leaves a stable persistent path alone', () => {
    expect(isEphemeralHostdDataDir('/Users/good/.local/state/threadharbor')).toBe(false)
    expect(isEphemeralHostdDataDir('/Users/good/.local/state/threadharbor-test/hostd')).toBe(false)
  })
})

describe('resolveLoopbackHostdDataDir', () => {
  it('returns a persistent dataDir unchanged', () => {
    expect(resolveLoopbackHostdDataDir('/Users/good/.local/state/threadharbor-test/hostd'))
      .toBe('/Users/good/.local/state/threadharbor-test/hostd')
  })

  it('copies an ephemeral dataDir into the persistent root when one does not exist yet', async () => {
    const ephemeralRoot = await mkdtemp(join(tmpdir(), 'threadharbor-ephemeral-'))
    roots.push(ephemeralRoot)
    await mkdir(join(ephemeralRoot, 'holds'), { recursive: true, mode: 0o700 })
    await writeFile(join(ephemeralRoot, 'sessions.json'), '{"version":1,"sessions":[]}\n', { mode: 0o600 })

    const destination = join(tmpdir(), `threadharbor-persistent-dest-${process.pid}-${Date.now()}`)
    roots.push(destination)
    const result = resolveLoopbackHostdDataDir(ephemeralRoot, { persistentRoot: destination })
    expect(result).toBe(destination)
    expect(await readFile(join(destination, 'sessions.json'), 'utf8')).toBe('{"version":1,"sessions":[]}\n')
  })

  it('keeps an existing destination and does not overwrite it', async () => {
    const ephemeralRoot = await mkdtemp(join(tmpdir(), 'threadharbor-skip-'))
    roots.push(ephemeralRoot)
    await mkdir(join(ephemeralRoot, 'holds'), { recursive: true, mode: 0o700 })

    const destination = await mkdtemp(join(tmpdir(), 'threadharbor-existing-'))
    roots.push(destination)
    await writeFile(join(destination, 'marker'), 'keep\n', { mode: 0o600 })

    expect(resolveLoopbackHostdDataDir(ephemeralRoot, { persistentRoot: destination })).toBe(destination)
    expect(await readFile(join(destination, 'marker'), 'utf8')).toBe('keep\n')
  })
})
