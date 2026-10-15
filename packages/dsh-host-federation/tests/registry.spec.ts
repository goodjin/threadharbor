/**
 * The operator's host registry, without a browser in the loop.
 *
 * A registration is bookkeeping — what exists, where, under which hostId — and
 * every rule here exists because a wrong entry sends an operator to a dead
 * address or merges two machines into one slot. Malformed stored entries are
 * dropped at read rather than crashing the panel; a duplicate hostId is refused
 * rather than silently merged (§8.2 binds settings per hostId).
 */

import { describe, expect, it } from 'vitest'
import { HOST_REGISTRY_KEY, hostRegistry, normalizeAddress } from '../src/registry.ts'
import type { RemoteReport } from '../src/remote-report.ts'

function fakeStorage(initial: Record<string, string> = {}): {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }
  dump(): Record<string, string>
} {
  const map = new Map(Object.entries(initial))
  return {
    storage: {
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => { map.set(key, value) },
    },
    dump: () => Object.fromEntries(map),
  }
}

describe('normalizeAddress', () => {
  it('reduces a full URL to its origin', () => {
    expect(normalizeAddress('http://192.168.1.10:3081/some/path?token=x')).toEqual({
      ok: true,
      origin: 'http://192.168.1.10:3081',
    })
  })

  it('refuses a bare authority with a sentence that says why', () => {
    const result = normalizeAddress('192.168.1.10:3081')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('http')
  })

  it('refuses schemes a browser cannot open as a page', () => {
    const result = normalizeAddress('ssh://192.168.1.10')
    expect(result.ok).toBe(false)
  })
})

describe('hostRegistry', () => {
  it('adds, lists, and removes entries', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage, () => 100)
    const added = registry.add({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' })
    expect(added.ok).toBe(true)
    expect(registry.list()).toEqual([{
      hostId: 'bench',
      hostTitle: '测试机',
      address: 'http://192.168.1.20:3081',
      createdAt: 100,
    }])
    expect(registry.remove('bench')).toBe(true)
    expect(registry.list()).toEqual([])
  })

  it('falls back to the id when no title was given', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage)
    const added = registry.add({ hostId: 'bench', hostTitle: '  ', address: 'http://192.168.1.20:3081' })
    expect(added.ok).toBe(true)
    expect(registry.list()[0]?.hostTitle).toBe('bench')
  })

  it('stores launchUrl when it matches the origin and carries a token', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage)
    const added = registry.add({
      hostId: 'edge',
      hostTitle: '边缘',
      address: 'http://100.64.0.2:3081',
      launchUrl: 'http://100.64.0.2:3081/?token=abc',
    })
    expect(added.ok).toBe(true)
    expect(registry.list()[0]?.launchUrl).toContain('token=abc')
  })

  it('refuses a duplicate hostId instead of merging two machines', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage)
    registry.add({ hostId: 'bench', hostTitle: 'a', address: 'http://192.168.1.20:3081' })
    const again = registry.add({ hostId: 'bench', hostTitle: 'b', address: 'http://192.168.1.21:3081' })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.kind).toBe('duplicate')
    expect(registry.list()).toHaveLength(1)
  })

  it('refuses an unusable hostId and an unreadable address, each by name', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage)
    const badId = registry.add({ hostId: 'a/b', hostTitle: '', address: 'http://192.168.1.20:3081' })
    expect(badId.ok).toBe(false)
    if (!badId.ok) expect(badId.error.kind).toBe('bad-id')
    const badAddress = registry.add({ hostId: 'bench', hostTitle: '', address: 'nonsense' })
    expect(badAddress.ok).toBe(false)
    if (!badAddress.ok) expect(badAddress.error.kind).toBe('bad-address')
    expect(registry.list()).toEqual([])
  })

  it('removing an unknown id changes nothing', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage)
    expect(registry.remove('ghost')).toBe(false)
  })

  it('keeps entries in storage under the one key and reads them back', () => {
    const { storage, dump } = fakeStorage()
    const registry = hostRegistry(storage)
    registry.add({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' })
    expect(Object.keys(dump())).toEqual([HOST_REGISTRY_KEY])
    expect(hostRegistry(storage).list()).toHaveLength(1)
  })

  it('drops malformed stored entries instead of failing the panel', () => {
    const { storage } = fakeStorage({ [HOST_REGISTRY_KEY]: JSON.stringify([
      { hostId: 'good', hostTitle: 'ok', address: 'http://192.168.1.20:3081', createdAt: 1 },
      { hostId: 'bad/id', address: 'http://x' },
      'junk',
      { hostId: 'bad-address', hostTitle: '', address: 'not-a-url' },
    ]) })
    const registry = hostRegistry(storage)
    expect(registry.list().map(entry => entry.hostId)).toEqual(['good'])
  })

  it('reads unreadable storage as an empty registry', () => {
    const { storage } = fakeStorage({ [HOST_REGISTRY_KEY]: 'not json' })
    expect(hostRegistry(storage).list()).toEqual([])
  })

  describe('ssh connection info', () => {
    it('stores non-secret ssh facts and reads them back through storage', () => {
      const { storage } = fakeStorage()
      const registry = hostRegistry(storage, () => 100)
      const added = registry.add({
        hostId: 'bench',
        hostTitle: '测试机',
        address: 'http://192.168.1.20:3081',
        ssh: {
          target: '192.168.1.20',
          port: 22,
          user: 'deploy',
          proxyJump: 'jump.example',
          authMode: 'identityFile',
          identityFile: '/Users/me/.ssh/id_ed25519',
          hostKeyFingerprint: 'SHA256:abc',
          remoteWebPort: 3081,
        },
      })
      expect(added.ok).toBe(true)
      const again = hostRegistry(storage).list()
      expect(again).toEqual([{
        hostId: 'bench',
        hostTitle: '测试机',
        address: 'http://192.168.1.20:3081',
        ssh: {
          target: '192.168.1.20',
          port: 22,
          user: 'deploy',
          proxyJump: 'jump.example',
          authMode: 'identityFile',
          identityFile: '/Users/me/.ssh/id_ed25519',
          hostKeyFingerprint: 'SHA256:abc',
          remoteWebPort: 3081,
        },
        createdAt: 100,
      }])
    })

    it('refuses a stored password by name', () => {
      const { storage } = fakeStorage()
      const registry = hostRegistry(storage)
      const result = registry.add({
        hostId: 'bench',
        hostTitle: '',
        address: 'http://192.168.1.20:3081',
        ssh: { target: '192.168.1.20', authMode: 'password', password: 'hunter2' },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('bad-ssh')
        expect(result.error.detail).toContain('密码')
      }
      expect(registry.list()).toEqual([])
    })

    it('refuses a pasted pem the same way', () => {
      const { storage } = fakeStorage()
      const registry = hostRegistry(storage)
      const result = registry.add({
        hostId: 'bench',
        hostTitle: '',
        address: 'http://192.168.1.20:3081',
        ssh: { target: '192.168.1.20', authMode: 'identityPem', identityPem: '-----BEGIN' },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('bad-ssh')
    })

    it('refuses an ssh block without a target or with unusable ports', () => {
      const { storage } = fakeStorage()
      const registry = hostRegistry(storage)
      const noTarget = registry.add({
        hostId: 'bench', hostTitle: '', address: 'http://192.168.1.20:3081',
        ssh: { target: '  ', authMode: 'identityFile' },
      })
      expect(noTarget.ok).toBe(false)
      if (!noTarget.ok) expect(noTarget.error.kind).toBe('bad-ssh')
      const badPort = registry.add({
        hostId: 'bench', hostTitle: '', address: 'http://192.168.1.20:3081',
        ssh: { target: '192.168.1.20', port: 70000, authMode: 'identityFile' },
      })
      expect(badPort.ok).toBe(false)
      if (!badPort.ok) expect(badPort.error.kind).toBe('bad-ssh')
      const badWebPort = registry.add({
        hostId: 'bench', hostTitle: '', address: 'http://192.168.1.20:3081',
        ssh: { target: '192.168.1.20', remoteWebPort: 0, authMode: 'identityFile' },
      })
      expect(badWebPort.ok).toBe(false)
      if (!badWebPort.ok) expect(badWebPort.error.kind).toBe('bad-ssh')
    })

    it('refuses an unknown auth mode', () => {
      const { storage } = fakeStorage()
      const registry = hostRegistry(storage)
      const result = registry.add({
        hostId: 'bench', hostTitle: '', address: 'http://192.168.1.20:3081',
        ssh: { target: '192.168.1.20', authMode: 'agent' as never },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('bad-ssh')
    })

    it('entries without ssh keep parsing (legacy records)', () => {
      const { storage } = fakeStorage({ [HOST_REGISTRY_KEY]: JSON.stringify([
        { hostId: 'old', hostTitle: '旧', address: 'http://192.168.1.20:3081', createdAt: 5 },
      ]) })
      expect(hostRegistry(storage).list()[0]?.ssh).toBeUndefined()
    })

    it('a hand-edited record smuggling a password loses the secret on read', () => {
      const { storage } = fakeStorage({ [HOST_REGISTRY_KEY]: JSON.stringify([
        {
          hostId: 'sneaky', hostTitle: '手改', address: 'http://192.168.1.20:3081', createdAt: 5,
          ssh: { target: '192.168.1.20', authMode: 'password', password: 'hunter2', identityPem: 'x' },
        },
      ]) })
      const entry = hostRegistry(storage).list()[0]
      expect(entry?.ssh).toEqual({ target: '192.168.1.20', authMode: 'password' })
    })

    it('a stored ssh block missing required facts drops the block on read, keeping the entry', () => {
      const { storage } = fakeStorage({ [HOST_REGISTRY_KEY]: JSON.stringify([
        { hostId: 'thin', hostTitle: '', address: 'http://192.168.1.20:3081', createdAt: 5, ssh: { authMode: 'identityFile' } },
      ]) })
      const entry = hostRegistry(storage).list()[0]
      expect(entry?.hostId).toBe('thin')
      expect(entry?.ssh).toBeUndefined()
    })
  })
})

describe('hostRegistry recordRemote', () => {
  const report: RemoteReport = {
    deployment: 'deployed',
    liveness: 'running',
    port: 3081,
    readAt: 500,
  }

  it('stores the report on the entry and reads the same remote back from a fresh registry over storage', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage, () => 100)
    registry.add({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' })
    expect(registry.recordRemote('bench', report)).toBe(true)
    expect(registry.list()[0]?.remote).toEqual(report)
    expect(hostRegistry(storage).list()[0]?.remote).toEqual(report)
  })

  it('returns false for an unknown hostId and writes nothing', () => {
    const { storage, dump } = fakeStorage()
    const registry = hostRegistry(storage)
    expect(registry.recordRemote('ghost', report)).toBe(false)
    expect(dump()).toEqual({})
  })

  it('leaves address, launchUrl, ssh, and createdAt untouched when it writes', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage, () => 100)
    registry.add({
      hostId: 'edge',
      hostTitle: '边缘',
      address: 'http://100.64.0.2:3081',
      launchUrl: 'http://100.64.0.2:3081/?token=abc',
      ssh: {
        target: '100.64.0.2',
        port: 22,
        user: 'deploy',
        authMode: 'identityFile',
        identityFile: '/Users/me/.ssh/id_ed25519',
        remoteWebPort: 3081,
      },
    })
    const before = registry.list()[0]
    const newer: RemoteReport = { ...report, readAt: 900 }
    expect(registry.recordRemote('edge', newer)).toBe(true)
    const after = registry.list()[0]
    expect(after?.address).toBe(before?.address)
    expect(after?.launchUrl).toBe(before?.launchUrl)
    expect(after?.ssh).toEqual(before?.ssh)
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(after?.remote).toEqual(newer)
  })

  it('a value that parses to no report is not written, keeping the entry as it was', () => {
    const { storage } = fakeStorage()
    const registry = hostRegistry(storage, () => 100)
    registry.add({ hostId: 'bench', hostTitle: '测试机', address: 'http://192.168.1.20:3081' })
    const before = registry.list()
    expect(registry.recordRemote('bench', { readAt: 'not a number' } as unknown as RemoteReport)).toBe(false)
    expect(registry.list()).toEqual(before)
  })

  it('entries without a remote key keep parsing, reading remote as undefined (legacy records)', () => {
    const { storage } = fakeStorage({ [HOST_REGISTRY_KEY]: JSON.stringify([
      { hostId: 'old', hostTitle: '旧', address: 'http://192.168.1.20:3081', createdAt: 5 },
    ]) })
    const entry = hostRegistry(storage).list()[0]
    expect(entry?.hostId).toBe('old')
    expect(entry?.remote).toBeUndefined()
  })
})
