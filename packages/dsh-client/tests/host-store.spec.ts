import { describe, expect, it } from 'vitest'
import { startHostStore } from '../src/host-store.ts'
import type { HostStoreChannel, HostStoreDeps, StoreOp } from '../src/host-store.ts'

/**
 * The storage that follows the machine.
 *
 * The host registry and this machine's default identity used to live in
 * `window.localStorage`: a new browser context, a new browser, or a cleared
 * cache lost them all. These tests pin the replacement — a write-through
 * mirror over the host-side settings namespace (a settings channel means
 * `host`, no channel means `memory`) — with the honesty rules that matter on a
 * real page: degradation is visible in the posture, a write that could not
 * reach the machine keeps its value in the page, and data saved before the
 * first read completed is merged with what the machine returns instead of
 * being clobbered by it.
 */

const REGISTRY_KEY = 'dsh.host.registry'
const IDENTITY_KEY = 'dsh.host.identity'

/**
 * The settings channel as a real page sees it — methods on a prototype, the
 * way the remote namespace really is. A production caller that detaches a
 * method and calls it bare loses `this` and dies here, instead of passing
 * tests against arrow-function stand-ins and dying on the real page.
 */
class FakeChannel implements HostStoreChannel {
  doc: Record<string, string> = {}
  /** Remaining calls that reject, oldest first; empty means all succeed. */
  failures: string[] = []
  loaded = 0
  readonly mutations: StoreOp[][] = []

  async loadDocument(): Promise<Record<string, string> | undefined> {
    this.loaded += 1
    const failure = this.failures.shift()
    if (failure !== undefined) throw new Error(failure)
    // The channel face hands over the flat key→value record; wrapping it in
    // the namespace's `data` field is the adapter's job (it owns the wire).
    return { ...this.doc }
  }

  async mutateDocument(ops: readonly StoreOp[]): Promise<void> {
    this.mutations.push([...ops])
    const failure = this.failures.shift()
    if (failure !== undefined) throw new Error(failure)
    for (const op of ops) {
      if (op.kind === 'set') this.doc[op.key] = op.value
      else delete this.doc[op.key]
    }
  }

  /** A mutate whose rejection must not kill the caller (fired via queue). */
  failNextMutation(reason: string): void {
    this.failures.push(reason)
  }
}

/** A migration source standing in for the localStorage the data used to live in. */
function oldStorage(entries: Record<string, string>): { getItem(key: string): string | null } {
  return { getItem: key => entries[key] ?? null }
}

/** Deferred load, for tests that write before the first read settles. */
function pendingChannel(): HostStoreChannel & { resolve(value: Record<string, string> | undefined): void } {
  let release: ((value: Record<string, string> | undefined) => void) | undefined
  const promise = new Promise<Record<string, string> | undefined>(resolve => { release = resolve })
  return {
    async loadDocument() { return await promise },
    async mutateDocument(ops) {
      const current = await promise
      const doc = { ...(current ?? {}) }
      for (const op of ops) {
        if (op.kind === 'set') doc[op.key] = op.value
        else delete doc[op.key]
      }
      this.doc = doc
    },
    doc: {},
    resolve: value => { release?.(value) },
  } as HostStoreChannel & { resolve(value: Record<string, string> | undefined): void; doc: Record<string, string> }
}

/** Drain microtasks so queued flushes and posture updates land. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** The id the registry's entries union by — the same shape the wiring passes. */
const hostIdOf = (entry: unknown): string | undefined =>
  typeof entry === 'object' && entry !== null && 'hostId' in entry && typeof (entry as { hostId: unknown }).hostId === 'string'
    ? (entry as { hostId: string }).hostId
    : undefined

/** Start the store the way production wires it: the registry key unions by hostId. */
function start(deps: Omit<HostStoreDeps, 'listKeys'> & Partial<Pick<HostStoreDeps, 'listKeys'>>): ReturnType<typeof startHostStore> {
  return startHostStore({
    ...deps,
    listKeys: deps.listKeys ?? [{ key: REGISTRY_KEY, idOf: hostIdOf }],
  })
}

describe('页面不是从回环地址打开：登记仍写回提供这个页面的机器', () => {
  it('设置通道在就不看是不是回环地址，读写都落到通道上', async () => {
    const channel = new FakeChannel()
    channel.doc[REGISTRY_KEY] = '[{"hostId":"bench","hostTitle":"测试机","address":"http://192.168.1.20:3081","createdAt":1}]'
    const store = start({ loopback: () => false, channel, log: () => {} })
    await store.settled()

    expect(store.posture()).toEqual({ kind: 'host' })
    expect(channel.loaded).toBeGreaterThan(0)
    expect(store.storage.getItem(REGISTRY_KEY)).toContain('测试机')
    store.storage.setItem(REGISTRY_KEY, '[{"hostId":"bench"},{"hostId":"lab"}]')
    await settle()
    expect(channel.doc[REGISTRY_KEY]).toContain('lab')
  })

  it('没有设置通道时仍只放本页，并说明原因是通道缺席', async () => {
    const store = start({ loopback: () => false, channel: undefined, log: () => {} })
    await store.settled()
    store.storage.setItem(REGISTRY_KEY, '[{"hostId":"bench"}]')
    expect(store.storage.getItem(REGISTRY_KEY)).toBe('[{"hostId":"bench"}]')
    expect(store.posture()).toEqual({ kind: 'memory', reason: 'no-channel' })
  })
})

describe('本机页面：经设置通道存进这台机器', () => {
  it('启动后读到的登记来自主机文档，写入原样落到通道（逐键 set）', async () => {
    const channel = new FakeChannel()
    channel.doc[REGISTRY_KEY] = '[{"hostId":"bench","hostTitle":"测试机","address":"http://192.168.1.20:3081","createdAt":1}]'
    const store = start({ loopback: () => true, channel, log: () => {} })
    await store.settled()

    expect(store.posture()).toEqual({ kind: 'host' })
    expect(store.storage.getItem(REGISTRY_KEY)).toContain('测试机')
    expect(store.storage.getItem('nothing.here')).toBeNull()

    store.storage.setItem(REGISTRY_KEY, '[{"hostId":"bench"},{"hostId":"lab"}]')
    await settle()
    expect(channel.mutations.at(-1)).toEqual([{ kind: 'set', key: REGISTRY_KEY, value: '[{"hostId":"bench"},{"hostId":"lab"}]' }])
    // 真正落到通道的文档里也有（不是只在页面内存里）。
    expect(channel.doc[REGISTRY_KEY]).toContain('lab')
  })

  it('removeItem 走逐键 unset：别的键不动', async () => {
    const channel = new FakeChannel()
    channel.doc[REGISTRY_KEY] = '[]'
    channel.doc[IDENTITY_KEY] = '{"hostId":"ws"}'
    const store = start({ loopback: () => true, channel, log: () => {} })
    await store.settled()

    store.storage.removeItem(REGISTRY_KEY)
    await settle()
    expect(channel.mutations.at(-1)).toEqual([{ kind: 'unset', key: REGISTRY_KEY }])
    expect(channel.doc[REGISTRY_KEY]).toBeUndefined()
    expect(channel.doc[IDENTITY_KEY]).toBe('{"hostId":"ws"}')
    expect(store.storage.getItem(REGISTRY_KEY)).toBeNull()
  })

  it('命名空间存在但还没有内容：照常工作，姿态是 host', async () => {
    const channel = new FakeChannel()
    const store = start({ loopback: () => true, channel, log: () => {} })
    await store.settled()
    expect(store.posture()).toEqual({ kind: 'host' })
    expect(store.storage.getItem(REGISTRY_KEY)).toBeNull()
  })
})

describe('降级要看得见，数据不装丢', () => {
  it('写入失败：页面里还在，姿态点名失败原因，恢复后补存', async () => {
    const channel = new FakeChannel()
    const store = start({ loopback: () => true, channel, log: () => {} })
    await store.settled()

    channel.failNextMutation('provider refused')
    store.storage.setItem(REGISTRY_KEY, '[{"hostId":"bench"}]')
    await settle()
    expect(store.storage.getItem(REGISTRY_KEY)).toBe('[{"hostId":"bench"}]')
    expect(store.posture().kind).toBe('degraded')

    // 下一次写入把上一次没存进去的一起补上。
    store.storage.setItem(IDENTITY_KEY, '{"hostId":"ws"}')
    await settle()
    expect(store.posture()).toEqual({ kind: 'host' })
    expect(channel.doc[REGISTRY_KEY]).toBe('[{"hostId":"bench"}]')
    expect(channel.doc[IDENTITY_KEY]).toBe('{"hostId":"ws"}')
  })

  it('读取失败：姿态点名原因，页面照常可读写', async () => {
    const channel = new FakeChannel()
    channel.failures.push('gateway down')
    const store = start({ loopback: () => true, channel, log: () => {} })
    await store.settled()

    expect(store.posture().kind).toBe('degraded')
    store.storage.setItem(REGISTRY_KEY, '[]')
    expect(store.storage.getItem(REGISTRY_KEY)).toBe('[]')
  })

  it('设置通道整个缺席：如实说存不住，绝不假装存上了', async () => {
    const store = start({ loopback: () => true, channel: undefined, log: () => {} })
    await store.settled()
    expect(store.posture()).toEqual({ kind: 'memory', reason: 'no-channel' })
  })
})

describe('启动竞态：先写后读，合并而不是覆盖', () => {
  it('读取落地前登记的主机，与主机文档里的既有登记并存', async () => {
    const channel = pendingChannel()
    const store = start({ loopback: () => true, channel, log: () => {} })
    // 读取还没回来，用户已经登记了一台。
    store.storage.setItem(REGISTRY_KEY, '[{"hostId":"fresh"}]')
    expect(store.storage.getItem(REGISTRY_KEY)).toContain('fresh')

    channel.resolve({ [REGISTRY_KEY]: '[{"hostId":"old"}]' })
    await store.settled()
    await settle()

    const merged = JSON.parse(store.storage.getItem(REGISTRY_KEY) ?? '[]') as string[]
    expect(merged.map(entry => (entry as unknown as { hostId: string }).hostId).sort()).toEqual(['fresh', 'old'])
    // 合并结果补存回这台机器：fresh 不能只活在页面里。
    const doc = (channel as unknown as { doc: Record<string, string> }).doc
    expect(JSON.parse(doc[REGISTRY_KEY] ?? '[]').map((entry: { hostId: string }) => entry.hostId).sort()).toEqual(['fresh', 'old'])
  })

  it('读取落地前删掉本页刚登记的主机，落地后不再回来', async () => {
    const channel = pendingChannel()
    const store = start({ loopback: () => true, channel, log: () => {} })
    store.storage.setItem(REGISTRY_KEY, '[{"hostId":"fresh"}]')
    store.storage.removeItem(REGISTRY_KEY)

    channel.resolve({ [REGISTRY_KEY]: '[{"hostId":"old"}]' })
    await store.settled()
    await settle()

    expect(store.storage.getItem(REGISTRY_KEY)).toBe('[{"hostId":"old"}]')
  })
})

describe('旧数据迁移：localStorage 里已有的登记不凭空消失', () => {
  it('主机文档还没有登记而浏览器里有：搬进主机文档', async () => {
    const channel = new FakeChannel()
    const legacy = '[{"hostId":"bench","hostTitle":"测试机","address":"http://192.168.1.20:3081","createdAt":7}]'
    const store = startHostStore({
      loopback: () => true,
      channel,
      migrateFrom: oldStorage({ [REGISTRY_KEY]: legacy, [IDENTITY_KEY]: '{"hostId":"ws","hostTitle":"工作室主机"}' }),
      migrateKeys: [REGISTRY_KEY, IDENTITY_KEY],
      log: () => {},
    })
    await store.settled()
    await settle()

    expect(JSON.parse(channel.doc[REGISTRY_KEY] ?? '[]')).toEqual(JSON.parse(legacy))
    expect(channel.doc[IDENTITY_KEY]).toBe('{"hostId":"ws","hostTitle":"工作室主机"}')
    expect(store.storage.getItem(REGISTRY_KEY)).toBe(legacy)
  })

  it('主机文档已经有登记：不搬，浏览器里的旧拷贝不覆盖新数据', async () => {
    const channel = new FakeChannel()
    channel.doc[REGISTRY_KEY] = '[{"hostId":"already-on-host"}]'
    const store = startHostStore({
      loopback: () => true,
      channel,
      migrateFrom: oldStorage({ [REGISTRY_KEY]: '[{"hostId":"stale-browser-copy"}]' }),
      migrateKeys: [REGISTRY_KEY],
      log: () => {},
    })
    await store.settled()
    await settle()

    expect(store.storage.getItem(REGISTRY_KEY)).toBe('[{"hostId":"already-on-host"}]')
    expect(channel.doc[REGISTRY_KEY]).toBe('[{"hostId":"already-on-host"}]')
  })
})


describe('同一拍先删后写：改名路径的两笔写入不互相吞', () => {
  it('第一笔（unset）落盘时，第二笔（set）的待存标记还活着，最终机器上是新值', async () => {
    const channel = new FakeChannel()
    channel.doc = { [REGISTRY_KEY]: JSON.stringify([{ hostId: 'bench-a', hostTitle: '测试机甲', address: 'http://192.168.1.99:3081' }]) }
    const store = start({ loopback: () => true, channel, log: () => {} })
    await store.settled()

    // 挂起第一笔 mutate（改名第一步 remove 的 unset），让第二步 add 的写入
    // 在它落盘前发生——真实页面里 remove 和 add 是同一个同步块的邻居。
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>(resolve => { releaseFirst = resolve })
    const original = channel.mutateDocument.bind(channel)
    channel.mutateDocument = async ops => {
      await first
      await original(ops)
    }

    const next = JSON.stringify([{ hostId: 'bench-a', hostTitle: '测试机甲改', address: 'http://192.168.1.99:3081' }])
    store.storage.removeItem(REGISTRY_KEY)
    store.storage.setItem(REGISTRY_KEY, next)
    releaseFirst?.()
    await settle()
    await settle()
    await settle()

    expect(channel.doc[REGISTRY_KEY]).toBe(next)
    expect(store.storage.getItem(REGISTRY_KEY)).toBe(next)
    expect(store.posture()).toEqual({ kind: 'host' })
  })
})

describe('主机文档在别处被改：刷新能听见', () => {
  it('refresh 重新读取，没被本页改过的键跟着变', async () => {
    const channel = new FakeChannel()
    const store = start({ loopback: () => true, channel, log: () => {} })
    await store.settled()

    channel.doc[REGISTRY_KEY] = '[{"hostId":"from-other-tab"}]'
    const seen: number[] = []
    store.subscribe(() => { seen.push(1) })
    store.refresh()
    await settle()

    expect(store.storage.getItem(REGISTRY_KEY)).toContain('from-other-tab')
    expect(seen.length).toBeGreaterThan(0)
  })

  it('本页没存进去的改动，刷新时和机器上的版本合并，不互相覆盖', async () => {
    const channel = new FakeChannel()
    channel.doc[REGISTRY_KEY] = '[{"hostId":"bench"}]'
    const store = start({ loopback: () => true, channel, log: () => {} })
    await store.settled()

    // 这次写入没落到机器（通道失败），键保持脏。
    channel.failNextMutation('provider refused')
    store.storage.setItem(REGISTRY_KEY, '[{"hostId":"bench"},{"hostId":"mine"}]')
    await settle()
    expect(store.posture().kind).toBe('degraded')

    // 期间另一处把别的条目写进了机器；刷新读到它，脏键按条目合并后补存。
    channel.doc[REGISTRY_KEY] = '[{"hostId":"bench"},{"hostId":"theirs"}]'
    store.refresh()
    await settle()

    const ids = (JSON.parse(store.storage.getItem(REGISTRY_KEY) ?? '[]') as { hostId: string }[]).map(entry => entry.hostId).sort()
    expect(ids).toEqual(['bench', 'mine', 'theirs'])
    expect(store.posture()).toEqual({ kind: 'host' })
    const docIds = (JSON.parse(channel.doc[REGISTRY_KEY] ?? '[]') as { hostId: string }[]).map(entry => entry.hostId).sort()
    expect(docIds).toEqual(['bench', 'mine', 'theirs'])
  })
})
