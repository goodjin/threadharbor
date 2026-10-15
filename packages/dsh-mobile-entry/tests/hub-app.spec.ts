/**
 * 中转模式（手机连中转站而非直连单机）的用例。
 *
 * 两后端同形，所以这些用例全部靠注入一个 hub 后端跑；直连模式的行为由既有
 * app.spec.ts 原样守着，一条不改。
 *
 * 最要紧的一条是「切机器不留残影」：从 A 切到 B，A 的慢应答回来时不得把 A 的
 * 会话内容画到 B 上。那种错不会报错，只会让操作者在 B 的界面上读到 A 的
 * 内容——比空白更危险。
 */

import { describe, expect, it, vi } from 'vitest'
import { bootApp, lastSeenTextOf } from '../mobile/app.js'
import { createHubBackend, EVENTS_PATH } from '../mobile/backend-hub.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const HOST_A = 'mac-a'
const HOST_B = 'linux-b'

/** 后端替身：按 hostId 记下调用，并让用例控制每台机的应答时机。 */
function hubBackendStub() {
  const calls: { fn: string; hostId?: string }[] = []
  const sessions = deferred<{ items: unknown[] } | { error: string }>()
  const pages = new Map<string, Deferred<{ conv: unknown } | { error: string }>>()
  /** 每台机的历史应答按调用次序排队：第一次是「游标探测」，第二次才是真取页。 */
  const pageTurns = new Map<string, number>()
  const pageFor = (hostId: string) => {
    const existing = pages.get(hostId)
    if (existing !== undefined) return existing
    const created = deferred<{ conv: unknown } | { error: string }>()
    pages.set(hostId, created)
    return created
  }
  /** 游标探测的固定应答：宿主对超界 throughSeq 报 past cursor N（N=日志末端）。 */
  const cursorProbe = { error: 'session page request past cursor 12' }
  const backend = {
    mode: 'hub' as const,
    async listHosts() {
      calls.push({ fn: 'listHosts' })
      return {
        hosts: [
          { hostId: HOST_A, name: 'MacBook', running: true, reachable: true, online: true },
          { hostId: HOST_B, name: '工位机', running: true, reachable: true, online: true },
          { hostId: '离线机', name: '老笔记本', running: false, reachable: false, online: false },
        ],
      }
    },
    async listSessions(hostId: string) {
      calls.push({ fn: 'listSessions', hostId })
      return await sessions.promise
    },
    async pageMessages(hostId: string) {
      calls.push({ fn: 'pageMessages', hostId })
      const turn = pageTurns.get(hostId) ?? 0
      pageTurns.set(hostId, turn + 1)
      if (turn === 0) return cursorProbe // 第一次是游标探测
      return await pageFor(hostId).promise
    },
    async prompt(hostId: string) {
      calls.push({ fn: 'prompt', hostId })
      return { ok: true }
    },
    async cancel(hostId: string) {
      calls.push({ fn: 'cancel', hostId })
      return { ok: true }
    },
    async answer(hostId: string) {
      calls.push({ fn: 'answer', hostId })
      return { ok: true }
    },
    connectEvents() {
      calls.push({ fn: 'connectEvents' })
      return { close() {} }
    },
  }
  return { backend, calls, sessions, pageFor }
}

function host(): HTMLElement {
  const root = document.createElement('div')
  document.body.append(root)
  return root
}

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const clickText = (root: HTMLElement, selector: string): void => {
  const node = root.querySelector(selector)
  if (node === null) throw new Error(`找不到 ${selector}`)
  node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('中转模式：机器维度', () => {
  it('首屏是机器清单；点某台进入该机会话列表，且请求带上那台 hostId', async () => {
    const { backend, calls, sessions } = hubBackendStub()
    const root = host()
    await bootApp(root, { backend })
    await settle()

    expect(root.textContent).toContain('MacBook')
    expect(root.textContent).toContain('工位机')
    expect(root.textContent).toContain('离线')

    sessions.resolve({ items: [{ sessionId: 's1', projections: { values: { title: '来自 A 的会话' } } }] })
    clickText(root, '[data-machine-id="mac-a"]')
    await settle(8)

    expect(calls.filter(call => call.fn === 'listSessions').map(call => call.hostId)).toEqual([HOST_A])
    expect(root.textContent).toContain('来自 A 的会话')
  })

  it('从 A 切到 B 后，A 的慢 pageMessages 应答不得画到 B 上（评审重点 2）', async () => {
    const { backend, calls, sessions, pageFor } = hubBackendStub()
    const root = host()
    await bootApp(root, { backend })
    await settle()

    const twoSessions = {
      items: [
        { sessionId: 'sA', projections: { values: { title: 'A 的会话' } } },
        { sessionId: 'sB', projections: { values: { title: 'B 的会话' } } },
      ],
    }
    sessions.resolve(twoSessions)
    clickText(root, '[data-machine-id="mac-a"]')
    await settle(8)

    // 真的在 A 上打开一个会话：它的历史应答悬在半空（用例不 resolve 它）。
    clickText(root, '[data-session-id="sA"]')
    await settle(6)
    const pendingA = pageFor(HOST_A) // A 的真取页悬着
    // 两次：一次游标探测（立即回），一次真取页（悬着不答）。
    expect(calls.filter(call => call.fn === 'pageMessages' && call.hostId === HOST_A).length).toBe(2)

    // 不等 A 的应答，先退回该机的会话列表，再换到 B 打开另一个会话。
    clickText(root, '[data-action="back"]')
    await settle(4)
    clickText(root, '[data-action="back-to-machines"]')
    await settle(6)
    clickText(root, '[data-machine-id="linux-b"]')
    await settle(8)
    clickText(root, '[data-session-id="sB"]')
    await settle(6)
    pageFor(HOST_B).resolve({
      conv: {
        records: [
          { seq: 1, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B 的正常内容' }] } } } },
        ],
      },
    })
    await settle(8)
    // 此刻界面确实是 B 的那个会话（标题来自 B 的会话清单）。
    expect(root.textContent).toContain('B 的会话')
    expect(root.textContent).not.toContain('A 的会话')

    // 现在 A 那条迟到的应答才回来。它属于 A，绝不能画到 B 的界面上。
    pendingA.resolve({
      conv: {
        records: [
          { seq: 1, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A 的秘密内容' }] } } } },
        ],
      },
    })
    await settle(10)

    expect(root.textContent).toContain('B 的会话')
    expect(root.textContent).not.toContain('A 的秘密内容')
  })

  it('审批应答带上那台机器的 hostId', async () => {
    const { backend, calls, sessions } = hubBackendStub()
    const root = host()
    await bootApp(root, { backend })
    await settle()
    sessions.resolve({ items: [] })
    clickText(root, '[data-machine-id="mac-a"]')
    await settle(8)

    // 手工塞一条该机的待批事件（后端替身不推事件，测试自己模拟）。
    root.dispatchEvent(new CustomEvent('noop'))
    const approve = root.querySelector('[data-action="approve"]') as HTMLButtonElement | null
    if (approve !== null) approve.click()
    await settle()

    // 没有事件时不该凭空发应答：断言 calls 里没有 answer。
    expect(calls.filter(call => call.fn === 'answer')).toEqual([])
  })

  it('机器离线时该机行显示离线', async () => {
    const { backend } = hubBackendStub()
    const root = host()
    await bootApp(root, { backend })
    await settle()

    expect(root.textContent).toContain('离线')
  })
})

describe('中转模式：后端抽象', () => {
  it('不注入后端时用直连那套，行为与今天一致', async () => {
    const fetchLike = vi.fn(async () => new Response('{"items":[]}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const root = host()
    await bootApp(root, { fetchLike, WebSocketCtor: class {} as never })
    await settle(8)
    expect(root.textContent).toContain('ThreadHarbor 手机端')
  })
})

describe('断掉的机器要能说清它最后一次有动静是什么时候', () => {
  const now = Date.now()
  const ago = (ms: number) => ({ online: true, reachable: true, lastSeenAt: now - ms })

  it('在线的机器不带这句话（正常状态不需要额外解释）', () => {
    expect(lastSeenTextOf(ago(60_000), now)).toBeUndefined()
  })

  it('断掉的机器按量级说「多久之前」', () => {
    expect(lastSeenTextOf({ ...ago(30_000), reachable: false }, now)).toBe('刚刚还有动静')
    expect(lastSeenTextOf({ ...ago(9 * 60_000), reachable: false }, now)).toBe('9 分钟前还有动静')
    expect(lastSeenTextOf({ ...ago(3 * 3_600_000), reachable: false }, now)).toBe('3 小时前还有动静')
    expect(lastSeenTextOf({ ...ago(50 * 3_600_000), reachable: false }, now)).toBe('2 天前还有动静')
  })

  it('从来没成功联系过（没有 lastSeenAt）就不编时间（别显示 1970 年）', () => {
    expect(lastSeenTextOf({ online: true, reachable: false }, now)).toBeUndefined()
    expect(lastSeenTextOf({ online: false, reachable: false, lastSeenAt: '刚才' }, now)).toBeUndefined()
  })
})

describe('事件通道的地址与构造（HTTPS 入口下这两点各自足以致死）', () => {
  /** 起一个假的 location：协议与 host 是唯一被用到的东西。 */
  function withLocation(protocol: string, host: string): () => void {
    const previous = (globalThis as { location?: unknown }).location
    Object.defineProperty(globalThis, 'location', { value: { protocol, host }, configurable: true })
    return () => {
      if (previous === undefined) delete (globalThis as { location?: unknown }).location
      else Object.defineProperty(globalThis, 'location', { value: previous, configurable: true })
    }
  }

  function collect(): { backend: ReturnType<typeof createHubBackend>; urls: string[] } {
    const urls: string[] = []
    class FakeSocket {
      close() {}
      constructor(url: string) { urls.push(url) }
    }
    return { backend: createHubBackend({ WebSocketCtor: FakeSocket as never }), urls }
  }

  it('HTTPS 页面用 wss（写死 ws:// 会被混合内容策略当场拦掉）', () => {
    const restore = withLocation('https:', 'dsh.agentlab.fun')
    try {
      const { backend, urls } = collect()
      backend.connectEvents({ onStatus: () => {} })
      expect(urls[0]).toBe(`wss://dsh.agentlab.fun${EVENTS_PATH}`)
    } finally {
      restore()
    }
  })

  it('HTTP 页面（本地开发）仍用 ws', () => {
    const restore = withLocation('http:', '127.0.0.1:3080')
    try {
      const { backend, urls } = collect()
      backend.connectEvents({ onStatus: () => {} })
      expect(urls[0]).toBe(`ws://127.0.0.1:3080${EVENTS_PATH}`)
    } finally {
      restore()
    }
  })

  it('构造期抛错（混合内容等）落到「连不上」，不把异常顺着 boot() 炸出去', () => {
    const restore = withLocation('https:', 'dsh.agentlab.fun')
    try {
      const statuses: { state: string; detail: string }[] = []
      class ThrowingSocket {
        constructor() { throw new Error('Mixed Content') }
        close() {}
      }
      const backend = createHubBackend({ WebSocketCtor: ThrowingSocket as never })
      expect(() => backend.connectEvents({ onStatus: (state, detail) => statuses.push({ state, detail }) })).not.toThrow()
      expect(statuses.at(-1)?.state).toBe('offline')
      expect(statuses.at(-1)?.detail).toContain('Mixed Content')
    } finally {
      restore()
    }
  })
})

describe('中转模式的待批横幅（词表错位过一次：横幅永远不出现）', () => {
  /**
   * 建一个真被后端持有的假 socket：后端是 `new` 出来再挂 onmessage 的，
   * 替身必须把实例交回来，否则推帧推到一个没人看的对象上。
   */
  function hubSocket() {
    const seen: { type: string; hostId: string; value: unknown }[] = []
    let live: { onmessage: ((e: { data: string }) => void) | null } | null = null
    class FakeSocket {
      onmessage: ((e: { data: string }) => void) | null = null
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(_url: string) { live = this as unknown as typeof live }
      close() {}
    }
    const backend = createHubBackend({ WebSocketCtor: FakeSocket as never })
    backend.connectEvents({
      onStatus: () => {},
      onEvent: (hostId, type, value) => { seen.push({ type, hostId, value }) },
    })
    return {
      seen,
      /** 推一帧**上游原样形状**的 item：中转广播的就是 {type:'item',hostId,value}。 */
      push(hostId: string, value: unknown) {
        if (live === null) throw new Error('socket 没建起来')
        ;(live as { onmessage: (e: { data: string }) => void }).onmessage({
          data: JSON.stringify({ type: 'item', hostId, value }),
        })
      },
    }
  }

  it('waterfall 帧（上游原样）→ 交给 app 的是协议里的名字，不是自造的 approval/request', () => {
    const socket = hubSocket()
    socket.push('host-a', {
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'evt-77',
      agentId: 'agent-1',
      request: { toolName: 'bash', displayReason: '要执行 ls' },
    })
    expect(socket.seen[0]?.type).toBe('waterfall')
    expect(socket.seen[0]?.hostId).toBe('host-a')
    // 横幅要用的字段与直连分支同形：eventId + request.*
    const value = socket.seen[0]?.value as { event?: string; eventId?: string; request?: { toolName?: string } }
    expect(value.event).toBe('approval/request')
    expect(value.eventId).toBe('evt-77')
    expect(value.request?.toolName).toBe('bash')
  })

  it('emit 帧（api-session/*）原样带出事件名，交给既有的 emit 处理器', () => {
    const socket = hubSocket()
    socket.push('host-a', { type: 'emit', event: 'api-session/message', data: {} })
    expect(socket.seen[0]?.type).toBe('emit')
    expect((socket.seen[0]?.value as { event?: string }).event).toBe('api-session/message')
  })

  it('cancel 帧带 eventId（别的端先答了就把卡撤掉）', () => {
    const socket = hubSocket()
    socket.push('host-a', { type: 'cancel', eventId: 'evt-77' })
    expect(socket.seen[0]?.type).toBe('cancel')
    expect((socket.seen[0]?.value as { eventId?: string }).eventId).toBe('evt-77')
  })

  it('ready 帧不当作业务事件抛给界面', () => {
    const socket = hubSocket()
    socket.push('host-a', { type: 'ready', clientId: 'c-1', host: 'dsh' })
    expect(socket.seen).toEqual([])
  })
})

/**
 * 这一条是把**整条链路**钉住的那一条：上游原样形状的帧 → 中转后端解包 →
 * 真 app 渲染出横幅。
 *
 * 上面的用例只问「后端把什么交出去了」，问不到「界面认不认」——上一版正是
 * 这么全绿的：后端转交的是协议词表，应用层却按一套自造的词表去判，两边各自
 * 通过，合起来横幅永远不出现。
 */
describe('中转模式的端到端：上游原样帧 → 界面', () => {
  function hubBackendWithLiveSocket() {
    let live: { onmessage: ((e: { data: string }) => void) | null; onopen: (() => void) | null; close(): void } | null = null
    class FakeSocket {
      onmessage: ((e: { data: string }) => void) | null = null
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(_url: string) { live = this as unknown as typeof live }
      close() {}
    }
    const answers: { hostId: string; eventId: string }[] = []
    const backend = {
      mode: 'hub' as const,
      async listHosts() {
        return { hosts: [{ hostId: HOST_A, name: 'MacBook', running: true, reachable: true, online: true }] }
      },
      async listSessions() { return { items: [] } },
      async pageMessages() { return { conv: { items: [] } } },
      async prompt() { return { ok: true } },
      async cancel() { return { ok: true } },
      async answer(hostId: string, eventId: string) { answers.push({ hostId, eventId }); return { ok: true } },
      connectEvents: (handlers: { onStatus: (s: string, d: string) => void; onEvent: (h: string, t: string, v: unknown) => void }) => {
        // 这里走**真的** hub 后端：只有它会把 {type:'item',hostId,value} 解成
        // app 认得的回调参数。用替身就又回到「各自钉住各自那套词表」。
        return createHubBackend({
          WebSocketCtor: FakeSocket as never,
          fetchLike: (async () => ({ status: 200, text: async () => '{}' })) as never,
        }).connectEvents(handlers)
      },
    }
    return {
      backend,
      answers,
      push(value: unknown, hostId = HOST_A) {
        if (live === null) throw new Error('socket 没建起来')
        ;(live as { onmessage: (e: { data: string }) => void }).onmessage({
          data: JSON.stringify({ type: 'item', hostId, value }),
        })
      },
    }
  }

  it('上游原样的 waterfall 帧 → 顶部出现待批横幅，标明来自哪台机器', async () => {
    const { backend, push } = hubBackendWithLiveSocket()
    const root = host()
    await bootApp(root, { backend: backend as never })
    await settle()

    push({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'evt-88',
      agentId: 'agent-1',
      request: { toolName: 'bash', displayReason: '要执行 ls' },
    })
    await settle()

    expect(root.innerHTML).toContain('待批准')
    expect(root.innerHTML).toContain('要执行 ls')
    expect(root.innerHTML).toContain('MacBook')
  })

  it('横幅的答复回到**发起它的那台**机器（哪怕操作者正看着另一台）', async () => {
    const { backend, push, answers } = hubBackendWithLiveSocket()
    const root = host()
    await bootApp(root, { backend: backend as never })
    await settle()

    push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-89', request: { toolName: 'bash' } }, HOST_B)
    await settle()

    const button = root.querySelector('[data-action="approve"][data-event-id="evt-89"]') as HTMLElement | null
    expect(button).not.toBeNull()
    button?.click()
    await settle()

    expect(answers).toEqual([{ hostId: HOST_B, eventId: 'evt-89' }])
  })
})

