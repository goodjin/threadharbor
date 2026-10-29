import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { emptyAcpVisibility } from '../src/acp-visibility.ts'

const snapshot = {
  current: null, routable: true,
  groups: [{ id: 'test', name: 'Test', models: [{ id: 'one', name: 'One' }] }],
  failures: [], status: 'ready', pending: null, error: null,
}
const directory = {
  store: { getSnapshot: () => snapshot, subscribe: () => () => {} },
  load: async () => snapshot,
  select: async () => ({ ok: true }),
}
const visibility = {
  get: emptyAcpVisibility,
  subscribe: () => () => {},
  set: () => {}, refresh: () => {},
}

class Directories extends Service {
  static inject = ['remote.session']
  constructor(ctx: Context) { super(ctx, 'modelDirectories') }
  directoryFor(_id: string): typeof directory {
    // Like the official resolver, this method reads a required remote through
    // the caller context. An unloaded installer must never own this read.
    void (this.ctx as unknown as Record<string, unknown>)['remote.session']
    return directory
  }
}

describe('模型过滤器的真实 Cordis 生命周期', () => {
  it('插件反复热更新时撤掉旧包装，保留模型目录', async () => {
    const ctx = new Context()
    ctx.provide('remote.session', {})
    const service = ctx.plugin(Directories)
    await service.await()
    const caller = ctx.get('modelDirectories') as unknown as Directories
    const original = Object.getPrototypeOf(caller).directoryFor
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let generation = 0; generation < 3; generation += 1) {
        vi.resetModules()
        const { installAcpVisibilityFilter } = await import('../src/acp-visibility-filter.ts')
        const filter = ctx.plugin({
          inject: ['modelDirectories'],
          apply(scope: Context) {
            scope.effect(() => installAcpVisibilityFilter(scope.get('modelDirectories'), visibility))
          },
        })
        await filter.await()
        expect(caller.directoryFor('s').store.getSnapshot()).toEqual(snapshot)
        await filter.dispose()
        expect(caller.directoryFor('s').store.getSnapshot()).toEqual(snapshot)
        // Compare the actual own property, not the per-read method proxy.
        expect(Object.getOwnPropertyDescriptor(caller, 'directoryFor')?.value ?? original).toBe(original)
      }
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      await ctx.fiber.dispose()
    }
  })
})
