/**
 * The picker filter: what both model entries actually read.
 *
 * The official `/model` popup builds its options from `load()`'s return
 * value, while the composer seat subscribes to `store`. A filter that moved
 * only one of them would leave a second, unfiltered door, so both are checked
 * here — together with the identity rules `useSyncExternalStore` needs and the
 * promise that every other directory member still reaches the raw instance.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import {
  emptyAcpVisibility,
  setAgentHidden,
  setModelHidden,
  startAcpVisibility,
} from '../src/acp-visibility.ts'
import type { AcpVisibility, AcpVisibilityStore } from '../src/acp-visibility.ts'
import { installAcpVisibilityFilter } from '../src/acp-visibility-filter.ts'

const cursor = 'acp:cursor'
const codex = 'acp:codex'

function initialState(): ModelDirectoryState {
  return {
    current: { provider: cursor, model: 'grok' },
    routable: true,
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] },
      {
        id: cursor,
        name: 'Cursor',
        models: [{ id: 'grok', name: 'Grok' }, { id: 'sonnet', name: 'Sonnet' }],
      },
      {
        id: codex,
        name: 'Codex',
        models: [{ id: 'gpt', name: 'GPT' }, { id: 'o3', name: 'o3' }],
      },
    ],
    failures: [
      { id: 'acp:qwen', name: 'Qwen', message: 'lookup failed' },
      { id: 'deepseek-account', name: 'DeepSeek account', message: 'unavailable' },
    ],
    status: 'ready',
    pending: null,
    error: null,
  }
}

type FakeDirectory = {
  store: {
    getSnapshot(): ModelDirectoryState
    subscribe(listener: () => void): () => void
  }
  load(): Promise<ModelDirectoryState>
  select(selection: unknown): Promise<unknown>
  setState(next: ModelDirectoryState): void
  selected: unknown[]
}

function fakeDirectory(): FakeDirectory {
  let snapshot = initialState()
  const listeners = new Set<() => void>()
  const selected: unknown[] = []
  return {
    store: {
      getSnapshot: () => snapshot,
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    load: async () => snapshot,
    select: async selection => {
      selected.push(selection)
      return { ok: true }
    },
    setState: next => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
    selected,
  }
}

function fakeVisibility(initial: AcpVisibility = emptyAcpVisibility()): AcpVisibilityStore & { put(next: AcpVisibility): void } {
  const listeners = new Set<() => void>()
  let current = initial
  return {
    get: () => current,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: next => { current = next },
    refresh: () => {},
    put: next => {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

type Service = {
  directoryFor(sessionId: string): unknown
  directoryForPatched?: boolean
}

function fakeService(directory: unknown): Service {
  return {
    directoryFor(_sessionId: string) {
      return directory
    },
  }
}

type ProxiedDirectory = {
  store: { getSnapshot(): ModelDirectoryState; subscribe(listener: () => void): () => void }
  load(): Promise<ModelDirectoryState>
  select(selection: unknown): Promise<unknown>
}

function ids(state: ModelDirectoryState): string[] {
  return state.groups.map(group => `${group.id}:${group.models.map(model => model.id).join(',')}`)
}

describe('目录包装', () => {
  it('store 与 load 同时过滤：两个入口不会有一条漏网', async () => {
    const raw = fakeDirectory()
    const visibility = fakeVisibility(setAgentHidden(emptyAcpVisibility(), 'cursor', true))
    const service = fakeService(raw)
    const dispose = installAcpVisibilityFilter(service, visibility)
    expect(dispose).toBeDefined()
    const proxied = service.directoryFor('s') as ProxiedDirectory

    expect(ids(proxied.store.getSnapshot())).toEqual([
      'deepseek:chat',
      'acp:codex:gpt,o3',
    ])
    // `/model` reads this return value, not the store.
    const loaded = await proxied.load()
    expect(loaded).toBe(proxied.store.getSnapshot())
    expect(ids(loaded)).toEqual(['deepseek:chat', 'acp:codex:gpt,o3'])
  })

  it('模型级屏蔽只去掉那一项，失败行按 agent 屏蔽', async () => {
    const raw = fakeDirectory()
    const visibility = fakeVisibility(setModelHidden(emptyAcpVisibility(), 'codex', 'gpt', true))
    const service = fakeService(raw)
    installAcpVisibilityFilter(service, visibility)
    const proxied = service.directoryFor('s') as ProxiedDirectory
    const snapshot = await proxied.load()

    expect(ids(snapshot)).toEqual([
      'deepseek:chat',
      'acp:cursor:grok,sonnet',
      'acp:codex:o3',
    ])
    expect(snapshot.failures.map(failure => failure.id)).toEqual(['acp:qwen', 'deepseek-account'])

    visibility.put(setAgentHidden(visibility.get(), 'qwen', true))
    expect(proxied.store.getSnapshot().failures.map(failure => failure.id)).toEqual(['deepseek-account'])
  })

  it('原生 provider 也过滤：store 与 load 一起藏起它和它的失败行', async () => {
    const raw = fakeDirectory()
    const visibility = fakeVisibility(setAgentHidden(emptyAcpVisibility(), 'deepseek', true))
    const service = fakeService(raw)
    installAcpVisibilityFilter(service, visibility)
    const proxied = service.directoryFor('s') as ProxiedDirectory

    expect(ids(proxied.store.getSnapshot())).toEqual([
      'acp:cursor:grok,sonnet',
      'acp:codex:gpt,o3',
    ])
    const loaded = await proxied.load()
    expect(ids(loaded)).toEqual(['acp:cursor:grok,sonnet', 'acp:codex:gpt,o3'])

    visibility.put(setAgentHidden(visibility.get(), 'deepseek-account', true))
    expect(proxied.store.getSnapshot().failures.map(failure => failure.id)).toEqual(['acp:qwen'])
  })

  it('切换屏蔽后订阅者收到新快照，且状态对象保持稳定', () => {
    const raw = fakeDirectory()
    const visibility = fakeVisibility()
    const service = fakeService(raw)
    installAcpVisibilityFilter(service, visibility)
    const proxied = service.directoryFor('s') as ProxiedDirectory
    const before = proxied.store.getSnapshot()
    let calls = 0
    proxied.store.subscribe(() => { calls += 1 })

    visibility.put(setAgentHidden(visibility.get(), 'cursor', true))
    expect(calls).toBe(1)
    const after = proxied.store.getSnapshot()
    expect(after).not.toBe(before)
    expect(ids(after)).toEqual(['deepseek:chat', 'acp:codex:gpt,o3'])

    // The same visible content arriving as a new raw object must not produce
    // a new snapshot: uSES would re-render forever.
    raw.setState({ ...raw.store.getSnapshot(), status: 'ready' })
    expect(proxied.store.getSnapshot()).toBe(after)
    expect(calls).toBe(1)
  })

  it('原生状态字段（当前选择、状态、错误）原样透过', () => {
    const raw = fakeDirectory()
    const visibility = fakeVisibility(setAgentHidden(emptyAcpVisibility(), 'cursor', true))
    const service = fakeService(raw)
    installAcpVisibilityFilter(service, visibility)
    const proxied = service.directoryFor('s') as ProxiedDirectory
    const snapshot = proxied.store.getSnapshot()
    expect(snapshot.current).toEqual({ provider: cursor, model: 'grok' })
    expect(snapshot.status).toBe('ready')
    expect(snapshot.error).toBeNull()
  })

  it('select 仍打在原始目录上，返回原始结果', async () => {
    const raw = fakeDirectory()
    const visibility = fakeVisibility()
    const service = fakeService(raw)
    installAcpVisibilityFilter(service, visibility)
    const proxied = service.directoryFor('s') as ProxiedDirectory

    await expect(proxied.select({ provider: codex, model: 'o3' })).resolves.toEqual({ ok: true })
    expect(raw.selected).toEqual([{ provider: codex, model: 'o3' }])
  })

  it('同一个原始目录只包一次，会话之间互不影响', () => {
    const raw = fakeDirectory()
    const visibility = fakeVisibility()
    const service = fakeService(raw)
    installAcpVisibilityFilter(service, visibility)
    expect(service.directoryFor('a')).toBe(service.directoryFor('b'))
  })

  it('dispose 把原始方法还回去，重复安装不叠过滤层', async () => {
    const raw = fakeDirectory()
    const visibility = fakeVisibility(setAgentHidden(emptyAcpVisibility(), 'cursor', true))
    const service = fakeService(raw)
    const original = service.directoryFor
    const first = installAcpVisibilityFilter(service, visibility)
    expect(service.directoryFor).not.toBe(original)
    // A second installation rebuilds on the pristine method, not on the wrap.
    const second = installAcpVisibilityFilter(service, visibility)
    const proxied = service.directoryFor('s') as ProxiedDirectory
    expect(ids(await proxied.load())).toEqual(['deepseek:chat', 'acp:codex:gpt,o3'])
    second?.()
    expect(service.directoryFor).toBe(original)
    first?.()
    expect(service.directoryFor).toBe(original)
  })

  it('客户端图被热替换后：旧实例上的包装层转到当下这一代，模型不消失', () => {
    // 2026-10-20 桌面版：宿主重建了客户端包，SSE 把新图推给开着的页签；上一代
    // 的服务实例被处置，而官方那个模型座位还攥着旧实例 → 座位条目崩掉，输入框的
    // 模型入口整个消失，页签不自愈（空白首页没事，有会话的窗口就废了）。
    //
    // 包装层在调用时转到当下这一代的服务：旧实例上装的包装层照样服务当下的目录。
    const first = fakeService(fakeDirectory())
    installAcpVisibilityFilter(first, fakeVisibility())
    // 新一代：宿主重建了客户端包，包装重新装到新实例上；它的目录是另一份。
    const nextState = initialState()
    nextState.groups = [{ id: 'acp:next-gen', name: 'Next', models: [{ id: 'n', name: 'N' }] }]
    const second = fakeService({ ...fakeDirectory(), store: {
      getSnapshot: () => nextState,
      subscribe: () => () => {},
    } })
    installAcpVisibilityFilter(second, fakeVisibility())

    const viaStale = first.directoryFor('s1') as ProxiedDirectory
    expect(viaStale).toBeDefined()
    // 旧实例上的调用给的是**当下这一代**的目录（不是它自己那份旧的）。
    expect(viaStale.store.getSnapshot()?.groups.map(group => group.id)).toEqual(['acp:next-gen'])
  })

  it('热替换之后：旧模块装的那层也认得当下这一代的服务', async () => {
    // 客户端图被热替换（宿主重建了客户端包，SSE 把新图推给开着的页签）时，
    // **模块本身会被重新求值**：旧模块里那份「当前服务」的指针停在上一代
    // （已被处置、调用即抛）的实例上 → 座位调到它 → 死 → 模型入口消失。
    //
    // 所以「当前这一代」不能住在模块变量里：它得住在一个跨模块实例共享的地方
    // （页面的全局），新旧两份模块都看同一份。
    vi.resetModules()
    const fresh = await import('../src/acp-visibility-filter.ts')
    // 上一代：已被处置——它的原方法一调就抛（inactive context）。
    const disposed = {
      directoryFor(): unknown {
        throw new Error('cannot get required service "remote.session" in inactive context')
      },
    }
    fresh.installAcpVisibilityFilter(disposed, fakeVisibility(setAgentHidden(emptyAcpVisibility(), 'cursor', true)))
    // 新一代：模块被重新求值（新的一份），包装装到新实例上。
    vi.resetModules()
    const newer = await import('../src/acp-visibility-filter.ts')
    const live = fakeService(fakeDirectory())
    newer.installAcpVisibilityFilter(live, fakeVisibility())

    // 旧模块装的那层（旧实例上的包装）仍要给出**当下这一代**的目录，
    // 而不是退化成「什么都不答」的空目录。
    const viaOld = disposed.directoryFor('s1') as ProxiedDirectory
    expect(viaOld).toBeDefined()
    expect(viaOld.store.getSnapshot()?.groups.map(group => group.id)).toContain('acp:codex')
    // The live generation unhid Cursor; the old wrapper must not hide it again.
    expect(viaOld.store.getSnapshot()?.groups.map(group => group.id)).toContain('acp:cursor')
  })

  it('服务已经没了时不把异常抛给调用方：座位照常渲染', async () => {
    // 2026-10-20 桌面版：连接重建后旧的服务实例被处置，它的原方法一调就抛
    // 「cannot get required service "remote.session" in inactive context」；
    // 异常顺着官方那个模型座位的 inject 冒上去，崩的是**座位条目**——输入框的
    // 模型入口整个消失。这一档必须自己兜住：给一个什么都不答的目录，并说清原因。
    const reports: string[] = []
    const service = {
      directoryFor(): unknown {
        throw new Error('cannot get required service "remote.session" in inactive context')
      },
    }
    installAcpVisibilityFilter(service, fakeVisibility(), message => { reports.push(message) })

    const directory = service.directoryFor('s1') as ProxiedDirectory
    expect(directory).toBeDefined()
    expect(typeof directory.store.getSnapshot).toBe('function')
    expect(typeof directory.store.subscribe).toBe('function')
    expect(typeof directory.load).toBe('function')
    expect(typeof directory.select).toBe('function')
    // The official seat reads groups/current directly; undefined crashes it.
    const snapshot = directory.store.getSnapshot()
    expect(snapshot).toMatchObject({ groups: [], current: null, status: 'error' })
    expect(directory.store.getSnapshot()).toBe(snapshot)
    await expect(directory.load()).resolves.toBe(snapshot)
    await expect(directory.select({ provider: codex, model: 'gpt' })).rejects.toThrow('inactive context')
    expect(reports.some(message => message.includes('inactive context'))).toBe(true)
  })

  it('拿不到 directoryFor 或目录形状不对时不动手，并说清原因', async () => {
    const reported: string[] = []
    expect(installAcpVisibilityFilter({}, fakeVisibility(), message => { reported.push(message) }))
      .toBeUndefined()
    expect(reported.join('\n')).toContain('no directoryFor')

    reported.length = 0
    const service = fakeService({ not: 'a directory' })
    expect(installAcpVisibilityFilter(service, fakeVisibility(), message => { reported.push(message) }))
      .toBeDefined()
    expect(service.directoryFor('s')).toEqual({ not: 'a directory' })
    expect(reported.join('\n')).toContain('leaving that directory unfiltered')
  })

  it('从真实存储启动的可见性也能驱动过滤', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const visibility = startAcpVisibility(storage)
    const service = fakeService(fakeDirectory())
    installAcpVisibilityFilter(service, visibility)
    const proxied = service.directoryFor('s') as ProxiedDirectory
    visibility.set(setAgentHidden(visibility.get(), 'codex', true))
    expect(ids(proxied.store.getSnapshot())).toEqual(['deepseek:chat', 'acp:cursor:grok,sonnet'])
  })
})
