import { describe, expect, it, vi } from 'vitest'
import { openLocalSession, startSessionInProject } from '../src/session-actions.ts'

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
