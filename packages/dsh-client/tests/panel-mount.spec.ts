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

import { describe, expect, it, vi } from 'vitest'
// The client entry reaches the composer model seat, upstream's component, which
// renders over ui-primitives' styled components — CSS modules Node cannot load.
// Nothing in this spec renders them.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./stubs/ui-primitives.ts'))

import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import { apply, inject, type ClientPanelContext, type PanelSlotHost } from '../src/client/index.ts'
import type { AgentPanelProps } from '../src/panel.tsx'

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
        // The frame's floating layer, where the switch's progress lives: a
        // bar that dies with the session it belongs to shows nothing at all.
        'shell.overlay': { kind: 'list', scope: 'root' },
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

/**
 * The context apply() runs in, with whatever services the test provides.
 *
 * Service reads go through a proxy that keeps cordis's one rule: a property
 * the entry never declared is an error, not a silent `undefined`. A plain
 * object cannot hold that line — it answers `undefined` for anything — which
 * is how a caller could reach for a service it never asked for and stay green
 * here while the real page refused the read and killed the entry. Declared but
 * not provided stays lenient (the real context reports that as its own state,
 * and several specs run without the optional surfaces).
 */
function fakeCtx(options: { services?: Namespaces; slots?: PanelSlotHost } = {}): ClientPanelContext & {
  core: SlotCore
  warnings: string[]
} {
  const core = new SlotCore()
  shellWith(core)
  const warnings: string[] = []
  const services = options.services ?? {}
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
      // 与真实上下文一致：服务缺席时给 undefined，不抛。抛错会让「可选服务
      // 缺席」在测试里变成必须显式处理，而 cordis 从来不这样。
      return services[name]
    },
    slots: options.slots ?? slotHost(core),
  }
  const declared = new Set<string>(inject)
  const target = { ...ctx, core, warnings }
  return new Proxy(target, {
    get: (host, prop, receiver) => {
      if (typeof prop !== 'string' || prop in host) return Reflect.get(host, prop, receiver)
      if (declared.has(prop)) return services[prop]
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  })
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
  it('主机服务齐全时，面板进 settings.section（各主机成为设置栏目），全程不炸', () => {
    const ctx = fakeCtx({ services: remoteNamespaces() })

    expect(() => { apply(ctx) }).not.toThrow()

    const sections = ctx.core.entriesOfSlot('settings.section')
    expect(sections.some(entry => entry.options.id === 'threadharbor-rollup')).toBe(true)
    expect(ctx.core.entriesOfSlot('main').some(entry => entry.options.key === 'threadharbor-rollup')).toBe(false)
    expect(ctx.core.entriesOfSlot('sidebar.panellist').some(entry => entry.options.id === 'threadharbor-rollup')).toBe(false)
    expect(ctx.core.entriesOfSlot('main').some(entry => entry.options.key === 'threadharbor-remote-session')).toBe(true)
  })

  it('输入框的模型入口在主机给出目录服务时接管那个座位', () => {
    // 这条用例盯的是「读服务必须先声明」这条规矩。模型入口要读的模型目录服务
    // 不在本入口的声明里：真实上下文会当场拒绝（cordis 抛 cannot get property
    // "modelDirectories" without inject），整个入口变成 failed，页面停在
    // 「Failed to load plugins」，而模型入口自己本该在没有服务时安静不注册。
    // 假上下文只有跟真实上下文一致地拒绝，才拦得住这一类回归。
    const ctx = fakeCtx({
      services: {
        ...remoteNamespaces(),
        modelDirectories: { directoryFor: () => ({}) },
        sessions: { subagentAddress: () => undefined },
      },
    })
    const registered: string[] = []
    const inner = ctx.core.register.bind(ctx.core)
    ;(ctx.core.register as unknown as (...args: never[]) => unknown) = (...args: never[]) => {
      const options = args[0] as { name?: string } | undefined
      if (typeof options?.name === 'string') registered.push(options.name)
      return (inner as unknown as (...a: never[]) => unknown)(...args)
    }

    expect(() => { apply(ctx) }).not.toThrow()

    expect(registered).toContain('conversation.input.model')
  })

  it('入口声明了模型座位那条路要读的服务', () => {
    // 座位占用者在渲染时调 models.directoryFor()。cordis 把服务内部用的上下文
    // 换成调用方这份，于是那些读算在本入口头上：ModelDirectoryResolver 自己
    // 声明 inject = ['sessions','remote','remote.session']，本入口少声明一个，
    // 真实页面就在占用者里炸（cannot get property "remote.session" without
    // inject），官方那几处用到它的入口也全都声明了它。
    // modelDirectories 本身不在这里：它对本面板是可选的，按「没有就不注册」
    // 处理，所以经 ctx.get 取，不进 inject。
    expect(inject).toEqual(expect.arrayContaining(['sessions', 'remote.session']))
  })

  it('主机服务缺席时照样挂载：面板说明缺什么，而不是空白', () => {
    // A page whose context offers no remote namespaces still gets its panel —
    // with the missing names said on screen and in the log, because an empty
    // panel that looks like "no agents" is the lie that started this.
    const ctx = fakeCtx({})

    expect(() => { apply(ctx) }).not.toThrow()

    const sections = ctx.core.entriesOfSlot('settings.section')
    expect(sections.some(entry => entry.options.id === 'threadharbor-rollup')).toBe(true)
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

/**
 * 设置通道与主机事实，按真实形状立起来：方法挂在 prototype 上。面板接线
 * 会从 remote 身上取 `settings.describe` / `$on` 这些方法——拆下来裸调丢
 * this 的错误必须在这里炸出来，而不是在真机上（先例：gateway 的 lookup）。
 */
class FakeSettingsNamespace {
  mutations: { ns: string; ops: unknown[] }[] = []
  async describe(): Promise<unknown> {
    return {
      namespaces: [{
        ns: 'threadharbor-host-store',
        value: { data: { 'dsh.host.registry': '[{"hostId":"bench","hostTitle":"测试机","address":"http://192.168.1.20:3081","createdAt":1}]' } },
      }],
    }
  }
  async mutate(ns: string, ops: unknown[]): Promise<unknown> {
    this.mutations.push({ ns, ops })
    return { ns }
  }
}

class FakeRemote {
  readonly $host = { home: '/tmp/dsh-home', isLoopback: true }
  readonly settings = new FakeSettingsNamespace()
  $on(_event: string, _handler: (...args: unknown[]) => void): () => void {
    return () => {}
  }
}

describe('登记与身份的存储接线', () => {
  /**
   * A slot host that captures the face exactly as the renderer receives it:
   * `inject` on the registration options is what hands props over, so the spy
   * calls it at "render" time. The SlotCore ledger does not keep `inject` on
   * the entry — reaching the face through entriesOfSlot reads nothing.
   */
  function capturingSlots(core: SlotCore): { host: PanelSlotHost; faces: AgentPanelProps[] } {
    const faces: AgentPanelProps[] = []
    const host: PanelSlotHost = {
      inject: (key, callback) => {
        if (core.spec(key) === undefined) throw new Error(`slot ${key} is not declared`)
        callback()
        return () => {}
      },
      register: (options, component) => {
        const face = (options as { inject?: () => AgentPanelProps }).inject?.()
        if (face !== undefined) faces.push(face)
        return core.register(options, component)
      },
    }
    return { host, faces }
  }

  function mountWithRemote(): { ctx: ReturnType<typeof fakeCtx>; faces: AgentPanelProps[] } {
    const core = new SlotCore()
    shellWith(core)
    const { host, faces } = capturingSlots(core)
    const ctx = fakeCtx({ services: { ...remoteNamespaces(), remote: new FakeRemote() }, slots: host })
    apply(ctx)
    return { ctx, faces }
  }

  const settled = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

  it('本机页面：面板拿到主机存储，水合后姿态 host', async () => {
    const { ctx, faces } = mountWithRemote()
    expect(() => { void ctx }).not.toThrow()
    expect(faces[0]?.hostStore).toBeDefined()
    await settled()
    expect(faces[0]?.hostStore?.posture()).toEqual({ kind: 'host' })
  })

  it('登记读取走接线好的存储：水合后 registry.list() 看到机器上的登记', async () => {
    const { faces } = mountWithRemote()
    await settled()
    expect(faces[0]?.registry.list().map(item => item.hostId)).toEqual(['bench'])
  })

  it('登记写入经 face 落到设置通道：逐键 mutate，命名空间是对的', async () => {
    const { ctx, faces } = mountWithRemote()
    await settled()
    expect(faces[0]?.registry.add({ hostId: 'lab', hostTitle: '实验机', address: 'http://192.168.1.30:3081' }).ok).toBe(true)
    await settled()
    const settings = (ctx.get('remote') as FakeRemote).settings
    expect(settings.mutations.at(-1)?.ns).toBe('threadharbor-host-store')
    const lastOps = settings.mutations.at(-1)?.ops as { op: string; path: string[] }[]
    expect(lastOps[0]?.op).toBe('set')
    expect(lastOps[0]?.path).toEqual(['data', 'dsh.host.registry'])
  })
})
