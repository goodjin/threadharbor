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
  it('有 startSession：派发并返回 true', () => {
    const startSession = vi.fn()
    const ctx = ctxWith({ openSession: () => {}, startSession })
    expect(startSessionInProject(ctx, 'w-9')).toBe(true)
    expect(startSession).toHaveBeenCalledWith('w-9')
  })

  it('uiWorkspace 缺失或抛错：返回 false，不抛', () => {
    expect(startSessionInProject(ctxWith(undefined), 'w-9')).toBe(false)
    const ctx = ctxWith({ startSession: () => { throw new Error('nope') } })
    expect(startSessionInProject(ctx, 'w-9')).toBe(false)
  })
})

describe('方法不脱离宿主对象（原型方法依赖 this）', () => {
  class PrototypeService {
    readonly opened: string[] = []
    readonly started: string[] = []
    openSession(sessionId: string): void { this.opened.push(sessionId) }
    startSession(workspaceId: string): void { this.started.push(workspaceId) }
  }
  class Ctx {
    private readonly service = new PrototypeService()
    get(name: string): unknown { return name === 'uiWorkspace' ? this.service : undefined }
  }

  it('经宿主对象派发：this 不丢，记录真实落账', () => {
    const ctx = new Ctx()
    const ui = ctx.get('uiWorkspace') as { opened: string[]; started: string[] }
    expect(openLocalSession(ctx, 's-9')).toBe(true)
    expect(startSessionInProject(ctx, 'w-9')).toBe(true)
    expect(ui.opened).toEqual(['s-9'])
    expect(ui.started).toEqual(['w-9'])
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

describe('cordis 未授予的服务：get 抛异常而不是返回空', () => {
  it('get 抛错按缺失处理，不炸树', () => {
    const ctx = { get: () => { throw new Error('service not ready') } }
    expect(openLocalSession(ctx, 's-1')).toBe(false)
    expect(startSessionInProject(ctx, 'w-1')).toBe(false)
  })
})
