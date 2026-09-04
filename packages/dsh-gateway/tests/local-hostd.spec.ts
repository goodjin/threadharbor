import { describe, expect, it } from 'vitest'
import { hostdRestartArgv, parseHostdCommand } from '../src/local-hostd.ts'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local hostd restart argv', () => {
  it('reads port and data-dir from a workspace hostd command line', () => {
    expect(parseHostdCommand('node packages/hostd/lib/bin.js --data-dir /tmp/th-run --port 62846'))
      .toEqual({ port: 62846, dataDir: '/tmp/th-run' })
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
      'node packages/hostd/lib/bin.js --data-dir /tmp/th-run --port 62846',
      bin,
      62846,
    )).toEqual([bin, '--host', '127.0.0.1', '--port', '62846', '--data-dir', '/tmp/th-run'])
  })
})
