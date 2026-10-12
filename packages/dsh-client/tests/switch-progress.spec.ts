/**
 * 切换过程的那条进度：先出进度条，再把新会话的首屏读出来，读完才跳。
 *
 * 用户看到的切换是「内容整个换掉」，中间那段空白过去没有任何交代。这组
 * 测试盯住三件事：进度状态按真实步骤走（新会话读出来了才叫就绪）、首屏读
 * 失败或卡住都不许把跳转卡死、以及这条浮层确实挂在窗口上而不是会话里——
 * 会话一换就消失的进度条等于没有。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import {
  HOLD_MS,
  PRELOAD_TIMEOUT_MS,
  SETTLE_MS,
  SwitchProgressLayer,
  createSwitchProgressStore,
  startSwitchProgressSurface,
} from '../src/switch-progress.ts'
import type { SwitchProgressPhase, SwitchProgressStore } from '../src/switch-progress.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A sessions service that hands out references whose readiness the test drives. */
class FakeSessions {
  readonly retained: string[] = []
  readonly released: string[] = []
  private resolveReady: (() => void) | undefined
  private rejectReady: ((error: Error) => void) | undefined
  /** Set when the test wants readiness to settle on demand. */
  private pending: Promise<void> | undefined

  constructor(private readonly outcome: 'manual' | 'refused' | 'never' = 'manual') {
    if (outcome !== 'never') {
      this.pending = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve
        this.rejectReady = reject
      })
    }
  }

  retain(target: string, _options: { source: string }): { sessionId: string; ready: Promise<unknown>; release: () => void } {
    this.retained.push(target)
    const reference = {
      sessionId: target,
      ready: this.pending ?? new Promise<void>(() => {}),
      release: () => { this.released.push(target) },
    }
    return reference
  }

  /** The new session's first page arrives. */
  loaded(): void {
    this.resolveReady?.()
  }

  /** The new session's first page fails. */
  failed(): void {
    this.rejectReady?.(new Error('session open refused'))
  }
}

/** A context that answers `sessions` or refuses it, like a host that lacks one. */
function contextWith(sessions: FakeSessions | undefined) {
  return {
    logger: () => ({ info: () => {}, warn: () => {} }),
    effect: (callback: () => unknown) => { callback(); return () => {} },
    get: (name: string) => {
      if (name === 'sessions' && sessions !== undefined) return sessions
      throw new Error(`property "${name}" does not exist`)
    },
  }
}

function slotHost(core: SlotCore) {
  return {
    inject: (key: string, callback: () => unknown) => {
      if (core.spec(key) === undefined) throw new Error(`slot ${key} is not declared`)
      callback()
      return () => {}
    },
    register: (options: Parameters<SlotCore['register']>[0], component: Parameters<SlotCore['register']>[1]) =>
      core.register(options, component),
  }
}

/** The frame, with the seat this surface registers into declared as a list. */
function frameWith(core: SlotCore): void {
  core.register(
    {
      name: 'root',
      children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
      inject: () => null,
    },
    () => createElement('div'),
  )
}

/** Start the surface and watch every phase it publishes. */
function watch(store: SwitchProgressStore): SwitchProgressPhase[] {
  const seen: SwitchProgressPhase[] = []
  store.subscribe(() => {
    const phase = store.getSnapshot().current?.phase
    if (phase !== undefined) seen.push(phase)
  })
  return seen
}

describe('切换进度状态', () => {
  it('还没切换时不显示任何进度', () => {
    const store = createSwitchProgressStore()
    expect(store.getSnapshot().current).toBeUndefined()
  })

  it('开始切换就报出要打开的是哪个会话、哪个 agent', () => {
    const store = createSwitchProgressStore()
    store.actions.begin({ sessionId: 'session-new', target: 'acp-claude' })
    expect(store.getSnapshot().current).toEqual({
      sessionId: 'session-new',
      target: 'acp-claude',
      phase: 'preparing',
    })
  })
})

describe('切换进度面', () => {
  it('新会话首屏读完后进度走到就绪，此刻还不归还那份读取', async () => {
    vi.useFakeTimers()
    const core = new SlotCore()
    frameWith(core)
    const sessions = new FakeSessions()
    const store = createSwitchProgressStore()
    const seen = watch(store)
    const surface = startSwitchProgressSurface({ ctx: contextWith(sessions), store, slots: slotHost(core) })

    const done = surface.prepare({ sessionId: 'session-new', target: 'acp-claude' })
    expect(sessions.retained).toEqual(['session-new'])
    sessions.loaded()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    await done

    expect(seen).toEqual(['preparing', 'loading', 'ready'])
    // 跳过去的时候工作区还没接手，会话得先由这里撑着，别在跳转前松手。
    expect(sessions.released).toEqual([])
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    expect(sessions.released).toEqual(['session-new'])
  })

  it('首屏读失败也照样放行跳转', async () => {
    vi.useFakeTimers()
    const core = new SlotCore()
    frameWith(core)
    const sessions = new FakeSessions('refused')
    const store = createSwitchProgressStore()
    const surface = startSwitchProgressSurface({ ctx: contextWith(sessions), store, slots: slotHost(core) })

    const done = surface.prepare({ sessionId: 'session-new', target: 'acp-claude' })
    sessions.failed()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)

    await expect(done).resolves.toBeUndefined()
    expect(store.getSnapshot().current?.phase).toBe('ready')
  })

  it('首屏一直没读完，到点也放行', async () => {
    vi.useFakeTimers()
    const core = new SlotCore()
    frameWith(core)
    const sessions = new FakeSessions('never')
    const store = createSwitchProgressStore()
    const surface = startSwitchProgressSurface({ ctx: contextWith(sessions), store, slots: slotHost(core) })

    let released = false
    void surface.prepare({ sessionId: 'session-new', target: 'acp-claude' }).then(() => { released = true })
    await vi.advanceTimersByTimeAsync(PRELOAD_TIMEOUT_MS + SETTLE_MS)

    expect(released).toBe(true)
  })

  it('宿主没有会话服务时只有进度条，没有报错', async () => {
    vi.useFakeTimers()
    const core = new SlotCore()
    frameWith(core)
    const store = createSwitchProgressStore()
    const seen = watch(store)
    const surface = startSwitchProgressSurface({ ctx: contextWith(undefined), store, slots: slotHost(core) })

    const done = surface.prepare({ sessionId: 'session-new', target: 'acp-claude' })
    await vi.advanceTimersByTimeAsync(SETTLE_MS)

    await expect(done).resolves.toBeUndefined()
    expect(seen).toContain('ready')
  })

  it('进度条登记在窗口浮层上，不是会话里', () => {
    const core = new SlotCore()
    frameWith(core)
    const store = createSwitchProgressStore()
    startSwitchProgressSurface({ ctx: contextWith(new FakeSessions()), store, slots: slotHost(core) })
    const ids = core.entriesOfSlot('shell.overlay').map(entry => entry.options.id ?? entry.options.name)
    expect(ids).toContain('threadharbor-switch-progress')
  })
})

describe('进度条画出来的东西', () => {
  /** Render the layer with the injected face a registration would supply. */
  function paint(store: SwitchProgressStore): { host: HTMLElement; dispose: () => void } {
    const host = document.createElement('div')
    document.body.append(host)
    let root: Root | undefined
    act(() => {
      root = createRoot(host)
      root.render(createElement(SwitchProgressLayer, { progress: store } as never))
    })
    return { host, dispose: () => { act(() => { root?.unmount() }); host.remove() } }
  }

  it('没有切换时什么都不画', () => {
    const { host, dispose } = paint(createSwitchProgressStore())
    expect(host.textContent).toBe('')
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    dispose()
  })

  it('切换中写出阶段与目标会话', () => {
    const store = createSwitchProgressStore()
    const { host, dispose } = paint(store)
    act(() => { store.actions.begin({ sessionId: 'session-new', target: 'acp-claude' }) })
    expect(host.textContent).toContain('acp-claude')
    expect(host.querySelectorAll('[role="progressbar"]').length).toBeGreaterThan(0)
    dispose()
  })

  it('结束后不再画', () => {
    const store = createSwitchProgressStore()
    const { host, dispose } = paint(store)
    act(() => {
      store.actions.begin({ sessionId: 'session-new', target: 'acp-claude' })
      store.actions.finish()
    })
    expect(host.textContent).toBe('')
    dispose()
  })
})