/**
 * 手机页挂接层（mobile/app.js）的用例——jsdom 跑真 DOM。
 *
 * app.js 只做 DOM 挂接与编排，但这些挂接正是以前静默失败过的地方（挂了但
 * 页面空白、构造抛错逃进定时器回调），所以在这里跑真的 boot：
 * - 入口流程：先 rpcCall session/list 探测配对状态再渲染首页。401（unpaired
 *   类）渲染「重新扫码」引导（R2：没有 token-rejected 第三支），403
 *   （untrusted 类）渲染信任主机引导，传输失败渲染错误屏。
 * - 配对正常时首屏是主机清单，「会话」页签里是会话列表，点开会话经
 *   session/page 取最新页（游标探测 → 倒页）。
 * - carryover#3：WebSocket 构造失败绝不能外逃进 MuxConnection 的定时器回调
 *   ——工厂自己吞掉、返回立即断开的死 socket，退避重连继续，界面出现
 *   「未连接」状态。
 * - 交互：发消息（session/prompt）、停止（session/cancel）、待批横幅经
 *   MuxConnection.answer（HTTP $events/result）应答、cancel 帧撤卡。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootApp, makeSocketFactory, nextScrollTop, type SocketNotice } from '../mobile/app.js'

/** 最小 fetch 应答：rpcCall 只看 {status, text()}。 */
function jsonResponse(value: unknown, status = 200) {
  return { status, text: async () => JSON.stringify(value) }
}

interface RecordedCall { url: string, body?: string | undefined }

/** 手工控制兑现时机的应答（过期应答/在途应答用例用）。 */
function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolveOnce => {
    resolve = resolveOnce
  })
  return { promise, resolve }
}

type MinimalResponse = { status: number, text(): Promise<string> }

/** 从 session/page 请求体里取 address.sessionId 与 throughSeq。 */
function pageArgs(body: string | undefined): { sessionId?: string | undefined, throughSeq?: number | undefined } {
  const parsed = JSON.parse(body ?? '{}') as {
    payload?: { args?: { request?: { address?: { sessionId?: string }, throughSeq?: number } } }
  }
  return {
    sessionId: parsed.payload?.args?.request?.address?.sessionId,
    throughSeq: parsed.payload?.args?.request?.throughSeq,
  }
}

/** 一条单记录的 page 应答（游标探测应答见 pastCursorProbe）。 */
function pageResponse(text: string, seq: number, hasMore = false): MinimalResponse {
  return jsonResponse({
    result: {
      ok: true,
      value: {
        records: [
          { type: 'event', event: { type: 'user/message', seq, time: 1, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } } },
        ],
        hasMore,
      },
    },
  })
}

/** 游标探测的超界应答（宿主实录文案：… past cursor N）。 */
function pastCursorProbe(cursor: number): MinimalResponse {
  return jsonResponse({
    result: {
      ok: false,
      error: { code: 'gateway/bad-request', message: `session page through seq 9007199254740991 is past cursor ${cursor}`, details: {} },
    },
  })
}

/** 配对正常的探针应答：session/list 一条运行中会话；peers 一台在线 + DSH。 */
function pairedFetchLike(calls: RecordedCall[]) {
  return async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body })
    if (url === '/api/session/list') {
      return jsonResponse({
        result: {
          ok: true,
          value: {
            items: [{
              sessionId: 'session-ccc',
              updatedAt: 1791916709370,
              running: true,
              blank: false,
              agentAvailable: true,
            }],
          },
        },
      })
    }
    if (url === '/threadharbor/mobile/peers') {
      return jsonResponse({ peers: [{ dnsName: 'mac-a.ts.net', online: true, dsh: true }] })
    }
    if (url === '/api/session/page') {
      // 游标探测（throughSeq 超界）按宿主实录报「past cursor N」，N=17。
      const body = JSON.parse(init?.body ?? '{}') as { payload?: { args?: { request?: { throughSeq?: number } } } }
      const throughSeq = body.payload?.args?.request?.throughSeq ?? 0
      if (throughSeq > 17) {
        return jsonResponse({
          result: {
            ok: false,
            error: {
              code: 'gateway/bad-request',
              message: 'session page through seq 9007199254740991 is past cursor 17',
              details: {},
            },
          },
        })
      }
      return jsonResponse({
        result: {
          ok: true,
          value: {
            records: [
              { type: 'event', event: { type: 'user/message', seq: 16, time: 1, data: { content: [{ type: 'text', text: '手机上见' }], source: { kind: 'user' } } } },
              { type: 'event', event: { type: 'assistant/message', seq: 17, time: 2, data: { message: { content: [{ type: 'text', text: '好的' }] } } } },
            ],
            hasMore: true,
          },
        },
      })
    }
    if (url === '/api/$events/result' || url === '/api/session/prompt' || url === '/api/session/cancel') {
      return jsonResponse({ result: { ok: true, value: { accepted: true } } })
    }
    return { status: 404, text: async () => '' }
  }
}

/** 永远不 open 的假 WebSocket：boot 期只验构造与装配，不发帧。 */
class SilentWebSocket {
  static instances: SilentWebSocket[] = []
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((data: string) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    SilentWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
}

/** 构造即抛的 WebSocket：carryover#3 的陷阱本体。 */
class ThrowingWebSocket {
  constructor() {
    throw new Error('no ws endpoint')
  }
}

function makeRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

function click(root: ParentNode, selector: string): void {
  const target = root.querySelector(selector)
  if (target === null) throw new Error(`找不到 ${selector}（当前内容：${(root as HTMLElement).innerHTML.slice(0, 400)}）`)
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** 等 boot 之后的微任务/宏任务清空（会话打开、应答回执都是异步链）。 */
async function flushTasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

beforeEach(() => {
  SilentWebSocket.instances = []
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('bootApp 入口流程（先探测配对再渲染）', () => {
  it('探针 401（unpaired 类）→ 重新扫码引导：有二维码入口、有重新扫码（R2）', async () => {
    const root = makeRoot()
    await bootApp(root, { fetchLike: async () => ({ status: 401, text: async () => '' }) })
    expect(root.innerHTML).toContain('重新扫码')
    expect(root.innerHTML).toContain('二维码')
  })

  it('探针 403（untrusted 类）→ 信任主机引导：tailscale serve --trusted-host', async () => {
    const root = makeRoot()
    await bootApp(root, { fetchLike: async () => ({ status: 403, text: async () => '' }) })
    expect(root.innerHTML).toContain('信任')
    expect(root.innerHTML).toContain('tailscale serve')
  })

  it('探针传输失败 → 错误屏带原文与重试钩子，不白屏也不抛出', async () => {
    const root = makeRoot()
    await bootApp(root, {
      fetchLike: async () => {
        throw new Error('network down')
      },
    })
    expect(root.innerHTML).toContain('连不上主机')
    expect(root.innerHTML).toContain('network down')
    expect(root.innerHTML).toContain('data-action="retry-boot"')
  })

  it('探针 error 类（非 401/403）→ 错误屏而不是配对引导', async () => {
    const root = makeRoot()
    await bootApp(root, {
      fetchLike: async () => jsonResponse({ result: { ok: false, error: { code: 'gateway/internal', message: '宿主炸了', details: {} } } }),
    })
    expect(root.innerHTML).toContain('宿主炸了')
    expect(root.innerHTML).not.toContain('重新扫码')
  })

  it('配对正常：首屏主机清单（mac-a），「会话」页签里有会话条目', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    await bootApp(root, { fetchLike: pairedFetchLike(calls), WebSocketCtor: SilentWebSocket })
    expect(root.innerHTML).toContain('mac-a.ts.net')
    expect(root.innerHTML).toContain('data-tab="sessions"')
    expect(calls[0]?.url).toBe('/api/session/list')
    click(root, '[data-action="tab"][data-tab="sessions"]')
    expect(root.innerHTML).toContain('data-action="open-session"')
  })

  it('peers 拉取失败只影响清单区（显示不可用），主流程照常', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    const fetchLike = pairedFetchLike(calls)
    await bootApp(root, {
      fetchLike: async (url, init) => {
        if (url === '/threadharbor/mobile/peers') return { status: 500, text: async () => 'boom' }
        return fetchLike(url, init)
      },
      WebSocketCtor: SilentWebSocket,
    })
    expect(root.innerHTML).toContain('不可用')
    click(root, '[data-action="tab"][data-tab="sessions"]')
    expect(root.innerHTML).toContain('data-action="open-session"')
  })
})

describe('会话内容与交互', () => {
  it('点开会话：游标探测→倒页取最新页，消息渲染，运行中给停止，停止走 session/cancel', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    await bootApp(root, { fetchLike: pairedFetchLike(calls), WebSocketCtor: SilentWebSocket })
    click(root, '[data-action="tab"][data-tab="sessions"]')
    click(root, '[data-action="open-session"]')
    await flushTasks()

    const pageCalls = calls.filter(call => call.url === '/api/session/page')
    expect(pageCalls).toHaveLength(2)
    const probeSeq = (JSON.parse(pageCalls[0]!.body!) as { payload: { args: { request: { throughSeq: number } } } }).payload.args.request.throughSeq
    expect(probeSeq).toBeGreaterThan(17)
    const pageSeq = (JSON.parse(pageCalls[1]!.body!) as { payload: { args: { request: { throughSeq: number } } } }).payload.args.request.throughSeq
    expect(pageSeq).toBe(17)
    expect(root.innerHTML).toContain('手机上见')
    expect(root.innerHTML).toContain('好的')
    expect(root.innerHTML).toContain('加载更早')

    calls.length = 0
    click(root, '[data-action="stop"]')
    await flushTasks()
    expect(calls.some(call => call.url === '/api/session/cancel')).toBe(true)
  })

  it('发消息：session/prompt 带 queue 模式与文本 content，成功后清空输入框', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    await bootApp(root, { fetchLike: pairedFetchLike(calls), WebSocketCtor: SilentWebSocket })
    click(root, '[data-action="tab"][data-tab="sessions"]')
    click(root, '[data-action="open-session"]')
    await flushTasks()

    const input = root.querySelector('#prompt-input') as HTMLInputElement
    input.value = '从手机发的消息'
    root.querySelector('#prompt-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushTasks()

    const promptCall = calls.find(call => call.url === '/api/session/prompt')
    expect(promptCall).toBeDefined()
    const args = (JSON.parse(promptCall!.body!) as { payload: { args: { request: Record<string, unknown> } } }).payload.args.request
    expect(args.sessionId).toBe('session-ccc')
    expect(args.mode).toBe('queue')
    expect(args.content).toEqual([{ type: 'text', text: '从手机发的消息' }])
    expect(typeof args.requestId).toBe('string')
    expect((args.requestId as string).length).toBeGreaterThan(0)
    expect(typeof args.clientTimeZone).toBe('string')
    // 成功后清空的是 DOM 里现在的输入框（render 重建过节点）。
    expect((root.querySelector('#prompt-input') as HTMLInputElement).value).toBe('')
  })
})

describe('makeSocketFactory（carryover#3：构造失败不外逃）', () => {
  it('构造抛错时返回立即断开的死 socket，不向调用方抛；通知界面未连接', async () => {
    const notices: SocketNotice[] = []
    const factory = makeSocketFactory(notice => notices.push(notice), ThrowingWebSocket)
    expect(() => factory('ws://x/api/remote.mux')).not.toThrow()
    const socket = factory('ws://x/api/remote.mux')
    let closed = false
    socket.onclose = () => {
      closed = true
    }
    await Promise.resolve()
    expect(closed).toBe(true)
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.map(notice => notice.message).join()).toContain('no ws endpoint')
  })
})

describe('事件通道（真 MuxConnection 接假 WebSocket）', () => {
  it('构造期失败也不打断退避重连：计时器里再建连，界面出现未连接状态', async () => {
    vi.useFakeTimers()
    const root = makeRoot()
    const calls: RecordedCall[] = []
    await bootApp(root, { fetchLike: pairedFetchLike(calls), WebSocketCtor: ThrowingWebSocket })
    expect(root.innerHTML).toContain('未连接')
    // 首连（构造期）+ 至少两轮退避重连都活着：死循环不死进程。
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(root.innerHTML).toContain('未连接')
  })

  it('waterfall 审批到横幅，批准经 HTTP $events/result（首答生效后撤卡）', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    await bootApp(root, { fetchLike: pairedFetchLike(calls), WebSocketCtor: SilentWebSocket })
    const socket = SilentWebSocket.instances[0]!
    socket.onopen!()
    const openFrame = JSON.parse(socket.sent[0]!) as { type: string, endpoint: string, streamId: string }
    expect(openFrame.endpoint).toBe('$events')
    const streamId = openFrame.streamId
    socket.onmessage!(JSON.stringify({ type: 'item', streamId, value: { type: 'ready', clientId: 'client-1', host: { home: '/' } } }))
    socket.onmessage!(JSON.stringify({
      type: 'item',
      streamId,
      value: { type: 'waterfall', event: 'approval/request', eventId: 'evt-9', agentId: 'agent-1', request: { toolName: 'bash', displayReason: '要执行 ls' } },
    }))
    expect(root.innerHTML).toContain('待批准')
    expect(root.innerHTML).toContain('要执行 ls')

    click(root, '[data-action="approve"][data-event-id="evt-9"]')
    await flushTasks()
    const answerCall = calls.find(call => call.url === '/api/$events/result')
    expect(answerCall).toBeDefined()
    const args = (JSON.parse(answerCall!.body!) as { payload: { args: Record<string, unknown> } }).payload.args
    expect(args).toEqual({ clientId: 'client-1', eventId: 'evt-9', outcome: { kind: 'result', value: 'allowed-once' } })
    expect(root.innerHTML).not.toContain('data-action="approve"')
  })

  it('cancel 帧撤卡：桌面端先答后，手机端横幅自动消失', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    await bootApp(root, { fetchLike: pairedFetchLike(calls), WebSocketCtor: SilentWebSocket })
    const socket = SilentWebSocket.instances[0]!
    socket.onopen!()
    const streamId = (JSON.parse(socket.sent[0]!) as { streamId: string }).streamId
    socket.onmessage!(JSON.stringify({ type: 'item', streamId, value: { type: 'ready', clientId: 'client-1', host: { home: '/' } } }))
    socket.onmessage!(JSON.stringify({
      type: 'item',
      streamId,
      value: { type: 'waterfall', event: 'approval/request', eventId: 'evt-10', agentId: 'agent-1', request: { toolName: 'write' } },
    }))
    expect(root.innerHTML).toContain('data-action="approve"')
    socket.onmessage!(JSON.stringify({ type: 'item', streamId, value: { type: 'cancel', eventId: 'evt-10' } }))
    expect(root.innerHTML).not.toContain('data-action="approve"')
  })

  it('应答在途时批准/拒绝按钮禁用，重复点击不重发；完成后横幅撤下', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    const result = deferred<MinimalResponse>()
    const base = pairedFetchLike(calls)
    await bootApp(root, {
      fetchLike: async (url, init) => {
        calls.push({ url, body: init?.body })
        return url === '/api/$events/result' ? result.promise : base(url, init)
      },
      WebSocketCtor: SilentWebSocket,
    })
    const socket = SilentWebSocket.instances[0]!
    socket.onopen!()
    const streamId = (JSON.parse(socket.sent[0]!) as { streamId: string }).streamId
    socket.onmessage!(JSON.stringify({ type: 'item', streamId, value: { type: 'ready', clientId: 'client-1', host: { home: '/' } } }))
    socket.onmessage!(JSON.stringify({
      type: 'item',
      streamId,
      value: { type: 'waterfall', event: 'approval/request', eventId: 'evt-11', agentId: 'agent-1', request: { toolName: 'bash' } },
    }))

    click(root, '[data-action="approve"][data-event-id="evt-11"]')
    await flushTasks()
    // 在途：按钮禁用（UI 不邀双击），再点也不发第二次。
    const pendingButton = root.querySelector('[data-action="approve"][data-event-id="evt-11"]') as HTMLButtonElement
    expect(pendingButton.disabled).toBe(true)
    click(root, '[data-action="approve"][data-event-id="evt-11"]')
    await flushTasks()
    expect(calls.filter(call => call.url === '/api/$events/result')).toHaveLength(1)

    result.resolve(jsonResponse({ result: { ok: true, value: { accepted: true } } }))
    await flushTasks()
    expect(root.innerHTML).not.toContain('data-action="approve"')
  })
})

describe('过期应答守卫（会话切换后在途应答不落状态）', () => {
  /** 两会话（A/B）各带一条可辨识消息的 page 应答；A 的探测/倒页可挂起。 */
  function twoSessionFetchLike(calls: RecordedCall[], aProbe?: Promise<MinimalResponse>, aOlder?: Promise<MinimalResponse>) {
    return async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body })
      if (url === '/api/session/list') {
        return jsonResponse({
          result: {
            ok: true,
            value: {
              items: [
                { sessionId: 'session-aaa', updatedAt: 2, running: false, blank: false, agentAvailable: true },
                { sessionId: 'session-bbb', updatedAt: 1, running: false, blank: false, agentAvailable: true },
              ],
            },
          },
        })
      }
      if (url === '/threadharbor/mobile/peers') return jsonResponse({ peers: [] })
      if (url === '/api/session/page') {
        const { sessionId, throughSeq } = pageArgs(init?.body)
        const seq = throughSeq ?? 0
        if (sessionId === 'session-aaa') {
          if (seq > 1000) return aProbe === undefined ? pastCursorProbe(100) : aProbe
          if (aOlder !== undefined && seq < 16) return aOlder
          if (seq < 16) return pageResponse('A的更早消息', 15, false)
          return jsonResponse({
            result: {
              ok: true,
              value: {
                records: [
                  { type: 'event', event: { type: 'user/message', seq: 16, time: 1, data: { content: [{ type: 'text', text: 'A的最新消息' }], source: { kind: 'user' } } } },
                  { type: 'event', event: { type: 'assistant/message', seq: 17, time: 2, data: { message: { content: [{ type: 'text', text: 'A的回复' }] } } } },
                ],
                hasMore: true,
              },
            },
          })
        }
        if (seq > 1000) return pastCursorProbe(17)
        return jsonResponse({
          result: {
            ok: true,
            value: {
              records: [
                { type: 'event', event: { type: 'user/message', seq: 16, time: 1, data: { content: [{ type: 'text', text: 'B的专属消息' }], source: { kind: 'user' } } } },
              ],
              hasMore: true,
            },
          },
        })
      }
      return { status: 404, text: async () => '' }
    }
  }

  it('A 的慢探测在切到 B 后才到：不污染 B 的会话内容', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    const aProbe = deferred<MinimalResponse>()
    await bootApp(root, { fetchLike: twoSessionFetchLike(calls, aProbe.promise), WebSocketCtor: SilentWebSocket })
    click(root, '[data-action="tab"][data-tab="sessions"]')
    await flushTasks()
    click(root, '[data-action="open-session"][data-session-id="session-aaa"]')
    await flushTasks() // A 的探测挂在 deferred 上，会话屏停在加载中
    click(root, '[data-action="back"]')
    click(root, '[data-action="open-session"][data-session-id="session-bbb"]')
    await flushTasks() // B 加载完成
    expect(root.innerHTML).toContain('B的专属消息')

    // A 的慢探测此刻才到；随后它的倒页也会发出并应答——都不许落进 B 的状态。
    aProbe.resolve(pastCursorProbe(100))
    await flushTasks()
    await flushTasks()
    expect(root.innerHTML).toContain('B的专属消息')
    expect(root.innerHTML).not.toContain('A的最新消息')
    expect(root.innerHTML).not.toContain('A的回复')
  })

  it('「加载更早」的在途应答在切到 B 后才到：不混入 B 的内容', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    const aOlder = deferred<MinimalResponse>()
    await bootApp(root, { fetchLike: twoSessionFetchLike(calls, undefined, aOlder.promise), WebSocketCtor: SilentWebSocket })
    click(root, '[data-action="tab"][data-tab="sessions"]')
    await flushTasks()
    click(root, '[data-action="open-session"][data-session-id="session-aaa"]')
    await flushTasks()
    expect(root.innerHTML).toContain('A的最新消息')
    click(root, '[data-action="load-older"]')
    await flushTasks() // A 的倒页挂在 deferred 上
    click(root, '[data-action="back"]')
    click(root, '[data-action="open-session"][data-session-id="session-bbb"]')
    await flushTasks()
    expect(root.innerHTML).toContain('B的专属消息')

    aOlder.resolve(pageResponse('A的更早消息', 15, false))
    await flushTasks()
    expect(root.innerHTML).toContain('B的专属消息')
    expect(root.innerHTML).not.toContain('A的更早消息')

    // 放掉的在途标记不能卡死新会话：B 的「加载更早」照常发请求。
    const pageCountBefore = calls.filter(call => call.url === '/api/session/page').length
    click(root, '[data-action="load-older"]')
    await flushTasks()
    expect(calls.filter(call => call.url === '/api/session/page').length).toBe(pageCountBefore + 1)
  })
})

describe('游标探测报错但解析不出游标（Important 2）', () => {
  it('无 past cursor 字样的错误 → 显式可重试错误屏，不静默、不空转', async () => {
    const root = makeRoot()
    const calls: RecordedCall[] = []
    const base = pairedFetchLike(calls)
    await bootApp(root, {
      fetchLike: async (url, init) => {
        calls.push({ url, body: init?.body })
        if (url === '/api/session/page') {
          return jsonResponse({
            result: { ok: false, error: { code: 'gateway/internal', message: 'session log storage exploded', details: {} } },
          })
        }
        return base(url, init)
      },
      WebSocketCtor: SilentWebSocket,
    })
    click(root, '[data-action="tab"][data-tab="sessions"]')
    await flushTasks()
    click(root, '[data-action="open-session"]')
    await flushTasks()

    expect(root.innerHTML).toContain('无法确定会话最新位置')
    expect(root.innerHTML).toContain('session log storage exploded')
    // 没有可加载的更早页（状态没建起来），也不该有任何自动重试循环。
    expect(root.innerHTML).not.toContain('data-action="load-older"')
    expect(calls.filter(call => call.url === '/api/session/page')).toHaveLength(1)
  })
})

describe('滚动位置保留（nextScrollTop 纯决策 + 渲染接线）', () => {
  const scrollHeights = new WeakMap<Element, number>()
  const scrollTops = new WeakMap<Element, number>()
  let defaultListHeight = 0
  let savedDescriptors: Array<{ owner: object, key: string, descriptor: PropertyDescriptor }> = []

  function installScrollStubs(): void {
    savedDescriptors = []
    for (const key of ['scrollHeight', 'scrollTop'] as const) {
      let owner: object | null = HTMLElement.prototype
      while (owner !== null && Object.getOwnPropertyDescriptor(owner, key) === undefined) {
        owner = Object.getPrototypeOf(owner)
      }
      if (owner !== null && Object.getOwnPropertyDescriptor(owner, key) !== undefined) {
        savedDescriptors.push({ owner, key, descriptor: Object.getOwnPropertyDescriptor(owner, key)! })
      }
      Object.defineProperty(HTMLElement.prototype, key, {
        configurable: true,
        ...(key === 'scrollHeight'
          ? {
              get(this: HTMLElement) {
                const own = scrollHeights.get(this)
                if (own !== undefined) return own
                return this.classList?.contains('msg-list') === true ? defaultListHeight : 0
              },
            }
          : {
              get(this: HTMLElement) {
                return scrollTops.get(this) ?? 0
              },
              set(this: HTMLElement, value: number) {
                scrollTops.set(this, value)
              },
            }),
      })
    }
  }

  function uninstallScrollStubs(): void {
    for (const { owner, key, descriptor } of savedDescriptors.reverse()) {
      Object.defineProperty(owner, key, descriptor)
    }
    savedDescriptors = []
    // WeakMap 留着无害：元素随 DOM 丢弃，地图不阻止回收。defaultListHeight 归零。
    defaultListHeight = 0
  }

  it('nextScrollTop：restore 按高度差补偿锚点，keep 原样，bottom 贴新高，负值钳到 0', () => {
    expect(nextScrollTop('restore', { top: 400, height: 800 }, 1200)).toBe(800)
    expect(nextScrollTop('restore', { top: 400, height: 800 }, 0)).toBe(0)
    expect(nextScrollTop('keep', { top: 400, height: 800 }, 1200)).toBe(400)
    expect(nextScrollTop('bottom', { top: 400, height: 800 }, 1200)).toBe(1200)
    expect(nextScrollTop('keep', null, 1200)).toBe(1200)
  })

  it('接线：首开贴底；无关重渲染（横幅）保持阅读位；加载更早按锚点补偿', async () => {
    installScrollStubs()
    try {
      const root = makeRoot()
      const calls: RecordedCall[] = []
      // 「加载更早」的倒页应答挂起：先让 olderLoading 渲染落地，再补锚点。
      const olderPage = deferred<MinimalResponse>()
      const fetchLike = async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: init?.body })
        if (url === '/api/session/list') {
          return jsonResponse({
            result: { ok: true, value: { items: [{ sessionId: 'session-ccc', updatedAt: 1791916709370, running: false, blank: false, agentAvailable: true }] } },
          })
        }
        if (url === '/threadharbor/mobile/peers') return jsonResponse({ peers: [] })
        if (url === '/api/session/page') {
          const seq = pageArgs(init?.body).throughSeq ?? 0
          if (seq > 1000) return pastCursorProbe(17)
          if (seq < 17) return olderPage.promise
          return jsonResponse({
            result: {
              ok: true,
              value: {
                records: [
                  { type: 'event', event: { type: 'user/message', seq: 16, time: 1, data: { content: [{ type: 'text', text: '手机上见' }], source: { kind: 'user' } } } },
                  { type: 'event', event: { type: 'assistant/message', seq: 17, time: 2, data: { message: { content: [{ type: 'text', text: '好的' }] } } } },
                ],
                hasMore: true,
              },
            },
          })
        }
        return { status: 404, text: async () => '' }
      }
      defaultListHeight = 500
      await bootApp(root, { fetchLike, WebSocketCtor: SilentWebSocket })
      click(root, '[data-action="tab"][data-tab="sessions"]')
      await flushTasks()
      click(root, '[data-action="open-session"]')
      await flushTasks()

      const firstList = root.querySelector('.msg-list')!
      expect(scrollTops.get(firstList)).toBe(500) // 首开：贴底（= 新高度）

      // 用户上滑到 400；一条 waterfall 横幅触发无关重渲染 → 位置保持。
      scrollTops.set(firstList, 400)
      const socket = SilentWebSocket.instances[0]!
      socket.onopen!()
      const streamId = (JSON.parse(socket.sent[0]!) as { streamId: string }).streamId
      socket.onmessage!(JSON.stringify({ type: 'item', streamId, value: { type: 'ready', clientId: 'client-1', host: { home: '/' } } }))
      socket.onmessage!(JSON.stringify({
        type: 'item',
        streamId,
        value: { type: 'waterfall', event: 'approval/request', eventId: 'evt-12', agentId: 'agent-1', request: { toolName: 'bash' } },
      }))
      const afterBanner = root.querySelector('.msg-list')!
      expect(afterBanner).not.toBe(firstList)
      expect(scrollTops.get(afterBanner)).toBe(400)

      // 「加载更早」：点击后先等 olderLoading 渲染落地（列表又重建一次），
      // 在「将作为锚点」的列表上补上阅读位与高度，再让倒页应答兑现。
      // prepend 让内容整体下移：400 + (新 1200 − 旧 800) = 800，阅读位不动。
      scrollHeights.set(afterBanner, 800)
      defaultListHeight = 1200
      click(root, '[data-action="load-older"]')
      await flushTasks()
      const loadingList = root.querySelector('.msg-list')!
      expect(loadingList).not.toBe(afterBanner)
      scrollHeights.set(loadingList, 800)
      scrollTops.set(loadingList, 400)
      olderPage.resolve(pageResponse('更早的消息', 15, false))
      await flushTasks()
      const afterOlder = root.querySelector('.msg-list')!
      expect(root.innerHTML).toContain('更早的消息')
      expect(scrollTops.get(afterOlder)).toBe(800)
    } finally {
      uninstallScrollStubs()
    }
  })
})
