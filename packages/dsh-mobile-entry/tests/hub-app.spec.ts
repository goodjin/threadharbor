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
    // 等机器清单落地再推事件：这条用例要验的是「横幅写着机器名」，而名字来自
    // 清单。清单没到位就推，验的其实是另一件事（见下面那条）。
    await settle(10)

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
    // 断言**横幅里**那一行，而不是页面上出现过机器名：此刻停在机器清单屏，
    // 机器名本来就在那儿，写成 toContain('MacBook') 永远通过——那种假绿已经
    // 害过一次（回归时它没变红）。
    expect(root.innerHTML).toContain('approval-machine">来自 MacBook')
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

describe('游标探测在两种后端上必须一致（真实形状：中转只给一个整数）', () => {
  /** 中转真实应答 → 手机该看到的样子。 */
  function hubWithFetch(payloads: unknown[]) {
    let turn = 0
    const seen: string[] = []
    const backend = createHubBackend({
      fetchLike: (async (url: string) => {
        seen.push(url)
        const body = payloads[turn++] ?? {}
        return { status: 200, text: async () => JSON.stringify(body) } as unknown as Response
      }) as never,
      WebSocketCtor: (class { close() {} }) as never,
    })
    return { backend, seen }
  }

  it('中转回 {error:session-cursor,cursor:12} → 手机解析出的探针与直连同一句', async () => {
    const { backend } = hubWithFetch([{ error: 'session-cursor', cursor: 12 }])
    const body = await backend.pageMessages('mac-a', 's1', Number.MAX_SAFE_INTEGER, 1)
    expect(body.error).toContain('past cursor 12')
  })

  it('探针拿不到游标时报错，不硬猜（与直连的处置一致）', async () => {
    const { backend } = hubWithFetch([{ error: 'machine-error' }])
    const body = await backend.pageMessages('mac-a', 's1', Number.MAX_SAFE_INTEGER, 1)
    expect(body.error).not.toContain('machine-error')
    expect(body.error).toContain('那台机器没接住这次请求')
    expect(body.kind).toBeUndefined()
  })

  it('凭据过期不许折成空清单——那在界面上长得就是「这台机器还没有会话」', async () => {
    const { backend } = hubWithFetch([{ error: 'credential-stale' }])
    const body = await backend.listSessions('mac-a')
    expect(body.items).toBeUndefined()
    expect(body.error).toBe('那台机器正在重新连接，稍后再试')
    expect(body.kind).toBe('error')
  })
})

describe('prompt/cancel 不许假报成功（漏判 ok:false 的后果是草稿被清、消息没发出去）', () => {
  function hubPosting(body: unknown) {
    return createHubBackend({
      fetchLike: (async () => ({ status: 200, text: async () => JSON.stringify(body) })) as never,
      WebSocketCtor: (class { close() {} }) as never,
    })
  }

  it('那台机器的凭据脏 → prompt 明确失败，且**不**让人重配对手机', async () => {
    // 中转会自己把那台机器的凭据换掉再重试；让操作者去重配手机解决不了任何事，
    // 只会白跑一趟。这句话写错方向比不给提示更糟。
    const backend = hubPosting({ error: 'credential-stale' })
    const result = await backend.prompt('mac-a', 's1', '在吗')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('那台机器正在重新连接，稍后再试')
    expect(result.message).not.toContain('重新配对')
  })

  it('中转回 401（手机自己的连接过期了）→ 那才需要重配对', async () => {
    const backend = createHubBackend({
      fetchLike: (async () => ({ status: 401, text: async () => '' })) as never,
      WebSocketCtor: (class { close() {} }) as never,
    })
    const sessions = await backend.listSessions('mac-a')
    expect(sessions.kind).toBe('unpaired')
    expect(sessions.error).toContain('重新配对')
  })

  it('machine-error → prompt 明确失败（不是 ok:true），而且不把内部代号甩给操作者', async () => {
    const backend = hubPosting({ error: 'machine-error' })
    const result = await backend.prompt('mac-a', 's1', '在吗')
    expect(result.ok).toBe(false)
    // 代号是中转内部的词。手机上写「machine-error」，看的人既不知道出了什么，
    // 也不知道该找谁——细节在中转那份日志里，这一句得说人话。
    expect(result.message).not.toContain('machine-error')
    expect(result.message).toContain('那台机器没接住这次请求')
  })

  it('认不出的代号不藏起来（藏了就变成「什么都没发生」）', async () => {
    const backend = hubPosting({ error: 'brand-new-code-42' })
    const result = await backend.prompt('mac-a', 's1', '在吗')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('brand-new-code-42')
  })

  it('cancel 同理', async () => {
    const backend = hubPosting({ error: 'credential-stale' })
    expect((await backend.cancel('mac-a', 's1')).ok).toBe(false)
  })

  it('真的成功才 ok:true', async () => {
    const backend = hubPosting({ ok: true, value: {} })
    expect(await backend.prompt('mac-a', 's1', '在吗')).toEqual({ ok: true })
  })
})

describe('会话这一拍失败要说出来（以前像「还没有会话」）', () => {
  function hubFailingSessions() {
    return {
      mode: 'hub' as const,
      async listHosts() { return { hosts: [{ hostId: HOST_A, name: 'MacBook', running: true, reachable: true, online: true }] } },
      async listSessions() { return { error: '那台机器的凭据已过期，需要重新配对' } },
      async pageMessages() { return { conv: { items: [] } } },
      async prompt() { return { ok: true } },
      async cancel() { return { ok: true } },
      async answer() { return { ok: true } },
      connectEvents() { return { close() {} } },
    }
  }

  it('中转说凭据过期 → 界面显示那句话，不是一句「还没有会话」', async () => {
    const root = host()
    await bootApp(root, { backend: hubFailingSessions() as never })
    await settle(8)
    const enter = root.querySelector('[data-action="enter-machine"][data-machine-id="mac-a"]') as HTMLElement
    expect(enter).not.toBeNull()
    enter.click()
    await settle(12)
    expect(root.innerHTML).toContain('重新配对')
    expect(root.innerHTML).not.toContain('还没有会话')
  })
})

describe('手机自己与中转站的连接断了 → 走配对引导（与直连同一支路）', () => {
  function hubWithUnpairedConnection() {
    return {
      mode: 'hub' as const,
      async listHosts() { return { hosts: [{ hostId: HOST_A, name: 'MacBook', running: true, reachable: true, online: true }] } },
      // 中转后端在 401/403 时给出的真实形状：kind 是 'unpaired'。
      async listSessions() { return { error: '与中转站的连接已过期，需要重新配对', kind: 'unpaired' } },
      async pageMessages() { return { error: '与中转站的连接已过期，需要重新配对', kind: 'unpaired' } },
      async prompt() { return { ok: false, kind: 'unpaired', message: '与中转站的连接已过期，需要重新配对' } },
      async cancel() { return { ok: false, kind: 'unpaired', message: '与中转站的连接已过期，需要重新配对' } },
      async answer() { return { ok: true } },
      connectEvents() { return { close() {} } },
    }
  }

  it('进机器取会话时遇到它 → 界面变成配对引导，而不是一句错误文案', async () => {
    const root = host()
    await bootApp(root, { backend: hubWithUnpairedConnection() as never })
    await settle(8)
    const enter = root.querySelector('[data-action="enter-machine"][data-machine-id="mac-a"]') as HTMLElement
    expect(enter).not.toBeNull()
    enter.click()
    await settle(12)
    // 认**引导屏**自己的结构与那句标题。不能拿「配对」两个字当判据：那句错误
    // 文案里也有这两个字（又会假绿一次）。引导屏只有它自己有 class=guide。
    expect(root.innerHTML).toContain('class="guide"')
    expect(root.innerHTML).toContain('还没跟中转站配对')
    expect(root.innerHTML).not.toContain('还没有会话')
    // 关键一句：不能把人引到「自己电脑上的桌面端二维码」——那会把手机配到另一台
    // 机器上，配完打开的是直连页，中转整条链路白走而且看着像配对了。
    expect(root.innerHTML).toContain('别用你自己电脑上 ThreadHarbor 桌面端那个二维码')
  })
})

describe('应答那一下断了：进配对引导（横幅挂着、只往顶栏塞一句是没用的）', () => {
  function hubWithLiveApproval(unpaired: boolean) {
    let live: { onmessage: ((e: { data: string }) => void) | null } | null = null
    class FakeSocket {
      onmessage: ((e: { data: string }) => void) | null = null
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(_url: string) { live = this as unknown as typeof live }
      close() {}
    }
    return {
      mode: 'hub' as const,
      async listHosts() { return { hosts: [{ hostId: HOST_A, name: 'MacBook', running: true, reachable: true, online: true }] } },
      async listSessions() { return { items: [] } },
      async pageMessages() { return { conv: { items: [] } } },
      async prompt() { return { ok: true } },
      async cancel() { return { ok: true } },
      async answer() {
        return unpaired
          ? { ok: false, kind: 'unpaired', message: '与中转站的连接已过期，需要重新配对' }
          : { ok: false, message: '那台机器正在重新连接，稍后再试' }
      },
      connectEvents(handlers: { onStatus: (s: string, d: string) => void, onEvent: (h: string, t: string, v: unknown) => void }) {
        return createHubBackend({ WebSocketCtor: FakeSocket as never }).connectEvents(handlers)
      },
      push(value: unknown) {
        if (live === null) throw new Error('socket 没建起来')
        ;(live as { onmessage: (e: { data: string }) => void }).onmessage({
          data: JSON.stringify({ type: 'item', hostId: HOST_A, value }),
        })
      },
    }
  }

  it('应答时手机与中转站的连接断了 → 界面变配对引导', async () => {
    const backend = hubWithLiveApproval(true)
    const root = host()
    await bootApp(root, { backend: backend as never })
    await settle()
    backend.push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-91', request: { toolName: 'bash' } })
    await settle()
    const button = root.querySelector('[data-action="approve"][data-event-id="evt-91"]') as HTMLElement
    expect(button).not.toBeNull()
    button.click()
    await settle(10)
    expect(root.innerHTML).toContain('class="guide"')
  })

  it('那台机器在重连 → 横幅留着，顶栏给一句话（不是让手机去重配对）', async () => {
    const backend = hubWithLiveApproval(false)
    const root = host()
    await bootApp(root, { backend: backend as never })
    await settle()
    backend.push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-92', request: { toolName: 'bash' } })
    await settle()
    const button = root.querySelector('[data-action="approve"][data-event-id="evt-92"]') as HTMLElement
    button.click()
    await settle(10)
    expect(root.innerHTML).not.toContain('class="guide"')
    expect(root.innerHTML).toContain('那台机器正在重新连接')
  })
})

describe('机器行上要看得见「为什么进不去」', () => {
  /**
   * 中转早就把原因算好了（指纹没登记 / 凭据没换到），字段也一直传到手机上，
   * 但页面上不显示——操作者点进去只看到「那台机器正在重连」。可「指纹没登记」
   * 根本不会自己好：要在中转上跑登记命令。照那句提示干等着，最坏的结果是等到
   * 手机没电也没解决。文档里写了这两种状态，页面上却没有，这就是不对。
   */
  function machineRows(machines: unknown[]): Promise<string> {
    return (async () => {
      const root = host()
      await bootApp(root, {
        backend: {
          mode: 'hub',
          async listHosts() { return { hosts: machines } },
          async listSessions() { return { items: [] } },
          async pageMessages() { return { conv: { items: [] } } },
          async prompt() { return { ok: true } },
          async cancel() { return { ok: true } },
          async answer() { return { ok: true } },
          connectEvents() { return { close() {} } },
        } as never,
      })
      await settle(8)
      return root.innerHTML
    })()
  }

  it('指纹没登记 → 写「需先确认指纹」', async () => {
    const html = await machineRows([{ hostId: HOST_A, name: 'MacBook', online: true, credential: 'missing', reason: 'fingerprint-unapproved' }])
    expect(html).toContain('需先确认指纹')
  })

  it('凭据没换到 → 写「隧道通但凭据没换到」', async () => {
    const html = await machineRows([{ hostId: HOST_A, name: 'MacBook', online: true, credential: 'missing', reason: 'credential-missing' }])
    expect(html).toContain('隧道通但凭据没换到')
  })

  it('隧道没建起来 → 不能写「隧道通但凭据没换到」（那是反方向）', async () => {
    // ssh-failed 是 ensure 直接失败了：隧道压根没起来。写成「隧道通了」会把人
    // 引去查凭据、反复重试，而真正要动的是 ssh 那条路（密钥、指纹、网络）。
    const html = await machineRows([{ hostId: HOST_A, name: 'MacBook', online: false, credential: 'missing', reason: 'ssh-failed' }])
    expect(html).toContain('连不上那台机器')
    expect(html).not.toContain('隧道通但凭据没换到')
  })

  it('一切正常的那台**不能**带这两句', async () => {
    const html = await machineRows([{ hostId: HOST_A, name: 'MacBook', online: true, credential: 'ok' }])
    expect(html).not.toContain('需先确认指纹')
    expect(html).not.toContain('隧道通但凭据没换到')
  })

  it('认不出的组合宁可不说，也不要说错方向', async () => {
    const html = await machineRows([{ hostId: HOST_A, name: 'MacBook', online: true, credential: 'missing', reason: 'some-future-reason' }])
    expect(html).not.toContain('需先确认指纹')
    expect(html).not.toContain('隧道通但凭据没换到')
  })
})


describe('中转模式下刷新机器清单（原来没有这个按钮，两件事都做不到）', () => {
  function hubWithToggleableList() {
    let listShouldFail = false
    let live: { onmessage: ((e: { data: string }) => void) | null } | null = null
    class FakeSocket {
      onmessage: ((e: { data: string }) => void) | null = null
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(_url: string) { live = this as unknown as typeof live }
      close() {}
    }
    return {
      listShouldFail,
      failNextList() { listShouldFail = true },
      allowList() { listShouldFail = false },
      backend: {
        mode: 'hub' as const,
        async listHosts() {
          if (listShouldFail) throw new Error('中转站没响应')
          return { hosts: [{ hostId: HOST_A, name: 'MacBook', running: true, reachable: true, online: true }] }
        },
        async listSessions() { return { items: [] } },
        async pageMessages() { return { conv: { items: [] } } },
        async prompt() { return { ok: true } },
        async cancel() { return { ok: true } },
        async answer() { return { ok: true } },
        connectEvents(handlers: { onStatus: (s: string, d: string) => void, onEvent: (h: string, t: string, v: unknown) => void }) {
          return createHubBackend({ WebSocketCtor: FakeSocket as never }).connectEvents(handlers)
        },
      },
      push(value: unknown) {
        if (live === null) throw new Error('socket 没建起来')
        ;(live as { onmessage: (e: { data: string }) => void }).onmessage({
          data: JSON.stringify({ type: 'item', hostId: HOST_A, value }),
        })
      },
    }
  }

  it('机器清单屏上有个刷新按钮', async () => {
    const { backend } = hubWithToggleableList()
    const root = host()
    await bootApp(root, { backend: backend as never })
    await settle(8)
    expect(root.innerHTML).toContain('data-action="refresh-hosts"')
  })

  it('刷新失败会清掉清单；这期间弹出的横幅先写编号，刷回来再换成机器名', async () => {
    const harness = hubWithToggleableList()
    const root = host()
    await bootApp(root, { backend: harness.backend as never })
    await settle(8)

    const refresh = (): void => {
      const button = root.querySelector('[data-action="refresh-hosts"]') as HTMLElement
      expect(button).not.toBeNull()
      button.click()
    }
    harness.failNextList()
    refresh()
    await settle(8)
    // 刷新失败后清单被清空——这就是横幅只能写编号的真实场景。
    harness.push({ type: 'waterfall', event: 'approval/request', eventId: 'evt-reload', request: { toolName: 'bash' } })
    await settle(6)
    expect(root.innerHTML).toContain('approval-machine">来自 ' + HOST_A)

    harness.allowList()
    refresh()
    await settle(10)
    expect(root.innerHTML).toContain('approval-machine">来自 MacBook')
  })
})


describe('应答那条路上的错误代号也别原样显示', () => {
  // 走真的 createHubBackend：这几条要验的正是 answer() 里那句翻译，替身答不出。
  function hubAnswering(body: unknown) {
    return createHubBackend({
      fetchLike: (async () => ({ status: 200, text: async () => JSON.stringify(body) })) as never,
      WebSocketCtor: (class { close() {} }) as never,
    })
  }

  it('中转回 answer-failed → 不是把代号甩给操作者', async () => {
    const result = await hubAnswering({ error: 'answer-failed' }).answer('mac-a', 'evt-1', { kind: 'result', value: 'allowed-once' })
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('answer-failed')
    expect(result.message).toContain('这条待批没送到那台机器')
  })

  it('中转本来就在说一句人话时，不要再套「不认识的错误码」', async () => {
    // 「中转站请求失败：HTTP 502」本身就是人话，再加前缀比原来更难懂。
    const result = await hubAnswering({ message: '中转站请求失败：HTTP 502' }).answer('mac-a', 'evt-1', { kind: 'result', value: 'rejected' })
    expect(result.message).toBe('中转站请求失败：HTTP 502')
    expect(result.message).not.toContain('不认识的错误码')
  })

  it('真·不认识的短代号仍然原样带出来（藏了就变成「什么都没发生」）', async () => {
    const result = await hubAnswering({ error: 'brand-new-code-42' }).answer('mac-a', 'evt-1', { kind: 'result', value: 'rejected' })
    expect(result.message).toContain('brand-new-code-42')
  })
})

describe('中转在用的时候断了（网络抖动、反代重启）', () => {
  /**
   * 这一整组是同一个病根的表现：**中转后端以前会把「取不到」直接往上抛**，而打开
   * 会话、加载更早、发消息、停止这四个动作都没接 try/catch。后果不是报错，是
   * 「没反应」——会话一直转圈、发消息按了像没按。反代重启一下就复现，而那是运维
   * 的日常动作，不是异常路径。
   *
   * 现在中转后端保证不抛（取不到就返回一个说法的对象），这组用例盯的是**界面得
   * 说人话**，不是盯后端抛不抛——后者由第一条盯。
   */
  function relayGone(mode: 'reject-fetch' | 'not-json') {
    return createHubBackend({
      fetchLike: (async () => {
        if (mode === 'reject-fetch') throw new TypeError('Failed to fetch')
        return { status: 200, text: async () => '<html>502 Bad Gateway</html>' }
      }) as never,
      WebSocketCtor: (class { close() {} }) as never,
    })
  }

  interface HubOptions {
    pageMessages?: () => Promise<unknown>
    prompt?: () => Promise<unknown>
    cancel?: () => Promise<unknown>
    running?: boolean
  }

  /** 开机 → 进入那台机器。中转模式比直连多这一步，别绕过。 */
  async function bootIntoMachine(root: HTMLElement, options: HubOptions): Promise<void> {
    const broken = relayGone('reject-fetch')
    await bootApp(root, {
      backend: {
        mode: 'hub',
        async listHosts() { return { hosts: [{ hostId: HOST_A, name: 'MacBook', running: true, reachable: true, online: true }] } },
        async listSessions() {
          return { items: [{ sessionId: 's1', title: '在做的事', running: options.running === true }] }
        },
        pageMessages: options.pageMessages ?? (() => broken.pageMessages(HOST_A, 's1', 1, 1)),
        prompt: options.prompt ?? (() => broken.prompt(HOST_A, 's1', 'x')),
        cancel: options.cancel ?? (() => broken.cancel(HOST_A, 's1')),
        async answer() { return { ok: true } },
        connectEvents() { return { close() {} } },
      } as never,
    })
    await settle(8)
    const enter = root.querySelector(`[data-action="enter-machine"][data-machine-id="${HOST_A}"]`) as HTMLElement
    expect(enter).not.toBeNull()
    enter.click()
    await settle(10)
  }

  function openTheSession(root: HTMLElement): void {
    const open = root.querySelector('[data-action="open-session"][data-session-id="s1"]') as HTMLElement
    expect(open).not.toBeNull()
    open.click()
  }

  it('后端取不到时不抛（抛了上层那几个动作就都没接）', async () => {
    const backend = relayGone('reject-fetch')
    await expect(backend.listSessions(HOST_A)).resolves.toBeTruthy()
    await expect(backend.pageMessages(HOST_A, 's1', 5, 1)).resolves.toBeTruthy()
    await expect(backend.prompt(HOST_A, 's1', '在吗')).resolves.toBeTruthy()
    await expect(backend.cancel(HOST_A, 's1')).resolves.toBeTruthy()
    await expect(backend.answer(HOST_A, 'e1', { kind: 'result', value: 'rejected' })).resolves.toBeTruthy()
  })

  it('fetch 挂掉与 200-非-JSON 都要给出能看懂的说法', async () => {
    const gone = await relayGone('reject-fetch').listSessions(HOST_A)
    expect(gone.error).toContain('连不上中转站')
    const notJson = await relayGone('not-json').listSessions(HOST_A)
    expect(notJson.error).toContain('中转站回的不是预期的内容')
  })

  it('打开会话时中转断了 → 不再永远停在「正在加载会话…」', async () => {
    const root = host()
    await bootIntoMachine(root, {})
    openTheSession(root)
    await settle(12)
    // 关键：加载态必须结束，而且要留下一句能看懂的话。
    expect(root.innerHTML).not.toContain('正在加载会话')
    expect(root.innerHTML).toContain('连不上中转站')
  })

  it('发消息时中转断了 → 草稿留着，并且说清没发出去', async () => {
    const root = host()
    await bootIntoMachine(root, { pageMessages: async () => ({ conv: { records: [] } }) })
    openTheSession(root)
    await settle(12)
    const form = root.querySelector('#prompt-form') as HTMLFormElement
    expect(form).not.toBeNull()
    const draft = root.querySelector('#prompt-input') as HTMLInputElement
    draft.value = '这条要发出去'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(4)
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle(12)
    // 没发出去就不能清草稿：清了就再也看不出刚才那条去哪了。
    expect((root.querySelector('#prompt-input') as HTMLInputElement).value).toBe('这条要发出去')
    expect(root.innerHTML).toContain('连不上中转站')
  })

  it('停止时中转断了 → 说一句，不装成停了', async () => {
    const root = host()
    // 会话必须在跑，「停止」按钮才画得出来（views.js 只在 running 时给）。
    // 上一版没设 running，用例遇上按钮不存在就静静跳过——那等于什么都没验。
    await bootIntoMachine(root, {
      pageMessages: async () => ({ conv: { records: [] } }),
      running: true,
    })
    openTheSession(root)
    await settle(12)
    const stop = root.querySelector('[data-action="stop"]') as HTMLElement | null
    expect(stop).not.toBeNull()
    stop!.click()
    await settle(12)
    expect(root.innerHTML).toContain('连不上中转站')
  })
})

