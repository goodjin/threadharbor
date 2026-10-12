/**
 * 交接卡片在切换时到底做了什么：先把进度交给浮层，等新会话的首屏读完再跳。
 *
 * 这一段以前只有一个 1.2 秒的定时器——卡片一挂上就跳，中间发生了什么用户
 * 看不到。现在多了一步：进度和首屏预读都先开始，跳转等两者都落定。这里盯
 * 三件事：进度立刻开始（不是等定时器到点才有）、首屏没读完时不跳、读完了
 * 才跳，以及页面里没有预读能力时仍然跳（进度不是闸门）。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { AgentSwitchHandoverCard } from '../src/handover-card.ts'
import type { AgentSwitchHandoverData } from '../src/handover-card.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(() => {
  vi.useRealTimers()
})

/**
 * One handover, fresh per test: the card remembers which handovers this page
 * has already followed, so two tests sharing one ending would see the second
 * mount stay put instead of jumping.
 */
let handoverSeq = 0
function handoverData(): AgentSwitchHandoverData {
  handoverSeq += 1
  return {
    turn: handoverSeq,
    seq: 40 + handoverSeq,
    time: 1_700_000_000_000 + handoverSeq,
    target: 'acp-claude',
    sessionId: `session-new-${String(handoverSeq)}`,
    note: '已按新会话切换',
  }
}

/** Render the card the way the slot hands it over: node data plus the injected face. */
async function mountCard(face: {
  openSession: (sessionId: string) => void
  prepare?: (target: { sessionId: string; target: string }) => Promise<void>
}): Promise<{ container: HTMLElement; root: Root; data: AgentSwitchHandoverData }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const data = handoverData()
  const props = {
    node: { data },
    openSession: face.openSession,
    ...(face.prepare === undefined ? {} : { prepare: face.prepare }),
  }
  await act(async () => { root.render(createElement(AgentSwitchHandoverCard, props as never)) })
  return { container, root, data }
}

describe('交接卡片', () => {
  it('一挂上就开始报进度，不等那 1.2 秒', async () => {
    vi.useFakeTimers()
    const begun: { sessionId: string; target: string }[] = []
    const { data } = await mountCard({
      openSession: () => {},
      prepare: (target) => { begun.push(target); return new Promise(() => {}) },
    })
    expect(begun).toEqual([{ sessionId: data.sessionId, target: 'acp-claude' }])
  })

  it('新会话的首屏没读完就不跳', async () => {
    vi.useFakeTimers()
    const opened: string[] = []
    let loaded: (() => void) | undefined
    const { data } = await mountCard({
      openSession: sessionId => { opened.push(sessionId) },
      prepare: () => new Promise<void>((resolve) => { loaded = resolve }),
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(opened).toEqual([])

    await act(async () => { loaded?.(); await vi.advanceTimersByTimeAsync(1) })
    expect(opened).toEqual([data.sessionId])
  })

  it('页面没有预读能力时也照跳', async () => {
    vi.useFakeTimers()
    const opened: string[] = []
    const { data } = await mountCard({ openSession: sessionId => { opened.push(sessionId) } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(opened).toEqual([data.sessionId])
  })

  it('手动点开新会话的按钮立刻过去，不等进度', async () => {
    const opened: string[] = []
    const { container, root, data } = await mountCard({
      openSession: sessionId => { opened.push(sessionId) },
      prepare: () => new Promise(() => {}),
    })
    const button = container.querySelector('button')
    if (button === null) throw new Error('the notice has no button')
    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(opened).toEqual([data.sessionId])
    await act(async () => { root.unmount() })
  })
})