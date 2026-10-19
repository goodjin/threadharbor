/**
 * 未知输出折叠节点：默认收起，点开看原始内容。
 *
 * 这里盯的是用户能看见的三件事：收起时只有一行标题（种类与帧数）、展开后原文
 * 一字不少、再点收起。词条走词典、组件不写死文案。
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { RawOutputCard, rawOutputDefinition } from '../src/raw-output-card.ts'
import type { RawOutputData } from '../src/raw-output-card.ts'
import { en, zh } from '../src/locales.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** The `t` the framework would synthesize, bound to one dictionary. */
function seatT(dictionary: typeof zh): (key: string, params?: Record<string, unknown>) => string {
  return (key, params) => (dictionary as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

const DATA: RawOutputData = {
  turn: 1,
  step: 1,
  kind: 'session_info_update',
  format: 'json',
  content: '（2 帧）\n{"sessionUpdate":"session_info_update","a":1}\n{"sessionUpdate":"session_info_update","a":2}',
  count: 2,
}

const roots: Root[] = []
const containers: HTMLElement[] = []

async function mount(t: (key: string, params?: Record<string, unknown>) => string = seatT(zh)): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(createElement(RawOutputCard, { node: { data: DATA }, t } as never)) })
  return container
}

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  for (const container of containers.splice(0)) container.remove()
})

function buttonOf(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('button')!
}

describe('未知输出卡片', () => {
  it('默认收起：标题带种类与帧数，正文不可见', async () => {
    const container = await mount()
    expect(container.textContent).toContain('外部输出')
    expect(container.textContent).toContain('session_info_update')
    expect(container.textContent).toContain('2 帧')
    expect(container.textContent).not.toContain('"a":1')
    expect(buttonOf(container).getAttribute('aria-expanded')).toBe('false')
  })

  it('点开展示原始内容，再点收起', async () => {
    const container = await mount()
    await act(async () => { buttonOf(container).click() })
    expect(buttonOf(container).getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('（2 帧）')
    expect(container.textContent).toContain('"a":1')
    expect(container.textContent).toContain('"a":2')
    await act(async () => { buttonOf(container).click() })
    expect(buttonOf(container).getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('"a":1')
  })

  it('英文词典同样可用', async () => {
    const container = await mount(seatT(en))
    expect(container.textContent).toContain('session_info_update')
    expect(container.textContent).toContain('2')
  })
})

describe('词典词条', () => {
  it('zh 与 en 都有标题与展开/收起文案', () => {
    for (const dictionary of [zh, en]) {
      const entries = dictionary as Record<string, string>
      expect(entries['rawOutput.title']).toBeTruthy()
      expect(entries['rawOutput.title']).toContain('{kind}')
      expect(entries['rawOutput.title']).toContain('{count}')
      expect(entries['rawOutput.expand']).toBeTruthy()
      expect(entries['rawOutput.collapse']).toBeTruthy()
    }
  })
})

describe('Definition 匹配', () => {
  it('只命中 acp/raw-output 事件', () => {
    const hit = rawOutputDefinition.match({
      type: 'acp/raw-output',
      seq: 7,
      time: 1,
      data: DATA,
    } as never)
    expect(hit).toEqual({ id: expect.any(String), role: 'start' })
    expect(rawOutputDefinition.match({ type: 'turn/start', seq: 8, time: 2, data: { turn: 1 } } as never)).toBeNull()
  })
})
