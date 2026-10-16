/**
 * The switched-turn surface's mount, executed for real — not merely
 * type-checked.
 *
 * The one bug that took the whole page down lived between these seams: the
 * conversation registry's `register` is a prototype method, and a detached
 * call dies on `this` — which threw during apply and failed the entry fiber,
 * so the page booted without this plugin at all. These tests therefore stand
 * the services up as prototype-bearing classes (not arrow-function literals,
 * which hide exactly this), run the real `apply()` against the real SlotCore
 * seeded with every slot the entry registers into, and expect the Definition
 * and the keyed renderer to land.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
// The client entry reaches the composer model seat, upstream's component, which
// renders over ui-primitives' styled components — CSS modules Node cannot load.
// Nothing in this spec renders them.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./stubs/ui-primitives.ts'))

import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import { apply } from '../src/client/index.ts'

function shellWith(core: SlotCore): void {
  core.register(
    {
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        sidebar: { kind: 'single', scope: 'root' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        'conversation.session.header': { kind: 'single', scope: 'session' },
        'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
        // ui-conversation declares this seat too; the model entry registers
        // into it, so a shell that omits it stops modeling the real host.
        'conversation.input.model': { kind: 'single', scope: 'session' },
        // The composer dock under the input box: the zcode quota pills land
        // beside the official stats pills (ui-chat's registration).
        'conversation.composer.dock': { kind: 'list', scope: 'session' },
        // The turn-tail list: the interrupted-turn recovery row rides here
        // (declared by ui-chat's turn-tail renderer).
        'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
        // The frame's floating layer, where the switch's progress lives: a bar
        // that dies with the session it belongs to shows nothing at all.
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      inject: () => null,
    },
    () => createElement('div'),
  )
  core.register(
    {
      name: 'sidebar',
      children: { 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'sidebar.workspaces': { kind: 'single', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' } },
    },
    () => createElement('div'),
  )
}

function slotHost(core: SlotCore) {
  return {
    inject: (key: string, callback: () => unknown) => {
      if (core.spec(key) === undefined) throw new Error(`slot ${key} is not declared`)
      callback()
      return () => {}
    },
    register: (options: Parameters<SlotCore['register']>[0], component: Parameters<SlotCore['register']>[1]) =>
      core.register(options, component),
  }
}

/** Prototype-bearing stand-in for the conversation event registry. */
class FakeEventRegistry {
  registered: unknown[] = []
  register(definition: unknown): () => void {
    if (this === undefined) throw new Error('register was called detached from its registry')
    this.registered.push(definition)
    return () => {}
  }
}

/** Prototype-bearing stand-in for the workspace navigation service. */
class FakeWorkspace {
  opened: string[] = []
  openSession(sessionId: string): void {
    this.opened.push(sessionId)
  }
}

describe('客户端入口在完整槽位下的 apply', () => {
  it('注册面板与切换交接面，全程不炸', () => {
    const core = new SlotCore()
    shellWith(core)
    const errors: string[] = []
    const registry = new FakeEventRegistry()
    const ctx = {
      logger: () => ({ info: () => {}, warn: message => { errors.push(message) } }),
      effect: (callback: () => unknown) => { callback(); return () => {} },
      get: (name: string) => {
        const services: Record<string, unknown> = {
          uiWorkspace: new FakeWorkspace(),
          uiConversation: { events: registry },
          remote: { $on: () => () => {} },
        }
        // 服务缺席给 undefined，与 cordis 一致：可选服务（模型目录那类）缺席时
        // 入口该安静不注册，而不是在这里被测试专有的抛错打死。
        return services[name]
      },
      slots: slotHost(core),
    }
    expect(() => { apply(ctx as never) }).not.toThrow()
    expect(registry.registered.map(kind => (kind as { kind: string }).kind)).toContain('agent-switch-handover')
    const keys = core.entriesOfSlot('conversation.chat.node').map(entry => entry.options.key)
    expect(keys).toContain('agent-switch-handover')
    expect(errors.filter(message => message.includes('agent-switch'))).toEqual([])
  })

  it('会话服务缺位时只警告并跳过，不炸入口', () => {
    const core = new SlotCore()
    shellWith(core)
    const errors: string[] = []
    const ctx = {
      logger: () => ({ info: () => {}, warn: message => { errors.push(message) } }),
      effect: (callback: () => unknown) => { callback(); return () => {} },
      get: (name: string) => {
        // 同上：缺席即 undefined，cordis 不因缺服务抛错。
        return name === 'remote' ? { $on: () => () => {} } : undefined
      },
      slots: slotHost(core),
    }
    expect(() => { apply(ctx as never) }).not.toThrow()
    expect(errors.filter(message => message.includes('agent-switch'))).toHaveLength(1)
    expect(core.entriesOfSlot('conversation.chat.node')).toHaveLength(0)
  })
})
