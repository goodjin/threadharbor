import { describe, expect, it, vi } from 'vitest'
import { archiveSession, deleteWorkspace, forkSession, openLocalSession, pinSession, renameSession, renameWorkspace, startSessionInProject, unarchiveSession, unpinSession } from '../src/session-actions.ts'

const ctxWith = (uiWorkspace: unknown) => ({ get: (name: string) => (name === 'uiWorkspace' ? uiWorkspace : undefined) })

describe('openLocalSession', () => {
  it('有 openSession：派发并返回 true', () => {
    const openSession = vi.fn()
    const ctx = ctxWith({ openSession })
    expect(openLocalSession(ctx, 's-1')).toBe(true)
    expect(openSession).toHaveBeenCalledWith('s-1')
  })

  it('uiWorkspace 缺失：返回 false，不抛', () => {
    expect(openLocalSession(ctxWith(undefined), 's-1')).toBe(false)
  })

  it('openSession 抛错：捕获转 false，不让树崩掉', () => {
    const ctx = ctxWith({ openSession: () => { throw new Error('boom') } })
    expect(openLocalSession(ctx, 's-1')).toBe(false)
  })

  it('服务存在但没有 openSession 函数：视为缺失', () => {
    expect(openLocalSession(ctxWith({ other: 1 }), 's-1')).toBe(false)
  })
})

describe('startSessionInProject', () => {
  it('直连路径：create 落到 sessions 控制器并揭示', async () => {
    const created: Array<{ workspaceId: string; sessionId?: string }> = []
    const opened: string[] = []
    const ctx = {
      get: (name: string) => {
        if (name === 'sessions') {
          return {
            create: async (opts: { workspaceId: string; sessionId?: string }) => { created.push(opts); return { ok: true, value: { sessionId: opts.sessionId ?? 'fresh' } } },
            list: { getSnapshot: () => ({ ids: [], byId: {} }) },
          }
        }
        if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } }
        if (name === 'uiWorkspace') return { openSession: (id: string) => { opened.push(id) } }
        return undefined
      },
    }
    expect(await startSessionInProject(ctx, 'w-9')).toBeUndefined()
    expect(created).toEqual([{ workspaceId: 'w-9' }])
    expect(opened).toEqual(['fresh'])
  })

  it('services 缺失或抛错：返回原因字符串，不抛', async () => {
    expect(await startSessionInProject(ctxWith(undefined), 'w-9')).toContain('未就绪')
    const ctx = {
      get: (name: string) => {
        if (name === 'sessions') return { create: async () => { throw new Error('nope') }, list: { getSnapshot: () => ({ ids: [], byId: {} }) } }
        if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } }
        if (name === 'uiWorkspace') return { openSession: () => {} }
        return undefined
      },
    }
    expect(await startSessionInProject(ctx, 'w-9')).toContain('nope')
  })
})

describe('方法不脱离宿主对象（原型方法依赖 this）', () => {
  class PrototypeService {
    readonly opened: string[] = []
    readonly created: Array<{ workspaceId: string; sessionId?: string }> = []
    openSession(sessionId: string): void { this.opened.push(sessionId) }
    create(opts: { workspaceId: string; sessionId?: string }): Promise<{ ok: boolean; value: { sessionId: string } }> {
      this.created.push(opts)
      return Promise.resolve({ ok: true, value: { sessionId: opts.sessionId ?? 'fresh' } })
    }
  }
  class Ctx {
    private readonly service = new PrototypeService()
    private readonly sessionsLike = {
      create: async (opts: { workspaceId: string; sessionId?: string }) => this.service.create(opts),
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
    }
    get(name: string): unknown {
      if (name === 'uiWorkspace') return this.service
      if (name === 'sessions') return this.sessionsLike
      if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } }
      return undefined
    }
  }

  it('经宿主对象派发：this 不丢，记录真实落账', async () => {
    const ctx = new Ctx()
    const ui = ctx.get('uiWorkspace') as { opened: string[]; created: Array<{ workspaceId: string }> }
    expect(openLocalSession(ctx, 's-9')).toBe(true)
    expect(await startSessionInProject(ctx, 'w-9')).toBeUndefined()
    expect(ui.opened).toEqual(['s-9', 'fresh'])
    expect(ui.created).toEqual([{ workspaceId: 'w-9' }])
  })
})

describe('项目与会话的动作接缝（原生项目行功能保留）', () => {
  it('重命名/删除工作区经 workspaces 服务透传，失败返回原文', async () => {
    const calls: Array<[string, unknown[]]> = []
    const workspaces = {
      rename: async (...args: unknown[]) => { calls.push(['rename', args]); return { ok: true } },
      delete: async (...args: unknown[]) => { calls.push(['delete', args]); return { ok: true } },
    }
    const ctx = { get: (name: string) => name === 'workspaces' ? workspaces : undefined }
    expect(await renameWorkspace(ctx, 'w1', '新名')).toBeUndefined()
    expect(await deleteWorkspace(ctx, 'w1')).toBeUndefined()
    expect(calls).toEqual([['rename', ['w1', '新名']], ['delete', ['w1']]])
    const broken = { get: () => { throw new Error('service not ready') } }
    expect(await renameWorkspace(broken, 'w1', 'x')).toContain('not ready')
    expect(await deleteWorkspace(broken, 'w1')).toContain('not ready')
  })

  it('归档/置顶/分叉经 uiWorkspace 透传，经接收者调用', async () => {
    const calls: Array<[string, unknown[]]> = []
    const mk = (name: string) => async (...args: unknown[]) => { calls.push([name, args]) }
    const ui = { archiveSession: mk('archive'), unarchiveSession: mk('unarchive'), pinSession: mk('pin'), unpinSession: mk('unpin'), forkSession: mk('fork') }
    const ctx = { get: (n: string) => n === 'uiWorkspace' ? ui : undefined }
    expect(await archiveSession(ctx, 's1')).toBeUndefined()
    expect(await unarchiveSession(ctx, 's1')).toBeUndefined()
    expect(await pinSession(ctx, 's1')).toBeUndefined()
    expect(await unpinSession(ctx, 's1')).toBeUndefined()
    expect(await forkSession(ctx, 's1')).toBeUndefined()
    expect(calls.map(c => c[0])).toEqual(['archive', 'unarchive', 'pin', 'unpin', 'fork'])
  })

  it('会话重命名经 sessions.using 绑定引用，失败返回原文', async () => {
    const using = async (_id: string, _opts: unknown, run: (ref: unknown) => unknown) => run('REF')
    const session = { rename: async (title: string) => { if (title === '') throw new Error('empty title'); return true } }
    const sessions = { using, binding: undefined }
    // reference.bind 不可靠，直接按原生形状构造
    const ref = { binding: { session } }
    const sessions2 = { using: async (_id: string, _o: unknown, run: (r: unknown) => unknown) => run(ref) }
    const ctx = { get: (n: string) => n === 'sessions' ? sessions2 : undefined }
    expect(await renameSession(ctx, 's1', '新标题')).toBeUndefined()
    expect(await renameSession(ctx, 's1', '')).toContain('empty title')
    const broken = { get: () => { throw new Error('no sessions') } }
    expect(await renameSession(broken, 's1', 'x')).toContain('no sessions')
  })
})

describe('新会话直连（原生 startSession 无声折返后的替代路径）', () => {
  it('无空白可复用时：create 新会话并 openSession 揭示', async () => {
    const created: Array<{ workspaceId: string; sessionId?: string }> = []
    const opened: string[] = []
    const sessions = {
      create: async (opts: { workspaceId: string; sessionId?: string }) => {
        created.push(opts)
        return { ok: true, value: { sessionId: opts.sessionId ?? 'fresh-1' } }
      },
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
    }
    const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: ['s0'] }], archivedSessionIds: [] }) } }
    const ui = { openSession: (id: string) => { opened.push(id) } }
    const ctx = { get: (name: string) => name === 'sessions' ? sessions : name === 'workspaces' ? workspaces : name === 'uiWorkspace' ? ui : undefined }
    expect(await startSessionInProject(ctx, 'w1')).toBeUndefined()
    expect(created).toEqual([{ workspaceId: 'w1' }])
    expect(opened).toEqual(['fresh-1'])
  })

  it('有空白可复用：按原生规则复用，不再新建', async () => {
    const created: Array<{ workspaceId: string; sessionId?: string }> = []
    const sessions = {
      create: async (opts: { workspaceId: string; sessionId?: string }) => {
        created.push(opts)
        return { ok: true, value: { sessionId: opts.sessionId ?? 'fresh' } }
      },
      list: { getSnapshot: () => ({ ids: ['b1', 'b2'], byId: { b1: { blank: true }, b2: { blank: false } } }) },
    }
    const workspaces = { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: ['b1', 'b2'] }], archivedSessionIds: [] }) } }
    const opened: string[] = []
    const ctx = { get: (name: string) => name === 'sessions' ? sessions : name === 'workspaces' ? workspaces : name === 'uiWorkspace' ? { openSession: (id: string) => { opened.push(id) } } : undefined }
    expect(await startSessionInProject(ctx, 'w1')).toBeUndefined()
    expect(created).toEqual([{ workspaceId: 'w1', sessionId: 'b1' }])
    expect(opened).toEqual(['b1'])
  })

  it('create 被拒：原文返回，不 openSession', async () => {
    const sessions = { create: async () => ({ ok: false, error: { message: '目录正忙' } }), list: { getSnapshot: () => ({ ids: [], byId: {} }) } }
    const ctx = { get: (name: string) => name === 'sessions' ? sessions : name === 'workspaces' ? { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } } : name === 'uiWorkspace' ? { openSession: () => {} } : undefined }
    expect(await startSessionInProject(ctx, 'w1')).toContain('目录正忙')
  })
})

describe('cordis 未授予的服务：get 抛异常而不是返回空', () => {
  it('get 抛错按缺失处理，不炸树', async () => {
    const ctx = { get: () => { throw new Error('service not ready') } }
    expect(openLocalSession(ctx, 's-1')).toBe(false)
    expect(await startSessionInProject(ctx, 'w-1')).toContain('not ready')
  })
})
