/**
 * 主区打开另一台主机时，加载的是本机网关上的那台机器自己的界面。
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
  it('选中主机后，主区指向本机网关上的那台机器', async () => {
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
      root.render(createElement(RemoteConversationPanel, { remoteSessions: store, t: zhT }))
    })
    try {
      const frame = container.querySelector('iframe')
      expect(frame?.getAttribute('src')).toBe('/threadharbor/gateway/mini/')
      expect(frame?.getAttribute('data-remote-gateway')).toBe('mini')
      expect(container.textContent).toContain('迷你主机')
      expect(container.querySelector('[data-remote-input]')).toBeNull()
    } finally {
      await act(async () => { root.unmount() })
      container.remove()
    }
  })
})
