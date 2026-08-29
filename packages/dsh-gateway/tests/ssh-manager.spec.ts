import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SshManager } from '../src/ssh-manager.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
describe('SshManager configuration', () => {
  it('keeps identity bytes server-side and requires fingerprint approval before deployment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadharbor-ssh-'))
    roots.push(root)
    const identityFile = join(root, 'identity')
    await writeFile(identityFile, 'not-a-real-key\n', { mode: 0o600 })
    const manager = new SshManager({
      knownHostsPath: join(root, 'known_hosts'),
      connectTimeoutMs: 100,
      installTimeoutMs: 100,
      hostdRemotePort: 3091,
      hostdArtifactDirectory: join(root, 'hostd'),
    })
    try {
      expect(manager.parseInspectionConfig({ target: 'example.test', user: 'agent', identityFile }))
        .toMatchObject({ target: 'example.test', user: 'agent', identityFile, hostKeyFingerprint: 'unapproved' })
      expect(() => manager.parseApprovedConfig({ target: 'example.test', identityFile }))
        .toThrow('hostKeyFingerprint is required')
      expect(() => manager.parseInspectionConfig({ target: 'example.test', identityFile: 'relative/key' }))
        .toThrow('existing absolute path')
    } finally {
      manager.close()
    }
  })
})
