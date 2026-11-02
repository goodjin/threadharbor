/**
 * 访问地址编辑区的事件层：进面板读到现值，输入、保存、校验、清除、失败。
 *
 * 面板其余画面由 renderToString 断言（pairing-panel.spec.ts）；这里在
 * jsdom 里真实点一遍，因为「保存后宿主重取网址」只有事件路径能证明。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { PairingPanel, createPairingStore } from '../src/pairing-panel.ts'
import type { PairingOriginPort } from '../src/pairing-panel.ts'
import { zh } from '../src/locales.ts'
import type { ClientLocaleKey } from '../src/locales.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function zhT(key: ClientLocaleKey, params?: Record<string, unknown>): string {
  return zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** 内存里的访问地址端口：记下每次保存与重取，失败可以注入。 */
function fakePort(
  initial: string | undefined,
  failure?: string,
): PairingOriginPort & { saves: (string | undefined)[]; reloads: number; value: string | undefined } {
  const port = {
    value: initial,
    saves: [] as (string | undefined)[],
    reloads: 0,
    async load() { return port.value },
    async save(next: string | undefined) {
      if (failure !== undefined) throw new Error(failure)
      port.saves.push(next)
      port.value = next
    },
    reload() { port.reloads += 1 },
  }
  return port
}

async function mount(port: PairingOriginPort): Promise<{ container: HTMLElement; unmount(): Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const store = createPairingStore()
  store.publish({ kind: 'ready', url: 'https://mac1.example.ts.net/?token=x', qrDataUrl: 'data:image/png;base64,FAKE' })
  await act(async () => {
    root.render(createElement(PairingPanel, { pairing: store, accessOrigin: port, t: zhT }))
  })
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

function q(container: HTMLElement, selector: string): HTMLElement {
  const el = container.querySelector(selector)
  if (el === null) throw new Error(`no element matches ${selector}`)
  return el as HTMLElement
}

function input(container: HTMLElement): HTMLInputElement {
  const el = q(container, '[data-pairing-origin-input]')
  if (!(el instanceof HTMLInputElement)) throw new Error('origin input is not an input')
  return el
}

function type(container: HTMLElement, value: string): void {
  const el = input(container)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function save(container: HTMLElement): Promise<void> {
  await act(async () => {
    q(container, '[data-pairing-origin-save]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

describe('访问地址编辑区（jsdom 事件层）', () => {
  it('进面板读到宿主当前存的地址', async () => {
    const port = fakePort('http://192.168.1.20:3080')
    const { container, unmount } = await mount(port)
    expect(input(container).value).toBe('http://192.168.1.20:3080')
    expect(input(container).disabled).toBe(false)
    await unmount()
  })

  it('保存：规范化成 origin、立刻重取配对网址', async () => {
    const port = fakePort(undefined)
    const { container, unmount } = await mount(port)
    type(container, 'https://mac1.example.ts.net/app?x=1')
    await save(container)
    expect(port.saves).toEqual(['https://mac1.example.ts.net'])
    expect(port.reloads).toBe(1)
    expect(input(container).value).toBe('https://mac1.example.ts.net')
    expect(q(container, '[data-pairing-origin-message="ok"]').textContent).toContain('https://mac1.example.ts.net')
    await unmount()
  })

  it('没有协议的地址：原地说原因，不写宿主、不重取', async () => {
    const port = fakePort(undefined)
    const { container, unmount } = await mount(port)
    type(container, 'mac1.example.ts.net')
    await save(container)
    expect(port.saves).toEqual([])
    expect(port.reloads).toBe(0)
    expect(q(container, '[data-pairing-origin-message="bad"]').textContent).toContain(zhT('pairing.origin.badSyntax'))
    await unmount()
  })

  it('清空：保存 undefined，让宿主回到按请求来源生成', async () => {
    const port = fakePort('http://192.168.1.20:3080')
    const { container, unmount } = await mount(port)
    type(container, '   ')
    await save(container)
    expect(port.saves).toEqual([undefined])
    expect(port.reloads).toBe(1)
    expect(q(container, '[data-pairing-origin-message="ok"]').textContent).toContain(zhT('pairing.origin.cleared'))
    await unmount()
  })

  it('宿主写入失败：说原因，不重取', async () => {
    const port = fakePort(undefined, '设置服务拒绝了写入')
    const { container, unmount } = await mount(port)
    type(container, 'https://mac1.example.ts.net')
    await save(container)
    expect(port.reloads).toBe(0)
    expect(q(container, '[data-pairing-origin-message="bad"]').textContent).toContain('设置服务拒绝了写入')
    await unmount()
  })
})
