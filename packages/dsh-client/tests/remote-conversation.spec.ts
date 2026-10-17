/**
 * 主区里看另一台主机上的会话：读记录、发一条、停一下。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteConversationPanel } from '../src/remote-conversation.tsx'
import { createRemoteConversationStore } from '../src/remote-conversation-store.ts'
import { zh } from '../src/locales.ts'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function zhT(key: string, params?: Record<string, unknown>): string {
  return zh[key as keyof typeof zh]!.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

describe('RemoteConversationPanel', () => {
  it('打开后读出对方的记录，发送把文字交给那台主机', async () => {
    const calls: Array<Record<string, unknown>> = []
    const store = createRemoteConversationStore()
    store.open({
      hostId: 'mini',
      hostTitle: '迷你主机',
      launchUrl: 'http://mini.example/?token=tk',
      sessionId: 'r1',
      title: '远端会话',
      projectId: 'rp',
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(RemoteConversationPanel, {
        remoteSessions: store,
        t: zhT,
        call: async body => {
          calls.push(body)
          if (body['op'] === 'transcript') {
            return { ok: true as const, value: { turns: [{ role: 'user', text: '你好' }], hasMore: false } }
          }
          return { ok: true as const, value: { accepted: true } }
        },
      }))
    })
    try {
      expect(container.querySelector('[data-remote-title]')?.textContent).toBe('远端会话')
      expect(container.textContent).toContain('迷你主机')
      expect(container.querySelector('[data-remote-turn="user"]')?.textContent).toBe('你好')
      const input = container.querySelector<HTMLInputElement>('[data-remote-input]')
      if (input === null) throw new Error('input missing')
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '接着说')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-action="remote-send"]')?.click()
        await Promise.resolve()
      })
      expect(calls.some(body => body['op'] === 'prompt' && body['text'] === '接着说' && body['sessionId'] === 'r1')).toBe(true)
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})
