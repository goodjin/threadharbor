/**
 * 「被打断且无正文」轮次的找回入口（治本，2026-10-16 用户拍板）。
 *
 * 背景：会话视图把已结束轮次的过程内容（思考、工具卡片）默认折叠；正常轮次
 * 有一段正文答复当锚点、折叠行也能点开，但「重启打断 + 全程没吐过正文」的轮次
 * 两头落空——整个轮次在界面上消失（会话 ef20f6ac 第 17 轮，58 步全被收走）。
 * 长工具轮次是我们的 Agent 的常态，这个死角因此必踩。
 *
 * 修法：在轮次结尾的列表座位（conversation.chat.turnTail，它在折叠范围之外、
 * 永远渲染）挂一行兜底入口，条件命中时给一个「展开本轮过程」按钮，点击调用
 * 聊天存储现成的 setTurnProcessOpen 动作——与官方折叠行的展开走同一条路。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'

const { InterruptedTurnRecoveryRow, registerInterruptedTurnRecovery, RECOVERY_TAIL_ID } = await import('../src/interrupted-turn-recovery.ts')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** 一份盲区轮的座位数据：关闭、interrupted、无答复锚点、有过程内容。 */
function blindTurn(overrides?: Record<string, unknown>) {
  return {
    turn: 17,
    status: 'closed',
    end: { data: { reason: { kind: 'interrupted' } } },
    data: { get: (key: string) => key === 'turn-process' ? {
      answerAnchorSeq: null,
      messageCount: 3,
      toolCallCount: 55,
      subagentCount: 0,
    } : undefined },
    ...overrides,
  }
}

/** store 面的最小假件：可注入已展开的轮次表。 */
function fakeStore(revealedTurns: readonly number[] = []) {
  const state = { turnProcesses: revealedTurns.map(turn => ({ turn, answerStep: 0 })) }
  return {
    useStore: vi.fn((selector: (state: unknown) => unknown) => selector(state)),
    actions: { setTurnProcessOpen: vi.fn() },
  }
}

function render(props: Record<string, unknown>): string {
  return renderToString(createElement(InterruptedTurnRecoveryRow as (p: unknown) => unknown, props))
}

describe('InterruptedTurnRecoveryRow（盲区轮的找回入口）', () => {
  it('盲区轮渲染提示行和「展开本轮过程」按钮', () => {
    const store = fakeStore()
    const html = render({ turn: blindTurn(), ...store })
    expect(html).toContain('data-interrupted-recovery')
    expect(html).toContain('展开本轮过程')
    expect(html).toContain('被中断')
  })

  it('点击按钮用轮号、answerStep=0、open=true 调用展开动作', async () => {
    const store = fakeStore()
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    await act(async () => {
      root.render(createElement(InterruptedTurnRecoveryRow as (p: unknown) => unknown, { turn: blindTurn(), ...store }))
    })
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(store.actions.setTurnProcessOpen).toHaveBeenCalledTimes(1)
    expect(store.actions.setTurnProcessOpen).toHaveBeenCalledWith(17, 0, true)
    await act(async () => { root.unmount() })
  })

  it('已展开过的轮次不再显示入口', () => {
    const store = fakeStore([17])
    expect(render({ turn: blindTurn(), ...store })).toBe('')
  })

  it('非盲区轮一律不渲染：手动停止、正常完成、有正文锚点、无过程内容、轮次未关闭', () => {
    const cases = [
      { name: 'aborted（手动停止本来就会展开）', turn: blindTurn({ end: { data: { reason: { kind: 'aborted' } } } }) },
      { name: 'completed', turn: blindTurn({ end: { data: { reason: { kind: 'completed' } } } }) },
      { name: '有正文锚点（answerAnchorSeq 非 null）', turn: blindTurn({ data: { get: () => ({ answerAnchorSeq: 1999, messageCount: 1, toolCallCount: 2, subagentCount: 0 }) } }) },
      { name: '没有任何过程内容', turn: blindTurn({ data: { get: () => ({ answerAnchorSeq: null, messageCount: 0, toolCallCount: 0, subagentCount: 0 }) } }) },
      { name: '轮次还开着', turn: blindTurn({ status: 'open' }) },
    ]
    for (const item of cases) {
      const store = fakeStore()
      expect(render({ turn: item.turn, ...store }), item.name).toBe('')
    }
  })

  it('拿不到展开动作时整行不渲染（无入口的提示只会徒增困惑）', () => {
    const store = fakeStore()
    expect(render({ turn: blindTurn(), useStore: store.useStore, actions: undefined })).toBe('')
  })
})

describe('registerInterruptedTurnRecovery（座位注册）', () => {
  it('往 conversation.chat.turnTail 注册带 id/order/locale 的条目', () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const disposers: Array<() => void> = []
    const host = {
      inject: vi.fn((key: string, callback: () => (() => void)) => {
        expect(key).toBe('conversation.chat.turnTail')
        disposers.push(callback())
        return () => {}
      }),
      register: vi.fn((options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      }),
    }
    const disposer = registerInterruptedTurnRecovery(host as never)
    expect(typeof disposer).toBe('function')
    expect(disposers).toHaveLength(1)
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.options).toMatchObject({
      name: 'conversation.chat.turnTail',
      id: RECOVERY_TAIL_ID,
      locale: 'threadharborClient',
    })
    expect(typeof (registrations[0]?.options as { order?: unknown }).order).toBe('number')
    expect(typeof registrations[0]?.component).toBe('function')
  })
})
