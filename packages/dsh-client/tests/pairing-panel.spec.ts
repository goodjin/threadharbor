/**
 * 手机配对 section：同源取 pair-url，画二维码 + 网址；取不到就把原因和
 * 配置指引说出来。
 *
 * 测试全程无 DOM：取回与状态机用注入的假 fetch 驱动（照 rollup-section
 * 的路子），画面用 renderToString 断言（照 panel.spec 的路子——渲染只
 * 需要状态，不需要浏览器）。
 */

import { describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import {
  PAIRING_PANEL_ID,
  PAIR_URL_PATH,
  PairingPanel,
  createPairingStore,
  requestPairUrl,
  saveAccessOriginDraft,
  startPairingSurface,
} from '../src/pairing-panel.ts'
import type { PairingAccessOrigin, PairingOriginPort, PairingSlotHost, PairingStore, PairUrlOutcome } from '../src/pairing-panel.ts'
import { zh } from '../src/locales.ts'
import type { ClientLocaleKey } from '../src/locales.ts'

/** 源语言 t：和框架合成的座位同一个替换规则（{name} 占位符）。 */
function zhT(key: ClientLocaleKey, params?: Record<string, unknown>): string {
  return zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** 面板画面只从状态渲染：renderToString 就是全部的「画」。 */
function renderPairing(store: PairingStore): string {
  return renderToString(createElement(PairingPanel, { pairing: store, t: zhT }))
}

/** 假同源 fetch：按给定应答回话，记下取过的路径。 */
function fakeFetch(response: { readonly status: number; readonly body: unknown } | { readonly failure: unknown }): {
  fetchLike: (path: string) => Promise<{ status: number; json(): Promise<unknown> }>
  paths: string[]
} {
  const paths: string[] = []
  return {
    paths,
    fetchLike: async path => {
      paths.push(path)
      if ('failure' in response) throw response.failure
      return { status: response.status, json: async () => response.body }
    },
  }
}

/** 宿主应答里铸出的配对网址（带进程令牌；测试里它也只进这条面板）。 */
const PAIR_URL = 'https://mac1.example.ts.net/threadharbor/mobile/?token=secret-process-token'
const FAKE_QR = 'data:image/png;base64,FAKEQR'

const settled = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** 等取回流程落地（离开 loading）；真 qrcode 画一张 PNG 不止一个宏任务。 */
async function untilLanded(store: PairingStore): Promise<void> {
  for (let waited = 0; store.getSnapshot().kind === 'loading' && waited < 2_000; waited += 5) {
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  expect(store.getSnapshot().kind).not.toBe('loading')
}

/** 宿主侧栏的槽位声明，照 panel-mount.spec 的次序种好。 */
function seedShell(core: SlotCore): void {
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
    { name: 'sidebar', children: { 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'sidebar.workspaces': { kind: 'single', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' } } },
    () => createElement('div'),
  )
}

/** 真核心上的注册面：声明齐了立即执行，登记的清理照槽位宿主的约定返回。 */
function slotHost(core: SlotCore): PairingSlotHost {
  return {
    inject: (key, callback) => {
      if (core.specDynamic(key) === undefined) throw new Error(`slot ${key} is not declared`)
      return callback()
    },
    register: (options, component) => core.register(options, component),
  }
}

/** 起一条配对 section：应答、画码、日志都可注入，核心种好两个槽位。 */
async function surfaceWith(
  response: { readonly status: number; readonly body: unknown } | { readonly failure: unknown },
  options: { readonly renderQr?: (text: string) => Promise<string> } = {},
): Promise<{
  surface: ReturnType<typeof startPairingSurface>
  paths: string[]
  qrCalls: string[]
  logs: string[]
  core: SlotCore
}> {
  const { fetchLike, paths } = fakeFetch(response)
  const qrCalls: string[] = []
  const logs: string[] = []
  const core = new SlotCore()
  seedShell(core)
  const surface = startPairingSurface({
    slots: slotHost(core),
    label: () => zhT('pairing.label'),
    requestPairUrl: () => requestPairUrl(fetchLike),
    ...(options.renderQr === undefined ? {} : { renderQr: async (text: string) => { qrCalls.push(text); return options.renderQr!(text) } }),
    log: message => { logs.push(message) },
  })
  await untilLanded(surface.store)
  return { surface, paths, qrCalls, logs, core }
}

describe('pair-url 的同源取回', () => {
  it('200 应答映射出配对网址', async () => {
    const outcome = await requestPairUrl(async () => ({ status: 200, json: async () => ({ url: PAIR_URL }) }))
    expect(outcome).toEqual({ ok: true, url: PAIR_URL })
  })

  it('宿主给了来源与回环标记就带上；老宿主只回网址也照常', async () => {
    const withExtras = await requestPairUrl(async () => ({
      status: 200,
      json: async () => ({ url: PAIR_URL, origin: 'http://127.0.0.1:3080', loopback: true }),
    }))
    expect(withExtras).toEqual({ ok: true, url: PAIR_URL, origin: 'http://127.0.0.1:3080', loopback: true })
    const oldHost = await requestPairUrl(async () => ({ status: 200, json: async () => ({ url: PAIR_URL }) }))
    expect(oldHost).toEqual({ ok: true, url: PAIR_URL })
  })

  it('500 mobile-origin-unset 映射成「配置缺失」的指引态', async () => {
    const outcome = await requestPairUrl(async () => ({ status: 500, json: async () => ({ error: 'mobile-origin-unset' }) }))
    expect(outcome).toEqual({ ok: false, kind: 'origin-unset', detail: 'HTTP 500' })
  })

  it('网络失败映射成「不可达」，不把异常抛给页面', async () => {
    const outcome = await requestPairUrl(async () => { throw new Error('网络断了') })
    expect(outcome).toMatchObject({ ok: false, kind: 'unavailable' })
  })

  it('应答不是约定形状（包括空网址）时按不可达处理', async () => {
    const wrongShape = await requestPairUrl(async () => ({ status: 200, json: async () => ({ surprise: true }) }))
    expect(wrongShape).toMatchObject({ ok: false, kind: 'unavailable' })
    const emptyUrl = await requestPairUrl(async () => ({ status: 200, json: async () => ({ url: '' }) }))
    expect(emptyUrl).toMatchObject({ ok: false, kind: 'unavailable' })
  })

  it('请求打在 federation 注册的 pair-url 路径上（不与旧中转页的路径同名）', async () => {
    const { fetchLike, paths } = fakeFetch({ status: 200, body: { url: PAIR_URL } })
    await requestPairUrl(fetchLike)
    expect(paths).toEqual(['/threadharbor/federation/pair-url'])
    expect(PAIR_URL_PATH).toBe('/threadharbor/federation/pair-url')
  })
})

describe('面板的三个状态（renderToString，无 DOM）', () => {
  it('200：二维码容器、二维码图和网址文本都出现，不出指引', async () => {
    const { surface } = await surfaceWith({ status: 200, body: { url: PAIR_URL } }, { renderQr: async () => FAKE_QR })
    const html = renderPairing(surface.store)
    expect(html).toContain('data-pairing-state="ready"')
    expect(html).toContain('data-pairing-qr')
    expect(html).toContain(`src="${FAKE_QR}"`)
    expect(html).toContain('data-pair-url')
    expect(html).toContain(PAIR_URL)
    expect(html).not.toContain('data-pairing-guidance')
    surface.dispose()
  })

  it('500 mobile-origin-unset：配置指引出现，二维码与网址不出现', async () => {
    const { surface } = await surfaceWith({ status: 500, body: { error: 'mobile-origin-unset' } })
    const html = renderPairing(surface.store)
    expect(html).toContain('data-pairing-guidance')
    expect(html).toContain(zhT('pairing.guidance.originTitle'))
    expect(html).toContain(zhT('pairing.guidance.origin'))
    expect(html).toContain('手机访问地址')
    expect(html).toContain('HTTP 500')
    expect(html).not.toContain('data-pairing-qr')
    expect(html).not.toContain(PAIR_URL)
    surface.dispose()
  })

  it('网络失败：也是指引文案，面板不炸', async () => {
    const { surface } = await surfaceWith({ failure: new Error('网络断了') })
    const html = renderPairing(surface.store)
    expect(html).toContain('data-pairing-guidance')
    expect(html).toContain(zhT('pairing.guidance.unreachableTitle'))
    expect(html).toContain(zhT('pairing.guidance.unreachable'))
    expect(html).toContain('网络断了')
    expect(html).not.toContain('data-pairing-qr')
    surface.dispose()
  })

  it('还没取到时说正在获取', () => {
    const html = renderPairing(createPairingStore())
    expect(html).toContain('data-pairing-state="loading"')
    expect(html).toContain(zhT('pairing.loading'))
  })

  it('回环来源：二维码照画，另点一句手机到不了', async () => {
    const { surface } = await surfaceWith(
      { status: 200, body: { url: 'http://127.0.0.1:3080/?token=t', origin: 'http://127.0.0.1:3080', loopback: true } },
      { renderQr: async () => FAKE_QR },
    )
    const html = renderPairing(surface.store)
    expect(html).toContain('data-pairing-qr')
    expect(html).toContain('data-pairing-loopback')
    expect(html).toContain(zhT('pairing.ready.loopback', { origin: 'http://127.0.0.1:3080' }))
    surface.dispose()
  })

  it('非回环来源不画那句警告', async () => {
    const { surface } = await surfaceWith(
      { status: 200, body: { url: PAIR_URL, origin: 'https://mac1.example.ts.net', loopback: false } },
      { renderQr: async () => FAKE_QR },
    )
    expect(renderPairing(surface.store)).not.toContain('data-pairing-loopback')
    surface.dispose()
  })
})

describe('手机访问地址的校验与保存', () => {
  function fakeOrigin(initial: string | undefined): PairingAccessOrigin & { saves: (string | undefined)[] } {
    let current = initial
    const saves: (string | undefined)[] = []
    return {
      saves,
      load: async () => current,
      save: async value => { saves.push(value); current = value },
    }
  }

  it('空串是清除，保存 undefined', async () => {
    const port = fakeOrigin('http://192.168.1.20:3080')
    const outcome = await saveAccessOriginDraft(port, '   ')
    expect(outcome).toEqual({ ok: true, value: undefined, slug: 'cleared' })
    expect(port.saves).toEqual([undefined])
  })

  it('带路径、查询的地址规范成 origin 再保存', async () => {
    const port = fakeOrigin(undefined)
    const outcome = await saveAccessOriginDraft(port, ' https://mac1.example.ts.net/app?x=1 ')
    expect(outcome).toEqual({ ok: true, value: 'https://mac1.example.ts.net', slug: 'saved' })
    expect(port.saves).toEqual(['https://mac1.example.ts.net'])
  })

  it('没有协议的地址不碰宿主，返回 syntax', async () => {
    const port = fakeOrigin(undefined)
    const outcome = await saveAccessOriginDraft(port, 'mac1.example.ts.net')
    expect(outcome).toEqual({ ok: false, kind: 'invalid', reason: 'syntax' })
    expect(port.saves).toEqual([])
  })

  it('非 http/https 与带账号的地址各自返回原因', async () => {
    const port = fakeOrigin(undefined)
    expect(await saveAccessOriginDraft(port, 'ftp://mac1.example.ts.net')).toEqual({ ok: false, kind: 'invalid', reason: 'protocol' })
    expect(await saveAccessOriginDraft(port, 'https://user:pass@mac1.example.ts.net')).toEqual({ ok: false, kind: 'invalid', reason: 'credentials' })
    expect(port.saves).toEqual([])
  })

  it('宿主写入失败：返回 save-failed 与原因', async () => {
    const outcome = await saveAccessOriginDraft({
      load: async () => undefined,
      save: async () => { throw new Error('设置服务拒绝了写入') },
    }, 'https://mac1.example.ts.net')
    expect(outcome).toEqual({ ok: false, kind: 'save-failed', detail: '设置服务拒绝了写入' })
  })
})

describe('编辑区与重新取回', () => {
  it('装配时带上访问地址读写面，面板因此画出编辑区', async () => {
    const core = new SlotCore()
    seedShell(core)
    const faces: unknown[] = []
    const host: PairingSlotHost = {
      inject: (key, callback) => {
        if (core.specDynamic(key) === undefined) throw new Error(`slot ${key} is not declared`)
        return callback()
      },
      register: (options, component) => {
        const face = (options as { inject?: () => unknown }).inject?.()
        if (face !== undefined) faces.push(face)
        return core.register(options, component)
      },
    }
    const origin: PairingAccessOrigin = { load: async () => 'http://192.168.1.20:3080', save: async () => {} }
    const surface = startPairingSurface({
      slots: host,
      label: () => zhT('pairing.label'),
      requestPairUrl: async () => ({ ok: true, url: PAIR_URL }),
      renderQr: async () => FAKE_QR,
      accessOrigin: origin,
    })
    await untilLanded(surface.store)
    const face = faces.find(entry => (entry as { accessOrigin?: unknown }).accessOrigin !== undefined) as { accessOrigin: PairingOriginPort } | undefined
    expect(face).toBeDefined()
    expect(await face?.accessOrigin.load()).toBe('http://192.168.1.20:3080')
    const html = renderToString(createElement(PairingPanel, { pairing: surface.store, accessOrigin: face!.accessOrigin, t: zhT }))
    expect(html).toContain('data-pairing-origin')
    expect(html).toContain('data-pairing-origin-input')
    expect(html).toContain('data-pairing-origin-save')
    surface.dispose()
  })

  it('没有设置通道（不给访问地址面）时不画编辑区', async () => {
    const { surface } = await surfaceWith({ status: 200, body: { url: PAIR_URL } }, { renderQr: async () => FAKE_QR })
    expect(renderPairing(surface.store)).not.toContain('data-pairing-origin')
    surface.dispose()
  })

  it('reload 重新取一次配对网址，新地址立刻生效', async () => {
    const core = new SlotCore()
    seedShell(core)
    const urls = ['http://127.0.0.1:3080/?token=a', 'https://mac1.example.ts.net/?token=b']
    let calls = 0
    const surface = startPairingSurface({
      slots: slotHost(core),
      label: () => zhT('pairing.label'),
      requestPairUrl: async () => {
        const url = urls[Math.min(calls, urls.length - 1)]!
        calls += 1
        return { ok: true, url }
      },
      renderQr: async () => FAKE_QR,
    })
    await untilLanded(surface.store)
    expect(surface.store.getSnapshot()).toMatchObject({ kind: 'ready', url: urls[0] })
    surface.reload()
    await untilLanded(surface.store)
    expect(surface.store.getSnapshot()).toMatchObject({ kind: 'ready', url: urls[1] })
    expect(calls).toBe(2)
    surface.dispose()
  })
})

describe('默认装配走真件', () => {
  it('不注入取回函数时，用全局 fetch 打同源 pair-url 路径', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (path: string) => {
      calls.push(path)
      return { status: 200, json: async () => ({ url: PAIR_URL }) }
    })
    try {
      const core = new SlotCore()
      seedShell(core)
      const surface = startPairingSurface({ slots: slotHost(core), label: () => zhT('pairing.label'), renderQr: async () => FAKE_QR })
      await untilLanded(surface.store)
      expect(calls).toEqual(['/threadharbor/federation/pair-url'])
      expect(surface.store.getSnapshot()).toMatchObject({ kind: 'ready', url: PAIR_URL })
      surface.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('不注入画码函数时，qrcode 画出真的 PNG data URL', async () => {
    const { surface } = await surfaceWith({ status: 200, body: { url: PAIR_URL } })
    const state = surface.store.getSnapshot()
    // 默认件没有替身可窥：网址进了真 qrcode 这件事，由就绪态里的 PNG
    // data URL 证明（画码失败会落成 unavailable 指引，到不了 ready）。
    expect(state.kind).toBe('ready')
    expect(state.kind === 'ready' && state.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    surface.dispose()
  })
})

describe('令牌不外泄', () => {
  it('成功取到带令牌的网址时，日志一个字都不提它', async () => {
    const { surface, logs } = await surfaceWith({ status: 200, body: { url: PAIR_URL } })
    for (const message of logs) {
      expect(message).not.toContain(PAIR_URL)
      expect(message).not.toContain('token=')
    }
    surface.dispose()
  })

  it('取不到时，日志也只有原因，没有网址', async () => {
    const { surface, logs } = await surfaceWith({ status: 500, body: { error: 'mobile-origin-unset' } })
    for (const message of logs) expect(message).not.toContain('token=')
    expect(logs.length).toBeGreaterThan(0)
    surface.dispose()
  })
})

describe('挂载在既有侧栏 section 注册面上', () => {
  it('手机配对进 main（threadharbor-pairing），侧栏行进 sidebar.panellist', async () => {
    const { surface, core } = await surfaceWith({ status: 200, body: { url: PAIR_URL } })
    expect(core.entriesOfSlot('main').some(entry => entry.options.key === PAIRING_PANEL_ID)).toBe(true)
    expect(core.entriesOfSlot('sidebar.panellist').some(entry => entry.options.id === PAIRING_PANEL_ID)).toBe(true)
    surface.dispose()
  })

  it('侧栏行的标签跟着词典走', async () => {
    const { surface, core } = await surfaceWith({ status: 200, body: { url: PAIR_URL } })
    const row = core.entriesOfSlot('sidebar.panellist').find(entry => entry.options.id === PAIRING_PANEL_ID)
    const label = row?.options.label
    expect(typeof label).toBe('function')
    expect((label as () => string)()).toBe('手机配对')
    surface.dispose()
  })

  it('面板从注册的 inject 面拿到的就是那条 store', async () => {
    const core = new SlotCore()
    seedShell(core)
    const faces: unknown[] = []
    const host: PairingSlotHost = {
      inject: (key, callback) => {
        if (core.specDynamic(key) === undefined) throw new Error(`slot ${key} is not declared`)
        return callback()
      },
      register: (options, component) => {
        const face = (options as { inject?: () => unknown }).inject?.()
        if (face !== undefined) faces.push(face)
        return core.register(options, component)
      },
    }
    const surface = startPairingSurface({
      slots: host,
      label: () => zhT('pairing.label'),
      requestPairUrl: async (): Promise<PairUrlOutcome> => ({ ok: false, kind: 'unavailable', detail: 'HTTP 503' }),
    })
    await untilLanded(surface.store)
    expect(faces.some(face => face === surface.store || (face as { pairing?: PairingStore }).pairing === surface.store)).toBe(true)
    surface.dispose()
  })

  it('dispose 撤掉两处注册', async () => {
    const { surface, core } = await surfaceWith({ status: 200, body: { url: PAIR_URL } })
    surface.dispose()
    expect(core.entriesOfSlot('main').some(entry => entry.options.key === PAIRING_PANEL_ID)).toBe(false)
    expect(core.entriesOfSlot('sidebar.panellist').some(entry => entry.options.id === PAIRING_PANEL_ID)).toBe(false)
  })

  it('dispose 后才落地的取回不再改状态', async () => {
    const core = new SlotCore()
    seedShell(core)
    let deliver: (outcome: PairUrlOutcome) => void = () => {}
    const surface = startPairingSurface({
      slots: slotHost(core),
      label: () => zhT('pairing.label'),
      requestPairUrl: () => new Promise<PairUrlOutcome>(resolve => { deliver = resolve }),
    })
    surface.dispose()
    deliver({ ok: true, url: PAIR_URL })
    await settled()
    expect(surface.store.getSnapshot().kind).toBe('loading')
  })
})
