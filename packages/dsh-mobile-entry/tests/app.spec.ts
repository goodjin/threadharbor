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
import { bootApp, makeSocketFactory, type SocketNotice } from '../mobile/app.js'

/** 最小 fetch 应答：rpcCall 只看 {status, text()}。 */
function jsonResponse(value: unknown, status = 200) {
  return { status, text: async () => JSON.stringify(value) }
}

interface RecordedCall { url: string, body?: string | undefined }

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
})
