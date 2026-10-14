import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachineClient, type WireSocket } from '../src/machine-client.ts'
import {
  EVENT_RESULT_ENDPOINT,
  EVENTS_STREAM_ENDPOINT,
  MUX_PATH,
  SESSION_CANCEL_ENDPOINT,
  SESSION_HISTORY_ENDPOINT,
  SESSION_LIST_ENDPOINT,
  SESSION_PROMPT_ENDPOINT,
} from '../src/wire.ts'

/**
 * 单机客户端用例：对一台机器 DSH 的带 cookie RPC（HTTP）与 $events 事件流
 * （WS 订阅 + 退避重连）。协议形状全部来自阶段 0 真机实测
 * （docs/research/2026-10-16-relay-spike.md）与手机页线上探针
 * （packages/dsh-mobile-entry/src/wire.ts 的同款常量），用例逐字钉住。
 *
 * 测试替身：WS 用假 socket 走 openSocket 注入点（不在单测里真连服务器，
 * 默认的 ws 适配器由阶段 0 探针的 check.wsMuxReady 真机验证过）；HTTP 用
 * fetch 假件（credentials.spec.ts 同款）。cookie 用 canary 常量，所有失败
 * 路径的返回文本都要过 expectNoSecrets 扫描——cookie 只允许出现在发给
 * openSocket / fetch 的头部实参里，绝不允许出现在任何错误文本里。
 */

const ORIGIN = 'http://127.0.0.1:41011'
/** cookie 名带每实例随机后缀（阶段 0 实测），值用 canary 便于扫描泄漏。 */
const COOKIE_NAME = 'dsh-auth-vEq2NloGx0VO3K1YJUG3Py20ZyCaokxDweB3K6Dx2pA'
const COOKIE_VALUE = 'canary-cookie-value-abcdefgh1234567890abcdefgh1234567890'
const COOKIE = `${COOKIE_NAME}=${COOKIE_VALUE}`

const cookieOk = (): Promise<{ ok: true; cookie: string } | { ok: false; reason: string }> =>
  Promise.resolve({ ok: true, cookie: COOKIE })
const cookieDead = (): Promise<{ ok: true; cookie: string } | { ok: false; reason: string }> =>
  Promise.resolve({ ok: false, reason: 'unreachable' })

/** 错误路径共用：返回值序列化后不得出现 cookie 值（纪律与凭据层同款）。 */
function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value)
  expect(text).toBeDefined()
  expect(text).not.toContain(COOKIE_VALUE)
  expect(text).not.toContain(COOKIE)
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

/** fetch 假件：按队列逐个应答，Error 项表示传输抛错；队列空了再请求就抛错让用例红。 */
function fetchFake(...responses: Array<Response | Error>): { calls: FetchCall[]; fetchLike: typeof fetch } {
  const calls: FetchCall[] = []
  const fetchLike: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    const next = responses.shift()
    if (next === undefined) throw new Error('假件队列已空，不该再发请求')
    if (next instanceof Error) throw next
    return next
  }
  return { calls, fetchLike }
}

/** 最小应答假件：本客户端只读 status 与 text()。 */
function jsonResponse(status: number, body: unknown): Response {
  return { status, text: async () => JSON.stringify(body) } as unknown as Response
}

/**
 * 假 socket：遵守注入契约——构造期间不同步回调，三个回调只经测试驱动入口
 * （openFromServer/serverSends/drop）异步触发；与 mobile/wire.js 的
 * WireSocket 契约同形。
 */
class FakeSocket implements WireSocket {
  readonly sent: string[] = []
  closeCount = 0
  onopen: (() => void) | null = null
  onmessage: ((data: string) => void) | null = null
  onclose: (() => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closeCount += 1
  }

  /** 测试驱动：连接建立（模拟 ws 的 open）。 */
  openFromServer(): void {
    this.onopen?.()
  }

  /** 测试驱动：服务端来了一帧文本。 */
  serverSends(frame: unknown): void {
    this.onmessage?.(JSON.stringify(frame))
  }

  /** 测试驱动：连接断了（模拟 ws 的 close；error 之后必有 close，故无 onerror）。 */
  drop(): void {
    this.onclose?.()
  }
}

/** 开 socket 的注入桩：记录 (url, cookie) 实参，收口 socket 便于驱动。 */
function socketSpy(): { urls: string[]; cookies: string[]; sockets: FakeSocket[]; openSocket: (url: string, cookie: string) => FakeSocket } {
  const urls: string[] = []
  const cookies: string[] = []
  const sockets: FakeSocket[] = []
  return {
    urls,
    cookies,
    sockets,
    openSocket: (url, cookie) => {
      urls.push(url)
      cookies.push(cookie)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  }
}

/** 把 connect 触发的「取 cookie → 开 socket」微任务链跑完（假定时器不拦微任务）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** 某 socket 发出的帧（已解析）。 */
function sentFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map(raw => JSON.parse(raw) as Record<string, unknown>)
}

/** 该 socket 上的 open 帧；没有就抛错（用例红，而不是静默通过）。 */
function openFrameOf(socket: FakeSocket): Record<string, unknown> {
  const frame = sentFrames(socket).find(candidate => candidate['type'] === 'open')
  if (frame === undefined) throw new Error('该 socket 上没有发出 open 帧')
  return frame
}

/** 按该 socket 的 open 帧 streamId 造一条服务端下行 item 帧（服务端回帧带同 streamId）。 */
function itemFrame(socket: FakeSocket, value: unknown): Record<string, unknown> {
  return { type: 'item', streamId: openFrameOf(socket)['streamId'], value }
}

function readyValue(clientId: string): Record<string, unknown> {
  return { type: 'ready', clientId, host: { home: '/tmp/dsh' } }
}

describe('wire 常量（与手机页线上协议同值，注释互相指认 dsh-mobile-entry/src/wire.ts）', () => {
  it('七个常量逐字等于探针钉死的值', async () => {
    const wire = await import('../src/wire.ts')
    expect(wire.SESSION_LIST_ENDPOINT).toBe('session/list')
    expect(wire.SESSION_HISTORY_ENDPOINT).toBe('session/page')
    expect(wire.SESSION_PROMPT_ENDPOINT).toBe('session/prompt')
    expect(wire.SESSION_CANCEL_ENDPOINT).toBe('session/cancel')
    expect(wire.MUX_PATH).toBe('/api/remote.mux')
    expect(wire.EVENTS_STREAM_ENDPOINT).toBe('$events')
    expect(wire.EVENT_RESULT_ENDPOINT).toBe('$events/result')
  })
})

describe('MachineClient.call（带 cookie 的 RPC）', () => {
  it('① 请求逐字：POST <origin>/api/session/list，Cookie 头带整对 cookie，信封 {type, rpcId, method, payload:{args}} 且 args 透明转发', async () => {
    const { calls, fetchLike } = fetchFake(jsonResponse(200, { result: { ok: true, value: { items: [] } } }))
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike })
    const args = { _request: { cursor: 'abc' } }
    const result = await client.call(SESSION_LIST_ENDPOINT, args)
    expect(result).toEqual({ ok: true, value: { items: [] } })
    expect(args).toEqual({ _request: { cursor: 'abc' } }) // 入参未被改写（中转对参数透明转发）
    expect(calls).toHaveLength(1)
    const sent = calls[0]
    if (sent === undefined) throw new Error('unreachable')
    expect(new URL(sent.url).toString()).toBe(`${ORIGIN}/api/session/list`)
    expect(sent.init?.method).toBe('POST')
    const headers = new Headers(sent.init?.headers)
    expect(headers.get('cookie')).toBe(COOKIE)
    expect(headers.get('content-type')).toBe('application/json')
    const envelope = JSON.parse(String(sent.init?.body)) as Record<string, unknown>
    expect(envelope['type']).toBe('client-request')
    expect(typeof envelope['rpcId']).toBe('string')
    expect(String(envelope['rpcId']).length).toBeGreaterThan(0)
    expect(envelope['method']).toBe('session/list')
    expect(envelope['payload']).toEqual({ args: { _request: { cursor: 'abc' } } })
  })

  it('② HTTP 401 → {ok:false, kind:"unauthorized"}：本层只分类不换凭据不重试（判脏与重试一次的分工在上层转发面）', async () => {
    const { calls, fetchLike } = fetchFake(jsonResponse(401, 'unauthorized'))
    let cookieCalls = 0
    const getCookie = (): Promise<{ ok: true; cookie: string } | { ok: false; reason: string }> => {
      cookieCalls += 1
      return cookieOk()
    }
    const client = new MachineClient({ origin: ORIGIN, getCookie, fetchLike })
    const result = await client.call(SESSION_LIST_ENDPOINT, { _request: {} })
    if (result.ok) throw new Error('401 不该被当成成功')
    expect(result.kind).toBe('unauthorized')
    expect(calls).toHaveLength(1) // 没有自作主张的重试
    expect(cookieCalls).toBe(1) // 没有自作主张的重换凭据
    expectNoSecrets(result)
  })

  it('③ result.ok=false → {ok:false, kind:"rpc-error"}，消息带宿主原文', async () => {
    const { fetchLike } = fetchFake(
      jsonResponse(200, { result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: missing "_request"' } } }),
    )
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike })
    const result = await client.call(SESSION_LIST_ENDPOINT, {})
    expect(result).toEqual({ ok: false, kind: 'rpc-error', message: 'args fields do not match the descriptor: missing "_request"' })
    expectNoSecrets(result)
  })

  it('fetch 传输抛错 → {ok:false, kind:"transport"}（不抛、不外带原始错误文本）', async () => {
    const { fetchLike } = fetchFake(new Error('fetch failed for http://…'))
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike })
    const result = await client.call(SESSION_LIST_ENDPOINT, { _request: {} })
    if (result.ok) throw new Error('传输失败不该被当成成功')
    expect(result.kind).toBe('transport')
    expectNoSecrets(result)
  })

  it('getCookie 拿不到 cookie → {ok:false, kind:"transport"}，一次请求都不发', async () => {
    const { calls, fetchLike } = fetchFake(jsonResponse(200, { result: { ok: true, value: null } }))
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieDead, fetchLike })
    const result = await client.call(SESSION_LIST_ENDPOINT, { _request: {} })
    if (result.ok) throw new Error('取不到凭据不该被当成成功')
    expect(result.kind).toBe('transport')
    expect(calls).toHaveLength(0)
  })

  it('其余非 200（实测 401 之外只会是隧道/宿主侧故障）→ rpc-error，消息带 HTTP 状态', async () => {
    const { fetchLike } = fetchFake(jsonResponse(502, 'bad gateway'))
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike })
    const result = await client.call(SESSION_LIST_ENDPOINT, { _request: {} })
    if (result.ok) throw new Error('非 200 不该被当成成功')
    expect(result.kind).toBe('rpc-error')
    expect(result.message).toContain('502')
  })
})

describe('MachineClient 事件流（$events 订阅与审批应答）', () => {
  it('④ 假 socket 收 ready 帧后，answer 用该 clientId POST /api/$events/result，payload {args:{clientId,eventId,outcome}}', async () => {
    const { calls, fetchLike } = fetchFake(jsonResponse(200, { result: { ok: true, value: null } }))
    const { sockets, openSocket } = socketSpy()
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
    client.connect()
    await settle()
    const socket = sockets[0]
    if (socket === undefined) throw new Error('connect 后没有开 socket')
    socket.openFromServer()
    socket.serverSends(itemFrame(socket, readyValue('client-uuid-0001')))
    const outcome = { kind: 'result', value: 42 } as const
    const answer = await client.answer('evt-1', outcome)
    expect(answer).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    const sent = calls[0]
    if (sent === undefined) throw new Error('unreachable')
    expect(new URL(sent.url).toString()).toBe(`${ORIGIN}/api/${EVENT_RESULT_ENDPOINT}`)
    expect(sent.init?.method).toBe('POST')
    expect(new Headers(sent.init?.headers).get('cookie')).toBe(COOKIE)
    expect(JSON.parse(String(sent.init?.body))).toEqual({
      args: { clientId: 'client-uuid-0001', eventId: 'evt-1', outcome },
    })
  })

  it('⑥ answer 在 ready 之前调用：返回 {ok:false} 且不发请求（客户端身份未知，无法应答）', async () => {
    const { calls, fetchLike } = fetchFake(jsonResponse(200, { result: { ok: true, value: null } }))
    const { sockets, openSocket } = socketSpy()
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
    client.connect()
    await settle()
    const socket = sockets[0]
    if (socket === undefined) throw new Error('unreachable')
    socket.openFromServer() // 连上了但 ready 未到
    const answer = await client.answer('evt-1', { kind: 'next' })
    expect(answer.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expectNoSecrets(answer)
  })

  it('answer 永不 reject：传输抛错与宿主拒绝都折成 {ok:false, message}', async () => {
    const { calls, fetchLike } = fetchFake(
      new Error('tunnel down'),
      jsonResponse(200, { result: { ok: false, error: { message: 'unknown clientId' } } }),
    )
    const { sockets, openSocket } = socketSpy()
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
    client.connect()
    await settle()
    const socket = sockets[0]
    if (socket === undefined) throw new Error('unreachable')
    socket.openFromServer()
    socket.serverSends(itemFrame(socket, readyValue('client-uuid-0002')))
    const first = await client.answer('evt-2', { kind: 'next' })
    expect(first.ok).toBe(false)
    expect(typeof first.message).toBe('string')
    expectNoSecrets(first)
    const second = await client.answer('evt-3', { kind: 'rejected', error: '不需要了' })
    expect(second.ok).toBe(false)
    expect(second.message).toBe('unknown clientId')
    expect(calls).toHaveLength(2)
  })

  it('openSocket 收到 ws://<origin>/api/remote.mux 与整对 cookie（升级请求带 Cookie 头由适配器用该实参实现）', async () => {
    const { fetchLike } = fetchFake()
    const { urls, cookies, openSocket } = socketSpy()
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
    client.connect()
    await settle()
    expect(urls).toEqual([`ws://127.0.0.1:41011${MUX_PATH}`])
    expect(cookies).toEqual([COOKIE])
  })

  it('下行 item 帧按 value.type 派发、退订生效；mux error 帧派发为 "error" 事件', async () => {
    const { fetchLike } = fetchFake()
    const { sockets, openSocket } = socketSpy()
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
    const waterfall = vi.fn()
    const other = vi.fn()
    const onError = vi.fn()
    const off = client.onEvent('waterfall', waterfall)
    client.onEvent('waterfall', other)
    client.onEvent('error', onError)
    client.connect()
    await settle()
    const socket = sockets[0]
    if (socket === undefined) throw new Error('unreachable')
    socket.openFromServer()
    const event = { type: 'waterfall', eventId: 'evt-9', payload: { title: '审批' } }
    socket.serverSends(itemFrame(socket, event))
    expect(waterfall).toHaveBeenCalledWith(event)
    expect(other).toHaveBeenCalledWith(event)
    off()
    socket.serverSends(itemFrame(socket, { type: 'waterfall', eventId: 'evt-10' }))
    expect(waterfall).toHaveBeenCalledTimes(1) // 已退订
    expect(other).toHaveBeenCalledTimes(2)
    const errorBody = { code: 'gateway/internal', message: 'stream broke' }
    socket.serverSends({ type: 'error', streamId: openFrameOf(socket)['streamId'], error: errorBody })
    expect(onError).toHaveBeenCalledWith(errorBody)
  })

  it('别的 streamId 与非 JSON 帧被忽略：协议层不猜', async () => {
    const { fetchLike } = fetchFake()
    const { sockets, openSocket } = socketSpy()
    const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
    const listener = vi.fn()
    client.onEvent('waterfall', listener)
    client.connect()
    await settle()
    const socket = sockets[0]
    if (socket === undefined) throw new Error('unreachable')
    socket.openFromServer()
    socket.serverSends({ type: 'item', streamId: '别人的流', value: { type: 'waterfall' } })
    socket.onmessage?.('这不是 JSON')
    socket.serverSends({ type: 'item', streamId: openFrameOf(socket)['streamId'], value: { noType: true } })
    expect(listener).not.toHaveBeenCalled()
  })

  it('⑤ 断线按 1s→2s→5s→10s 封顶退避重连，每次重连重放 open 订阅帧（假定时器，不真等）', async () => {
    vi.useFakeTimers()
    try {
      const { fetchLike } = fetchFake()
      const { sockets, openSocket } = socketSpy()
      const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
      client.connect()
      await settle()
      expect(sockets).toHaveLength(1)
      const first = sockets[0]
      if (first === undefined) throw new Error('unreachable')
      first.openFromServer()
      expect(openFrameOf(first)).toEqual({
        type: 'open',
        streamId: expect.any(String),
        endpoint: EVENTS_STREAM_ENDPOINT,
        payload: { args: {} },
      })
      expect(String(openFrameOf(first)['streamId']).length).toBeGreaterThan(0)

      // 阶梯逐级断连验证：ready 稳定后的第一次断线从 1s 起步，未 ready 的断线
      // 逐级走 2s/5s，之后 10s 封顶不再抬升。
      first.serverSends(itemFrame(first, readyValue('client-ready-once')))
      first.drop()
      await vi.advanceTimersByTimeAsync(999)
      expect(sockets).toHaveLength(1) // 1s 未到不重连
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(2)
      const second = sockets[1]
      if (second === undefined) throw new Error('unreachable')
      second.openFromServer()
      // 重放订阅：新 socket 上要再发一帧同形 open（endpoint/payload 钉死）
      expect(openFrameOf(second)).toEqual({
        type: 'open',
        streamId: expect.any(String),
        endpoint: EVENTS_STREAM_ENDPOINT,
        payload: { args: {} },
      })
      // 断线后 clientId 被清：旧身份不能再应答
      const staleAnswer = await client.answer('evt-x', { kind: 'next' })
      expect(staleAnswer.ok).toBe(false)

      second.drop() // 未 ready 就断 → 下一步 2s
      await vi.advanceTimersByTimeAsync(1999)
      expect(sockets).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(3)
      const third = sockets[2]
      if (third === undefined) throw new Error('unreachable')
      third.openFromServer()
      third.drop() // → 5s
      await vi.advanceTimersByTimeAsync(4999)
      expect(sockets).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(4)
      const fourth = sockets[3]
      if (fourth === undefined) throw new Error('unreachable')
      fourth.openFromServer()
      fourth.drop() // → 10s（封顶）
      await vi.advanceTimersByTimeAsync(9999)
      expect(sockets).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(5)
      const fifth = sockets[4]
      if (fifth === undefined) throw new Error('unreachable')
      fifth.openFromServer()
      expect(openFrameOf(fifth)['endpoint']).toBe(EVENTS_STREAM_ENDPOINT) // 封顶段也重放订阅
      fifth.drop() // → 还是 10s
      await vi.advanceTimersByTimeAsync(9999)
      expect(sockets).toHaveLength(5)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(6)
      client.close()
      await settle()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ready 稳定后的断线退避归零：连续两条稳定连接都从 1s 起步', async () => {
    vi.useFakeTimers()
    try {
      const { fetchLike } = fetchFake()
      const { sockets, openSocket } = socketSpy()
      const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
      client.connect()
      await settle()
      const first = sockets[0]
      if (first === undefined) throw new Error('unreachable')
      first.openFromServer()
      first.serverSends(itemFrame(first, readyValue('client-a')))
      first.drop()
      await vi.advanceTimersByTimeAsync(1000)
      expect(sockets).toHaveLength(2)
      const second = sockets[1]
      if (second === undefined) throw new Error('unreachable')
      second.openFromServer()
      second.serverSends(itemFrame(second, readyValue('client-b')))
      second.drop()
      await vi.advanceTimersByTimeAsync(1000) // 若没归零这里要等 2s
      expect(sockets).toHaveLength(3)
      client.close()
      await settle()
    } finally {
      vi.useRealTimers()
    }
  })

  it('end 帧视为断线：客户端主动关 socket 并走退避重连', async () => {
    vi.useFakeTimers()
    try {
      const { fetchLike } = fetchFake()
      const { sockets, openSocket } = socketSpy()
      const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
      client.connect()
      await settle()
      const socket = sockets[0]
      if (socket === undefined) throw new Error('unreachable')
      socket.openFromServer()
      socket.serverSends({ type: 'end', streamId: openFrameOf(socket)['streamId'] })
      expect(socket.closeCount).toBe(1) // 客户端先发起关闭（真 ws 随后回调 onclose）
      socket.drop()
      await vi.advanceTimersByTimeAsync(1000)
      expect(sockets).toHaveLength(2) // end 之后按断线重连了
      client.close()
      await settle()
    } finally {
      vi.useRealTimers()
    }
  })

  it('close() 之后不再重连：挂起的重连定时器被清，旧 socket 的迟到事件被忽略', async () => {
    vi.useFakeTimers()
    try {
      const { fetchLike } = fetchFake()
      const { sockets, openSocket } = socketSpy()
      const client = new MachineClient({ origin: ORIGIN, getCookie: cookieOk, fetchLike, openSocket })
      const listener = vi.fn()
      client.onEvent('waterfall', listener)
      client.connect()
      await settle()
      const socket = sockets[0]
      if (socket === undefined) throw new Error('unreachable')
      socket.openFromServer()
      client.close()
      expect(socket.closeCount).toBe(1)
      socket.drop() // close 之后才到的 close 事件：不得触发重连
      socket.serverSends(itemFrame(socket, { type: 'waterfall', eventId: 'evt-late' }))
      await vi.advanceTimersByTimeAsync(30000)
      expect(sockets).toHaveLength(1)
      expect(listener).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('重连换 cookie：每次重连都现取 cookie（上层判脏换新后，新连接自动用新 cookie）', async () => {
    vi.useFakeTimers()
    try {
      const { fetchLike } = fetchFake()
      const { cookies, sockets, openSocket } = socketSpy()
      let round = 0
      const getCookie = (): Promise<{ ok: true; cookie: string } | { ok: false; reason: string }> => {
        round += 1
        return Promise.resolve({ ok: true, cookie: `dsh-auth-round${round}=v` })
      }
      const client = new MachineClient({ origin: ORIGIN, getCookie, fetchLike, openSocket })
      client.connect()
      await settle()
      const first = sockets[0]
      if (first === undefined) throw new Error('unreachable')
      first.openFromServer()
      first.drop()
      await vi.advanceTimersByTimeAsync(1000)
      expect(cookies).toEqual(['dsh-auth-round1=v', 'dsh-auth-round2=v'])
      client.close()
      await settle()
    } finally {
      vi.useRealTimers()
    }
  })
})
