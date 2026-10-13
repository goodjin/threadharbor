import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBackoff,
  EVENTS_STREAM_ENDPOINT,
  EVENT_RESULT_ENDPOINT,
  MUX_PATH,
  MuxConnection,
  rpcCall,
  SESSION_CANCEL_ENDPOINT,
  SESSION_HISTORY_ENDPOINT,
  SESSION_LIST_ENDPOINT,
  SESSION_PROMPT_ENDPOINT,
} from '../mobile/wire.js'

/**
 * 手机页 wire 客户端（纯逻辑模块）的行为测试。
 *
 * 协议形状全部来自 Task 6 的线上探针（docs/research/2026-10-15-mobile-wire.md）：
 * - RPC 信封：POST /api/<端点>，体 {type:'client-request', rpcId, method===端点,
 *   payload:{args:{…}}}；应答 200 且 result.ok 二分，401→unpaired、403→untrusted。
 * - $events 订阅：WS open 帧 payload 恰为 {args:{}}，首帧 ready 带 clientId；
 *   waterfall 应答走 HTTP $events/result（不是 WS 客户帧），迟到应答是良性的。
 * - 断线重连：按 1s→2s→5s→10s 封顶退避，重连后重放订阅、ready 带新 clientId。
 *
 * 本文件的 fetch/WebSocket 全是注入替身；重连时序用 vitest 假计时器，不真等。
 */

/** 200 + server-response 形的 fetch 替身：记录调用，并回显请求里的 rpcId（宿主行为）。 */
function fetchEchoingResult(result: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchLike = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const request = JSON.parse(String(init.body)) as { rpcId: string }
    return new Response(
      JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { calls, fetchLike }
}

/** fake socket：真 WebSocket 的最小形状（契约见 wire.js 头注释）。 */
interface FakeSocket {
  sent: string[]
  closed: boolean
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((data: string) => void) | null
  onclose: (() => void) | null
}

/** socketFactory 替身：记录每次建连的 url，收集 socket 供测试手动驱动回调。 */
function socketHub() {
  const urls: string[] = []
  const sockets: FakeSocket[] = []
  const factory = (url: string | URL): FakeSocket => {
    urls.push(String(url))
    const socket: FakeSocket = {
      sent: [],
      closed: false,
      send(data: string) {
        socket.sent.push(data)
      },
      close() {
        socket.closed = true
        socket.onclose?.()
      },
      onopen: null,
      onmessage: null,
      onclose: null,
    }
    sockets.push(socket)
    return socket
  }
  return { urls, sockets, factory }
}

/** 从某条 socket 已发出的帧里找 open 帧，返回其 streamId（没有则断言失败）。 */
function openStreamId(socket: FakeSocket): string {
  const frames = socket.sent.map((data) => JSON.parse(data) as { type: string; streamId: string })
  const open = frames.find((frame) => frame.type === 'open')
  expect(open, '该 socket 尚未发出 open 帧').toBeDefined()
  return open!.streamId
}

/** $events 流上的 item 下行帧文本。 */
function itemFrame(streamId: string, value: unknown): string {
  return JSON.stringify({ type: 'item', streamId, value })
}

/** ready 帧（$events 订阅建立后的首项）。 */
function readyFrame(streamId: string, clientId: string): string {
  return itemFrame(streamId, { type: 'ready', clientId, host: { home: '/Users/good' } })
}

describe('wire 端点常量（Task 6 钉死值，静态页不能 import TS，靠这里防漂移）', () => {
  it('七个常量与 src/wire.ts 逐字一致', () => {
    expect(SESSION_LIST_ENDPOINT).toBe('session/list')
    expect(SESSION_HISTORY_ENDPOINT).toBe('session/page')
    expect(SESSION_PROMPT_ENDPOINT).toBe('session/prompt')
    expect(SESSION_CANCEL_ENDPOINT).toBe('session/cancel')
    expect(MUX_PATH).toBe('/api/remote.mux')
    expect(EVENTS_STREAM_ENDPOINT).toBe('$events')
    expect(EVENT_RESULT_ENDPOINT).toBe('$events/result')
  })
})

describe('rpcCall（RPC 信封与状态映射）', () => {
  it('POST /api/<端点>，信封为 client-request、method 与端点逐字相等、payload 包一层 args', async () => {
    const { calls, fetchLike } = fetchEchoingResult({ ok: true, value: { items: [] } })

    const outcome = await rpcCall(fetchLike, 'session/list', { _request: {} }, 'rpc-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/session/list')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'session/list',
      payload: { args: { _request: {} } },
    })
    expect(outcome).toEqual({ ok: true, result: { items: [] } })
  })

  it('rpcId 由调用方注入：同一端点两次调用各带各的 id，模块不自己造 id', async () => {
    const { calls, fetchLike } = fetchEchoingResult({ ok: true, value: {} })

    await rpcCall(fetchLike, 'session/page', { request: {} }, 'caller-a')
    await rpcCall(fetchLike, 'session/page', { request: {} }, 'caller-b')

    expect(JSON.parse(String(calls[0]!.init.body)).rpcId).toBe('caller-a')
    expect(JSON.parse(String(calls[1]!.init.body)).rpcId).toBe('caller-b')
  })

  it('200 且 result.ok=false → {ok:false,kind:"error"}，message 取宿主 error.message', async () => {
    const { fetchLike } = fetchEchoingResult({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'typert gateway: Remote event result identifies no active event stream',
        details: {},
      },
    })

    const outcome = await rpcCall(
      fetchLike,
      '$events/result',
      { clientId: 'c', eventId: 'e', outcome: { kind: 'next' } },
      'r',
    )

    expect(outcome).toEqual({
      ok: false,
      kind: 'error',
      message: 'typert gateway: Remote event result identifies no active event stream',
    })
  })

  it('401 → unpaired（未配对）、403 → untrusted（宿主未信任）、其余非 200 → error', async () => {
    const statusOnly = (status: number) => async () => new Response('denied', { status })

    expect(await rpcCall(statusOnly(401), 'session/list', {}, 'r'))
      .toMatchObject({ ok: false, kind: 'unpaired' })
    expect(await rpcCall(statusOnly(403), 'session/list', {}, 'r'))
      .toMatchObject({ ok: false, kind: 'untrusted' })

    const other = await rpcCall(statusOnly(500), 'session/list', {}, 'r')
    expect(other.ok).toBe(false)
    if (!other.ok) {
      expect(other.kind).toBe('error')
      expect(other.message).toContain('500')
    }
  })

  it('200 但响应体不是 server-response JSON → kind:"error"，不外抛', async () => {
    const fetchLike = async () => new Response('<html>gateway hiccup</html>', { status: 200 })

    const outcome = await rpcCall(fetchLike, 'session/list', {}, 'r')

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('error')
    }
  })

  it('传输层失败（fetch 拒绝）向上原样抛出，由调用方决定如何处置', async () => {
    const fetchLike = async () => {
      throw new Error('network gone')
    }

    await expect(rpcCall(fetchLike, 'session/list', {}, 'r')).rejects.toThrow('network gone')
  })
})

describe('createBackoff（断线重连退避序列）', () => {
  it('依次 1s、2s、5s，之后 10s 封顶；推进调用方持有的 attempts 计数', () => {
    const attempts = { count: 0 }
    const backoff = createBackoff(attempts)

    expect([
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
    ]).toEqual([1000, 2000, 5000, 10000, 10000])
    expect(attempts.count).toBe(5)
  })
})

describe('MuxConnection（$events 订阅、waterfall 应答与断线重连）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('构造即建连；socket open 后发出 $events 订阅 open 帧，payload 恰为 {args:{}}', () => {
    const hub = socketHub()
    const { fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const conn = new MuxConnection(() => 'ws://host.example/api/remote.mux', hub.factory, fetchLike)

    expect(hub.urls).toEqual(['ws://host.example/api/remote.mux'])
    expect(hub.sockets).toHaveLength(1)
    expect(hub.sockets[0]!.sent).toEqual([])

    hub.sockets[0]!.onopen!()

    expect(hub.sockets[0]!.sent).toHaveLength(1)
    expect(JSON.parse(hub.sockets[0]!.sent[0]!)).toEqual({
      type: 'open',
      streamId: expect.any(String),
      endpoint: '$events',
      payload: { args: {} },
    })
    conn.close()
  })

  it('ready 帧派发给 ready 监听器；waterfall 帧按 value.type 派发', () => {
    const hub = socketHub()
    const { fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const seen: unknown[] = []
    conn.onEvent('ready', (value) => seen.push(value))
    conn.onEvent('waterfall', (value) => seen.push(value))

    const socket = hub.sockets[0]!
    socket.onopen!()
    const streamId = openStreamId(socket)
    socket.onmessage!(readyFrame(streamId, 'client-1'))
    socket.onmessage!(itemFrame(streamId, {
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'evt-1',
      agentId: 'agent-1',
      request: { toolName: 'bash' },
    }))

    expect(seen).toEqual([
      { type: 'ready', clientId: 'client-1', host: { home: '/Users/good' } },
      {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'evt-1',
        agentId: 'agent-1',
        request: { toolName: 'bash' },
      },
    ])
    conn.close()
  })

  it('onEvent 返回退订函数，退订后不再收到派发', () => {
    const hub = socketHub()
    const { fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const seen: unknown[] = []
    const unsubscribe = conn.onEvent('ready', (value) => seen.push(value))

    unsubscribe()
    const socket = hub.sockets[0]!
    socket.onopen!()
    socket.onmessage!(readyFrame(openStreamId(socket), 'client-1'))

    expect(seen).toEqual([])
    conn.close()
  })

  it('answer 走 HTTP $events/result（不是 WS 客户帧），带上 ready 给的 clientId', async () => {
    const { calls, fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const socket = hub.sockets[0]!
    socket.onopen!()
    socket.onmessage!(readyFrame(openStreamId(socket), 'client-1'))

    const outcome = await conn.answer('evt-1', { kind: 'result', value: 'allowed-once' })

    expect(outcome).toEqual({ ok: true, result: {} })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/$events/result')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      type: 'client-request',
      rpcId: expect.any(String),
      method: '$events/result',
      payload: {
        args: {
          clientId: 'client-1',
          eventId: 'evt-1',
          outcome: { kind: 'result', value: 'allowed-once' },
        },
      },
    })
    expect(socket.sent).toHaveLength(1)
    conn.close()
  })

  it('未收到 ready（无 clientId）时 answer 不发请求，直接良性 error 结果', async () => {
    const { calls, fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)

    const outcome = await conn.answer('evt-1', { kind: 'next' })

    expect(outcome.ok).toBe(false)
    expect(calls).toHaveLength(0)
    conn.close()
  })

  it('迟到应答（宿主报 no active event stream）解析为 error-kind，不触发重连、连接保持', async () => {
    const { calls, fetchLike } = fetchEchoingResult({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'typert gateway: Remote event result identifies no active event stream',
        details: {},
      },
    })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const socket = hub.sockets[0]!
    socket.onopen!()
    socket.onmessage!(readyFrame(openStreamId(socket), 'client-1'))

    const outcome = await conn.answer('evt-gone', { kind: 'next' })

    expect(outcome).toEqual({
      ok: false,
      kind: 'error',
      message: expect.stringContaining('no active event stream'),
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    expect(hub.sockets).toHaveLength(1)
    expect(hub.sockets[0]!.closed).toBe(false)
    conn.close()
  })

  it('answer 的传输失败也解析为 error-kind（answer 从不 reject），连接不受影响', async () => {
    const fetchLike = async () => {
      throw new Error('network gone')
    }
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const socket = hub.sockets[0]!
    socket.onopen!()
    socket.onmessage!(readyFrame(openStreamId(socket), 'client-1'))

    const outcome = await conn.answer('evt-1', { kind: 'next' })

    expect(outcome.ok).toBe(false)
    expect(hub.sockets).toHaveLength(1)
    conn.close()
  })

  it('断线按 1s→2s 退避重连并重放订阅；ready 后退避计数归零、clientId 换新', async () => {
    const { calls, fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)

    const first = hub.sockets[0]!
    first.onopen!()
    const firstStreamId = openStreamId(first)
    first.onmessage!(readyFrame(firstStreamId, 'client-1'))

    // 断线：第一次退避 1s
    first.onclose!()
    await vi.advanceTimersByTimeAsync(999)
    expect(hub.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(hub.sockets).toHaveLength(2)

    // 重连的 socket 重放 $events 订阅，streamId 不复用
    const second = hub.sockets[1]!
    expect(hub.urls[1]).toBe('ws://h/api/remote.mux')
    second.onopen!()
    const secondOpen = JSON.parse(second.sent[0]!) as {
      endpoint: string
      payload: unknown
      streamId: string
    }
    expect(secondOpen.endpoint).toBe('$events')
    expect(secondOpen.payload).toEqual({ args: {} })
    expect(secondOpen.streamId).not.toBe(firstStreamId)

    // 未 ready 就再次断线：第二次退避 2s
    second.onclose!()
    await vi.advanceTimersByTimeAsync(1999)
    expect(hub.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(hub.sockets).toHaveLength(3)

    // ready 后退避归零：下次断线回到 1s，ready 带新 clientId
    const third = hub.sockets[2]!
    third.onopen!()
    third.onmessage!(readyFrame(openStreamId(third), 'client-2'))

    // answer 用的是当次连接 ready 给的 clientId（旧的不残留）；此时仍在线
    await conn.answer('evt-2', { kind: 'next' })
    expect(
      (JSON.parse(String(calls[0]!.init.body)) as { payload: { args: { clientId: string } } })
        .payload.args.clientId,
    ).toBe('client-2')

    third.onclose!()
    await vi.advanceTimersByTimeAsync(1000)
    expect(hub.sockets).toHaveLength(4)
    conn.close()
  })

  it('close() 关闭当前 socket 且不再重连（迟到的 close 事件也不触发）', async () => {
    const { fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const first = hub.sockets[0]!
    first.onopen!()
    first.onmessage!(readyFrame(openStreamId(first), 'client-1'))

    conn.close()
    expect(first.closed).toBe(true)
    first.onclose!()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(hub.sockets).toHaveLength(1)
  })

  it('close() 之后迟到的 open 事件不再发 open 帧（真 socket 上此时 send 会抛）', () => {
    const { fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)

    conn.close()
    expect(() => hub.sockets[0]!.onopen!()).not.toThrow()
    expect(hub.sockets[0]!.sent).toEqual([])
  })

  it('宿主 end 帧（$events 流被服务端半关闭）关闭 socket，走正常重连恢复订阅', async () => {
    const { fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const first = hub.sockets[0]!
    first.onopen!()
    first.onmessage!(readyFrame(openStreamId(first), 'client-1'))

    first.onmessage!(JSON.stringify({ type: 'end', streamId: openStreamId(first) }))

    expect(first.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(hub.sockets).toHaveLength(2)
    conn.close()
  })

  it('宿主 error 帧派发给 error 监听器（帧形源码钉死），连接保持不重连', async () => {
    const { fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const seen: unknown[] = []
    conn.onEvent('error', (value) => seen.push(value))
    const first = hub.sockets[0]!
    first.onopen!()

    first.onmessage!(JSON.stringify({
      type: 'error',
      streamId: openStreamId(first),
      error: { code: 'gateway/internal', message: 'boom', details: {} },
    }))

    expect(seen).toEqual([{ code: 'gateway/internal', message: 'boom', details: {} }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hub.sockets).toHaveLength(1)
    conn.close()
  })

  it('非 JSON 下行帧被忽略：不抛错、不派发、不重连', async () => {
    const { fetchLike } = fetchEchoingResult({ ok: true, value: {} })
    const hub = socketHub()
    const conn = new MuxConnection(() => 'ws://h/api/remote.mux', hub.factory, fetchLike)
    const seen: unknown[] = []
    conn.onEvent('ready', (value) => seen.push(value))
    const first = hub.sockets[0]!
    first.onopen!()

    expect(() => first.onmessage!('<<not json>>')).not.toThrow()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(seen).toEqual([])
    expect(hub.sockets).toHaveLength(1)
    conn.close()
  })
})
