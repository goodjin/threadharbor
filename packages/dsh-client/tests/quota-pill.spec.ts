/**
 * GLM 套餐配额胶囊：取数轮询器、路由取数器、胶囊渲染与 dock 注册。
 *
 * 轮询器只吃注入的 fetchQuota 与定时器（不碰真网络真 window）；渲染用
 * renderToString 断言用户可见的文本/悬停/变色；注册用最小假 slots 捕获
 * options 表。全部走 zh 词典的 t，钉住「文案进词典」的约定。
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

// ui-primitives 走 CSS modules 入口，node 测试环境载不动；胶囊文本/悬停/
// 变色不靠图标决定，整包 mock 成桩（与 composer-model-select.spec 同款）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconGaugeOutlineRegular: () => null,
  IconDatabaseOutlineRegular: () => null,
}))

const {
  QUOTA_DOCK_ID,
  QUOTA_DOCK_ORDER,
  QUOTA_ROUTE_PATH,
  QuotaPillRow,
  createQuotaPoller,
  registerQuotaDockPills,
  routeQuotaFetcher,
} = await import('../src/quota-pill.ts')
const { zh } = await import('../src/locales.ts')

function zhT(key: string, params?: Record<string, unknown>): string {
  const raw = zh[key as keyof typeof zh]
  if (raw === undefined) throw new Error(`missing zh key: ${key}`)
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** 与宿主接口应答同形的两个窗口。 */
const WINDOWS = {
  level: 'max',
  fiveHour: { kind: 'five-hour', used: 98, total: 28000, percent: 1, resetAt: Date.UTC(2026, 9, 16, 6, 30) },
  weekly: { kind: 'weekly', used: 66064, total: 140000, percent: 47, resetAt: Date.UTC(2026, 9, 22, 6, 30) },
} as const

/** 一份「当前选中的是 GLM」的目录快照。 */
const GLM_DIRECTORY = { current: { provider: 'acp:acp-zcode', model: 'GLM-5.3' }, groups: [] }
const OTHER_DIRECTORY = { current: { provider: 'deepseek', model: 'deepseek-chat' }, groups: [] }

/** 用给定模型与配额渲染胶囊行，返回 HTML。 */
function html(options: { directory?: unknown; quota?: unknown } = {}): string {
  return renderToString(createElement(QuotaPillRow, {
    useModelDirectory: () => options.directory as never,
    useQuota: () => options.quota as never,
    t: zhT,
  }))
}

describe('createQuotaPoller（轮询器）', () => {
  it('刷新成功后快照就位并通知订阅者；内容不变时引用不变', async () => {
    const listeners = new Set<() => void>()
    const notified = vi.fn()
    const fetchQuota = vi.fn(async () => ({ ok: true as const, quota: WINDOWS }))
    const poller = createQuotaPoller({ fetchQuota })
    poller.subscribe(notified)
    expect(poller.getSnapshot()).toBeUndefined()
    await poller.refresh()
    expect(poller.getSnapshot()).toEqual(WINDOWS)
    expect(notified).toHaveBeenCalledTimes(1)
    await poller.refresh()
    expect(poller.getSnapshot()).toBe(WINDOWS as never)
    expect(notified).toHaveBeenCalledTimes(1)
    expect(fetchQuota).toHaveBeenCalledTimes(2)
  })

  it('失败清空快照并报原因；同一原因只报一次，原因变了再报', async () => {
    const report = vi.fn()
    const answers: Array<{ ok: true; quota: typeof WINDOWS } | { ok: false; error: string }> = [
      { ok: true, quota: WINDOWS },
      { ok: false, error: 'no coding-plan api key' },
      { ok: false, error: 'no coding-plan api key' },
      { ok: false, error: 'HTTP 502' },
    ]
    const poller = createQuotaPoller({ fetchQuota: async () => answers.shift()!, report })
    await poller.refresh()
    expect(poller.getSnapshot()).toBeDefined()
    await poller.refresh()
    expect(poller.getSnapshot()).toBeUndefined()
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('no coding-plan api key')
    await poller.refresh()
    expect(report).toHaveBeenCalledTimes(1)
    await poller.refresh()
    expect(report).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenLastCalledWith('HTTP 502')
  })

  it('到点触发重新拉取；dispose 清掉定时器', async () => {
    const handlers: Array<() => void> = []
    const handles: number[] = []
    const cleared: unknown[] = []
    const fetchQuota = vi.fn(async () => ({ ok: true as const, quota: WINDOWS }))
    const poller = createQuotaPoller({
      fetchQuota,
      intervalMs: 300_000,
      setInterval: (handler: () => void) => {
        handlers.push(handler)
        const handle = handles.length + 1
        handles.push(handle)
        return handle
      },
      clearInterval: (handle: unknown) => { cleared.push(handle) },
    })
    poller.start()
    expect(handlers).toHaveLength(1)
    handlers[0]!()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchQuota).toHaveBeenCalled()
    poller.dispose()
    expect(cleared).toEqual(handles)
  })
})

describe('routeQuotaFetcher（路由取数器）', () => {
  it('把 200 的 ok 应答折成配额，ok:false 折成原因', async () => {
    const fetcher = routeQuotaFetcher(vi.fn(async () => new Response(
      JSON.stringify({ ok: true, quota: WINDOWS }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch)
    expect(await fetcher()).toEqual({ ok: true, quota: WINDOWS })
    const fetcher2 = routeQuotaFetcher(vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'no key' }), { status: 200 })) as unknown as typeof fetch)
    expect(await fetcher2()).toEqual({ ok: false, error: 'no key' })
  })

  it('非 JSON 应答与网络故障都折成 ok:false 的原因，绝不抛出', async () => {
    const textFetcher = routeQuotaFetcher(vi.fn(async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch)
    const textAnswer = await textFetcher()
    expect(textAnswer.ok).toBe(false)
    if (!textAnswer.ok) expect(textAnswer.error).toContain('401')
    const deadFetcher = routeQuotaFetcher(vi.fn(async () => { throw new Error('socket gone') }) as unknown as typeof fetch)
    const deadAnswer = await deadFetcher()
    expect(deadAnswer.ok).toBe(false)
    if (!deadAnswer.ok) expect(deadAnswer.error).toContain('socket gone')
  })
})

describe('QuotaPillRow（胶囊渲染）', () => {
  it('GLM 会话且配额就位：两枚胶囊，文本与悬停详情齐全', () => {
    const markup = html({ directory: GLM_DIRECTORY, quota: WINDOWS })
    expect(markup).toContain('data-zcode-quota')
    expect(markup).toContain('5小时')
    expect(markup).toContain('1%')
    expect(markup).toContain('周')
    expect(markup).toContain('47%')
    expect(markup).toContain('98 / 28000')
    expect(markup).toContain('66064 / 140000')
  })

  it('当前模型不是 GLM、或配额未就位：整行不渲染', () => {
    expect(html({ directory: OTHER_DIRECTORY, quota: WINDOWS })).toBe('')
    expect(html({ directory: GLM_DIRECTORY, quota: undefined })).toBe('')
    expect(html({ directory: undefined, quota: WINDOWS })).toBe('')
  })

  it('渲染器绑定的选择器钩子必须带选择器：空参调用不该把它打崩', () => {
    // 真机上 ui-renderer 把注入的 hooks 源绑成 (selector, isEqual) => S；
    // 不给选择器时 use-sync-external-store 会抛 "selector is not a function"。
    function boundHook<T>(read: () => T) {
      return (selector: (value: T) => unknown): unknown => {
        if (typeof selector !== 'function') throw new TypeError('selector is not a function')
        return selector(read())
      }
    }
    const markup = renderToString(createElement(QuotaPillRow, {
      useModelDirectory: boundHook(() => GLM_DIRECTORY) as never,
      useQuota: boundHook(() => WINDOWS) as never,
      t: zhT,
    }))
    expect(markup).toContain('data-zcode-quota')
  })

  it('用量过八成标红、过半标黄、其余常态', () => {
    const hot = html({
      directory: GLM_DIRECTORY,
      quota: { fiveHour: { kind: 'five-hour', used: 23000, total: 28000, percent: 82 } },
    })
    expect(hot).toContain('data-tone="danger"')
    const warm = html({
      directory: GLM_DIRECTORY,
      quota: { weekly: { kind: 'weekly', used: 80000, total: 140000, percent: 57 } },
    })
    expect(warm).toContain('data-tone="warn"')
    const cool = html({ directory: GLM_DIRECTORY, quota: WINDOWS })
    expect(cool).not.toContain('data-tone=')
  })
})

describe('registerQuotaDockPills（dock 注册）', () => {
  it('注册进 conversation.composer.dock：id、顺序、locale 齐全，hooks 带配额与目录', () => {
    const registrations: Array<Record<string, unknown>> = []
    const poller = createQuotaPoller({ fetchQuota: async () => ({ ok: true as const, quota: WINDOWS }) })
    const directoryStore = { subscribe: () => () => {}, getSnapshot: () => GLM_DIRECTORY }
    const slots = {
      inject: (key: string, callback: () => unknown): void => {
        expect(key).toBe('conversation.composer.dock')
        void callback()
      },
      register: (options: Record<string, unknown>): (() => void) => {
        registrations.push(options)
        return () => {}
      },
    }
    registerQuotaDockPills(slots as never, poller, {
      modelDirectories: { directoryFor: () => ({ store: directoryStore }) },
      sessions: { subagentAddress: () => undefined },
    })
    expect(registrations).toHaveLength(1)
    const options = registrations[0]!
    expect(options['name']).toBe('conversation.composer.dock')
    expect(options['id']).toBe(QUOTA_DOCK_ID)
    expect(options['order']).toBe(QUOTA_DOCK_ORDER)
    expect(options['locale']).toBe('threadharborClient')
    const face = (options['inject'] as (sessionId: string) => Record<string, unknown>)('session-1')
    expect(face['hooks']).toMatchObject({ zcodeQuota: poller, zcodeDirectory: directoryStore })
    expect(face['visible']).toBe(true)
  })

  it('子代理会话隐藏；目录服务缺席时不带目录钩子', () => {
    let captured: ((sessionId: string) => Record<string, unknown>) | undefined
    const slots = {
      inject: (_key: string, callback: () => unknown): void => { void callback() },
      register: (options: { inject?: (sessionId: string) => Record<string, unknown> }): (() => void) => {
        captured = options.inject
        return () => {}
      },
    }
    const poller = createQuotaPoller({ fetchQuota: async () => ({ ok: true as const, quota: WINDOWS }) })
    registerQuotaDockPills(slots as never, poller, {
      sessions: { subagentAddress: (id: string) => (id === 'session-sub' ? 'parent/agent' : undefined) },
    })
    expect(captured).toBeDefined()
    expect(captured!('session-sub')['visible']).toBe(false)
    expect(captured!('session-top')['visible']).toBe(true)
    expect(captured!('session-top')['hooks']).toEqual({ zcodeQuota: poller })
  })
})

describe('常量', () => {
  it('路由路径与宿主侧登记的一致', () => {
    expect(QUOTA_ROUTE_PATH).toBe('/threadharbor/zcode/quota')
  })
})
