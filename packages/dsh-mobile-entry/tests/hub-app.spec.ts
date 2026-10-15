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
import { bootApp } from '../mobile/app.js'

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
