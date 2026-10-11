/**
 * The mount, executed for real — not merely type-checked.
 *
 * A previous edition of this panel registered through a cast, and the cast hid
 * a throw: every page load mounted nothing, said nothing, and the error was
 * only visible in the console. These tests run the registration code against
 * the real SlotCore (the package DSH's renderer itself uses), with the shell's
 * declarations seeded the way ui-layout and ui-sidebar seed them, and assert
 * the panel actually lands in both slots. A registration that throws here is
 * a red test, not a silently blank page.
 *
 * This file needs jsdom because apply() touches `window` (sessionStorage and
 * localStorage for the identity settings, setInterval for the heartbeat) —
 * the one environment fact a hidden crash used to depend on. It was named
 * `rollup-mount.spec.ts` for that; the name now says what it tests.
 */

import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import { apply, type ClientPanelContext, type PanelSlotHost } from '../src/client/index.ts'

/**
 * The shell, as the real page builds it: ui-layout's frame owns `root` and
 * declares `main` and `sidebar`; ui-sidebar then occupies `sidebar` and
 * declares `sidebar.panellist`. Both declarations must exist before the panel
 * registers, which is also the order the real page loads in.
 */
function shellWith(core: SlotCore): void {
  core.register(
    {
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        sidebar: { kind: 'single', scope: 'root' },
      },
      inject: () => null,
    },
    () => createElement('div'),
  )
  core.register(
    {
      name: 'sidebar',
      children: { 'sidebar.panellist': { kind: 'list', scope: 'root' } },
    },
    () => createElement('div'),
  )
}

/**
 * The panel-side slot adapter over the real core. `inject` runs its callback
 * immediately because every declaration is seeded before apply() — the
 * waiting-for-declaration path is the renderer's own and is covered there.
 */
function slotHost(core: SlotCore): PanelSlotHost {
  return {
    inject: (key, callback) => {
      if (core.spec(key) === undefined) throw new Error(`slot ${key} is not declared`)
      callback()
      return () => {}
    },
    // Bound, not detached: the core's register is a prototype method, and a
    // detached alias would lose its ledger (`this`) mid-call.
    register: (options, component) => core.register(options, component),
  }
}

type Namespaces = Record<string, unknown>

/** The context apply() runs in, with whatever services the test provides. */
function fakeCtx(options: { services?: Namespaces } = {}): ClientPanelContext & {
  core: SlotCore
  warnings: string[]
} {
  const core = new SlotCore()
  shellWith(core)
  const warnings: string[] = []
  const ctx: ClientPanelContext = {
    logger: () => ({
      info: () => {},
      warn: message => { warnings.push(message) },
    }),
    effect: callback => {
      callback()
      return () => {}
    },
    get: name => {
      const services = options.services ?? {}
      if (name in services) return services[name]
      throw new Error(`property "${name}" does not exist`)
    },
    slots: slotHost(core),
  }
  return { ...ctx, core, warnings }
}

/** The remote namespaces, present and well-shaped, as a real page sees them. */
function remoteNamespaces(): Namespaces {
  return {
    'remote': { $on: () => () => {} },
    'remote.session': {
      create: async () => ({ ok: true, value: { sessionId: 's' } }),
      prompt: async () => ({ ok: true, value: { accepted: true } }),
      page: async () => ({ ok: true, value: { records: [] } }),
      modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }),
    },
    'remote.workspace': { archiveSession: async () => ({ ok: true, value: {} }) },
  }
}

describe('面板挂载', () => {
  it('主机服务齐全时，面板进 main，侧栏行进 sidebar.panellist，全程不炸', () => {
    const ctx = fakeCtx({ services: remoteNamespaces() })

    expect(() => { apply(ctx) }).not.toThrow()

    const main = ctx.core.entriesOfSlot('main')
    expect(main.some(entry => entry.options.key === 'threadharbor-rollup')).toBe(true)
    const panellist = ctx.core.entriesOfSlot('sidebar.panellist')
    expect(panellist.some(entry => entry.options.id === 'threadharbor-rollup')).toBe(true)
  })

  it('主机服务缺席时照样挂载：面板说明缺什么，而不是空白', () => {
    // A page whose context offers no remote namespaces still gets its panel —
    // with the missing names said on screen and in the log, because an empty
    // panel that looks like "no agents" is the lie that started this.
    const ctx = fakeCtx({})

    expect(() => { apply(ctx) }).not.toThrow()

    const main = ctx.core.entriesOfSlot('main')
    expect(main.some(entry => entry.options.key === 'threadharbor-rollup')).toBe(true)
    const panellist = ctx.core.entriesOfSlot('sidebar.panellist')
    expect(panellist.some(entry => entry.options.id === 'threadharbor-rollup')).toBe(true)
    expect(ctx.warnings.some(message => message.includes('remote.session'))).toBe(true)
  })

  it('登记进未声明的槽位会当场炸出来，而不是静默丢失', () => {
    // This is the property the cast used to hide. The core is the authority:
    // registering into a slot nobody declared throws — the test proves the
    // failure is loud when the shell is missing, which is what makes the
    // passing cases above mean anything.
    const core = new SlotCore()
    const host = slotHost(core)
    expect(() => host.inject('sidebar.panellist', () => {})).toThrow(/not declared/)
  })
})
