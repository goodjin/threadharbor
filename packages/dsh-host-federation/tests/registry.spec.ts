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
})
