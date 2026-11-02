/**
 * 运行时层的本地化文案：住在 panel.tsx 下面的那批用户可见串。
 *
 * panel.tsx 通过框架注入的 `t` 席位读词典，但有一批产出文案的地方更深：
 * 入口接线的端口（client/index.ts —— agent 列表、探测结论、Tailscale
 * 选择器）、ssh-deploy 的 HTTP 层，以及最后一批端口模块（reach /
 * gateway / host-store / rollup-section / session-source）。它们的串
 * 经端口结果到达屏幕，不经过 JSX，所以 ui-i18n 门禁看不见（属性赋值
 * 规则只扫 .tsx）。这份 spec 把门禁管不到的契约钉住：键在两种语言里
 * 都齐；拿到 `t` 就翻译；不给 `t` 就回落到词典源语言，且逐字节等于
 * 迁移前的硬编码串（无 locale 行为不变）。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { agentListPort, hostSessionSource, panelProbe } from '../src/client/index.ts'
import type { ClientPanelContext } from '../src/client/index.ts'
import { inspectSshHost, startSshDeploy, waitSshDeployOperation } from '../src/ssh-deploy.ts'
import { openSessionGateway } from '../src/gateway.ts'
import { startHostStore } from '../src/host-store.ts'
import type { HostStoreChannel } from '../src/host-store.ts'
import { probeReach } from '../src/reach.ts'
import { buildHostSessions } from '../src/session-source.ts'
import type { WorkspaceListSource } from '../src/session-source.ts'
import { en, fallbackT, zh } from '../src/locales.ts'
import type { ClientLocaleKey, RuntimeT } from '../src/locales.ts'
import type { GatewayOpening } from '../src/gateway.ts'

/**
 * 这轮收编的运行时键。`satisfies` 让拼错的键名在类型检查时报错；
 * 键缺失则由下面的运行时断言（字典测试）先红。
 */
const RUNTIME_KEYS = [
  'panel.tailscale.noChannel',
  'panel.tailscale.badList',
  'panel.tailscale.refreshDenied',
  'panel.gateway.missing',
  'panel.gateway.notReady',
  'panel.gateway.shapeNotObject',
  'panel.gateway.shapeUnexpected',
  'panel.gateway.shapeNoOk',
  'panel.gateway.noModelCatalog',
  'panel.ssh.httpInvalid',
  'panel.ssh.httpFailed',
  'panel.reach.networkFailure',
  'panel.reach.requestFailed',
  'panel.posture.degradedNoNamespace',
  'panel.posture.degradedReadFailed',
  'panel.posture.degradedWriteFailed',
  'panel.rollup.emptySessions',
  'panel.rollup.crossSourceNote',
  'panel.session.noWorkspacesService',
  'panel.session.readFailed',
  'panel.session.stillLoading',
] as const satisfies readonly ClientLocaleKey[]

/** Every `{name}` placeholder a value carries, in order. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!)
}

describe('运行时文案的键', () => {
  it('两种语言都登记了这批键', () => {
    for (const key of RUNTIME_KEYS) {
      expect(zh[key], `zh 缺 ${key}`).toBeDefined()
      expect((en as Record<string, string>)[key], `en 缺 ${key}`).toBeDefined()
    }
  })

  it('同一键两种语言的占位符一致', () => {
    for (const key of RUNTIME_KEYS) {
      expect(placeholders((en as Record<string, string>)[key]!), `占位符不一致：${key}`)
        .toEqual(placeholders(zh[key]!))
    }
  })

  it('无 locale 的回落读出迁移前的硬编码原文（逐字节）', () => {
    expect(fallbackT('panel.tailscale.noChannel')).toBe('这台机器没有提供设置通道（remote.settings）')
    expect(fallbackT('panel.tailscale.badList')).toBe('清单读出来是坏的，没法解析')
    expect(fallbackT('panel.tailscale.refreshDenied', { error: 'refused' })).toBe('刷新请求被拒：refused')
    expect(fallbackT('panel.gateway.missing', { missing: 'remote.session' })).toBe('主机服务缺失：remote.session')
    expect(fallbackT('panel.gateway.notReady', { error: 'Error: boom' })).toBe('主机服务未就绪：Error: boom')
    expect(fallbackT('panel.gateway.shapeNotObject', { what: 'session.create' })).toBe('session.create: 主机没有按约定返回对象')
    expect(fallbackT('panel.gateway.shapeUnexpected', { what: 'session.modelCatalog' })).toBe('session.modelCatalog: 返回值不符合预期')
    expect(fallbackT('panel.gateway.shapeNoOk', { what: 'session.prompt' })).toBe('session.prompt: 返回值缺少 ok 字段')
    expect(fallbackT('panel.gateway.noModelCatalog')).toBe('主机上没有 remote.session.modelCatalog，列不出 agent')
    expect(fallbackT('panel.ssh.httpInvalid', { status: 502 })).toBe('无效响应（HTTP 502）')
    expect(fallbackT('panel.ssh.httpFailed', { status: 500 })).toBe('请求失败（HTTP 500）')
    expect(fallbackT('panel.reach.networkFailure')).toBe('网络层失败：地址不可达、端口没有监听，或浏览器拦下了这个请求')
    expect(fallbackT('panel.reach.requestFailed', { name: 'RangeError' })).toBe('请求失败：RangeError')
    expect(fallbackT('panel.posture.degradedNoNamespace')).toBe('这台机器的设置通道里没有 threadharbor-host-store 命名空间（组合里缺 threadharbor-host-store 行）；名单这次存不进这台机器')
    expect(fallbackT('panel.posture.degradedReadFailed', { message: 'boom' })).toBe('读不到这台机器上已存的名单：boom')
    expect(fallbackT('panel.posture.degradedWriteFailed', { message: 'boom' })).toBe('没存进这台机器：boom')
    expect(fallbackT('panel.rollup.emptySessions')).toBe('这台主机还没有会话数据——请点「连接」打开远端 DSH，或等待后台拉取。')
    expect(fallbackT('panel.rollup.crossSourceNote')).toBe('跨主机说明：页签间的通道只在同源之间通信。同一台 DSH 的多个标签页会互相看见；另一台机器（另一个源）的页面不在这个频道里，要让它出现，请在那里打开它自己的页面。')
    expect(fallbackT('panel.session.noWorkspacesService')).toBe('读不到项目列表：主机上没有 workspaces 服务（可能还没加载完）。')
    expect(fallbackT('panel.session.readFailed')).toBe('项目列表读取失败：主机报了错误，稍后会随订阅自动重试。')
    expect(fallbackT('panel.session.stillLoading')).toBe('项目列表还在加载。')
  })
})

/** 一个跟任何词典文案都不同的 `t`：译文即调用痕迹，断言不用猜。 */
const fakeT: RuntimeT = (key, params) =>
  params === undefined ? `[T] ${key}` : `[T] ${key} ${JSON.stringify(params)}`

const noDelay = async (): Promise<void> => {}

/** 打不开网关的两种形态：给出缺失清单（不抛），或读服务被拒（抛）。 */
function missingOpening(names: readonly string[]): GatewayOpening {
  return { gateway: undefined, missing: names }
}

function refusedOpening(): GatewayOpening {
  throw new Error('boom')
}

/** ssh-deploy 的 HTTP 层只碰 `status` 和 `json()`，替身照这个面给。 */
function fetchAnswer(status: number, body: unknown): () => Promise<{ status: number; json: () => Promise<unknown> }> {
  return async () => ({ status, json: async () => body })
}

describe('agentListPort 的错误文案', () => {
  it('给 t 时缺失清单被翻译', async () => {
    const port = agentListPort(() => missingOpening(['remote.session']), noDelay, fakeT)
    const result = await port.reload()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toBe(fakeT('panel.gateway.missing', { missing: 'remote.session' }))
    }
  })

  it('给 t 时网关打不开被翻译', async () => {
    const port = agentListPort(refusedOpening, noDelay, fakeT)
    const result = await port.reload()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message).toBe(fakeT('panel.gateway.notReady', { error: 'Error: boom' }))
    }
  })

  it('不给 t 时回落到迁移前的中文原文', async () => {
    const missing = await agentListPort(() => missingOpening(['remote.session']), noDelay).reload()
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.message).toBe('主机服务缺失：remote.session')

    const refused = await agentListPort(refusedOpening, noDelay).reload()
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.message).toBe('主机服务未就绪：Error: boom')
  })
})

describe('panelProbe 的结论原因', () => {
  it('给 t 时被翻译', async () => {
    const outcome = await panelProbe(() => missingOpening(['remote.session']), fakeT)('acp:any')
    expect(outcome.verdict.kind).toBe('unreachable')
    expect(outcome.verdict.reason).toBe(fakeT('panel.gateway.missing', { missing: 'remote.session' }))
  })

  it('不给 t 时回落到迁移前的中文原文', async () => {
    const outcome = await panelProbe(() => missingOpening(['remote.session']))('acp:any')
    expect(outcome.verdict.reason).toBe('主机服务缺失：remote.session')
  })
})

describe('ssh-deploy 的 HTTP 错误模板', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('inspectSshHost 给 t 时无效响应被翻译', async () => {
    vi.stubGlobal('fetch', fetchAnswer(502, null))
    const result = await inspectSshHost({ target: 'h' }, fakeT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(fakeT('panel.ssh.httpInvalid', { status: 502 }))
  })

  it('startSshDeploy 给 t 时请求失败被翻译', async () => {
    vi.stubGlobal('fetch', fetchAnswer(503, { ok: false }))
    const result = await startSshDeploy({ hostId: 'h', ssh: { target: 'h' } }, fakeT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(fakeT('panel.ssh.httpFailed', { status: 503 }))
  })

  it('waitSshDeployOperation 给 t 时轮询读到的失败被翻译', async () => {
    vi.stubGlobal('fetch', fetchAnswer(500, { ok: false }))
    const result = await waitSshDeployOperation('op-1', undefined, undefined, fakeT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe(fakeT('panel.ssh.httpFailed', { status: 500 }))
  })

  it('不给 t 时回落到迁移前的中文原文', async () => {
    vi.stubGlobal('fetch', fetchAnswer(502, null))
    const invalid = await inspectSshHost({ target: 'h' })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error).toBe('无效响应（HTTP 502）')

    vi.stubGlobal('fetch', fetchAnswer(500, { ok: false }))
    const failed = await waitSshDeployOperation('op-1')
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toBe('请求失败（HTTP 500）')
  })
})

const REACH_ADDRESS = 'http://192.168.1.20:3081'

describe('probeReach 的不可达原因', () => {
  it('给 t 时网络层失败与按名报错都被翻译', async () => {
    const network = await probeReach(() => Promise.reject(new TypeError('fetch failed')), REACH_ADDRESS, 1000, fakeT)
    expect(network.kind).toBe('unreachable')
    if (network.kind === 'unreachable') expect(network.reason).toBe(fakeT('panel.reach.networkFailure'))

    const named = await probeReach(() => Promise.reject(new RangeError('bad input')), REACH_ADDRESS, 1000, fakeT)
    expect(named.kind).toBe('unreachable')
    if (named.kind === 'unreachable') expect(named.reason).toBe(fakeT('panel.reach.requestFailed', { name: 'RangeError' }))
  })

  it('不给 t 时回落到迁移前的中文原文', async () => {
    const network = await probeReach(() => Promise.reject(new TypeError('fetch failed')), REACH_ADDRESS, 1000)
    expect(network.kind).toBe('unreachable')
    if (network.kind === 'unreachable') {
      expect(network.reason).toBe('网络层失败：地址不可达、端口没有监听，或浏览器拦下了这个请求')
    }

    const named = await probeReach(() => Promise.reject(new RangeError('bad input')), REACH_ADDRESS, 1000)
    if (named.kind === 'unreachable') expect(named.reason).toBe('请求失败：RangeError')
  })
})

/** 网关测试用的假上下文：只有 get，缺席的名字按宿主那样抛。 */
function fakeGatewayCtx(table: Record<string, unknown>): { get(name: string): unknown } {
  return {
    get: name => {
      if (name in table) return table[name]
      throw new Error(`property "${name}" does not exist`)
    },
  }
}

const okResult = (value: unknown): unknown => ({ ok: true, value })

/** 三个必需调用齐全的 remote.session；modelCatalog 等由 overrides 换。 */
function wiredSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    create: async () => okResult({ sessionId: 's-probe' }),
    prompt: async () => okResult({ accepted: true }),
    ...overrides,
  }
}

const wiredWorkspace = { archiveSession: async () => okResult({ archivedSessionIds: [] }) }

/** 三个必需调用都接好、remote 也在的上下文。 */
function wiredCtx(session: Record<string, unknown>): { get(name: string): unknown } {
  return fakeGatewayCtx({
    'remote': { $on: () => () => {} },
    'remote.session': session,
    'remote.workspace': wiredWorkspace,
  })
}

describe('openSessionGateway 的形状错误文案', () => {
  it('给 t 时返回对象、形状、缺 ok 三种错误都被翻译', async () => {
    const notObject = openSessionGateway(wiredCtx(wiredSession({ modelCatalog: async () => 42 })), fakeT)
    const notObjectResult = await notObject.gateway!.listAgents()
    expect(notObjectResult.ok).toBe(false)
    if (!notObjectResult.ok) {
      expect(notObjectResult.error.message).toBe(fakeT('panel.gateway.shapeNotObject', { what: 'session.modelCatalog' }))
    }

    const unexpected = openSessionGateway(wiredCtx(wiredSession({ modelCatalog: async () => okResult({ groups: 'nope' }) })), fakeT)
    const unexpectedResult = await unexpected.gateway!.listAgents()
    if (!unexpectedResult.ok) {
      expect(unexpectedResult.error.message).toBe(fakeT('panel.gateway.shapeUnexpected', { what: 'session.modelCatalog' }))
    }

    const noOk = openSessionGateway(wiredCtx(wiredSession({ modelCatalog: async () => ({ hello: 'world' }) })), fakeT)
    const noOkResult = await noOk.gateway!.listAgents()
    if (!noOkResult.ok) {
      expect(noOkResult.error.message).toBe(fakeT('panel.gateway.shapeNoOk', { what: 'session.modelCatalog' }))
    }

    const createShape = openSessionGateway(wiredCtx(wiredSession({ create: async () => 42 })), fakeT)
    const createResult = await createShape.gateway!.createSession({ agentPreset: 'acp-any' })
    if (!createResult.ok) {
      expect(createResult.error.message).toBe(fakeT('panel.gateway.shapeNotObject', { what: 'session.create' }))
    }
  })

  it('给 t 时目录缺席的「列不出 agent」被翻译', async () => {
    const opening = openSessionGateway(wiredCtx(wiredSession()), fakeT)
    const result = await opening.gateway!.listAgents()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('gateway/missing')
      expect(result.error.message).toBe(fakeT('panel.gateway.noModelCatalog'))
    }
  })

  it('不给 t 时回落到迁移前的中文原文', async () => {
    const notObject = await openSessionGateway(wiredCtx(wiredSession({ create: async () => 42 }))).gateway!.createSession({ agentPreset: 'acp-any' })
    if (!notObject.ok) expect(notObject.error.message).toBe('session.create: 主机没有按约定返回对象')

    const noOk = await openSessionGateway(wiredCtx(wiredSession({ modelCatalog: async () => ({ hello: 'world' }) }))).gateway!.listAgents()
    if (!noOk.ok) expect(noOk.error.message).toBe('session.modelCatalog: 返回值缺少 ok 字段')

    const missing = await openSessionGateway(wiredCtx(wiredSession())).gateway!.listAgents()
    if (!missing.ok) expect(missing.error.message).toBe('主机上没有 remote.session.modelCatalog，列不出 agent')
  })
})

/** host-store 测试用的设置通道，行为由用例给。 */
function fakeChannel(behavior: {
  load?: () => Promise<Record<string, string> | undefined>
  mutate?: () => Promise<void>
}): HostStoreChannel {
  return {
    loadDocument: behavior.load ?? (async () => ({})),
    mutateDocument: behavior.mutate ?? (async () => {}),
  }
}

const hostStoreDeps = (channel: HostStoreChannel, log: (message: string) => void = () => {}) => ({
  loopback: () => true,
  channel,
  log,
})

describe('startHostStore 的降级细节', () => {
  it('给 t 时三种降级细节都被翻译', async () => {
    const noNamespace = startHostStore(hostStoreDeps(fakeChannel({ load: async () => undefined })), fakeT)
    await noNamespace.settled()
    expect(noNamespace.posture()).toEqual({ kind: 'degraded', detail: fakeT('panel.posture.degradedNoNamespace') })

    const readFailed = startHostStore(hostStoreDeps(fakeChannel({ load: async () => { throw new Error('boom') } })), fakeT)
    await readFailed.settled()
    expect(readFailed.posture()).toEqual({ kind: 'degraded', detail: fakeT('panel.posture.degradedReadFailed', { message: 'boom' }) })

    const writeFailed = startHostStore(hostStoreDeps(fakeChannel({
      load: async () => ({}),
      mutate: async () => { throw new Error('boom') },
    })), fakeT)
    await writeFailed.settled()
    writeFailed.storage.setItem('k', 'v')
    await vi.waitFor(() => { expect(writeFailed.posture().kind).toBe('degraded') })
    expect(writeFailed.posture()).toEqual({ kind: 'degraded', detail: fakeT('panel.posture.degradedWriteFailed', { message: 'boom' }) })
  })

  it('不给 t 时回落到迁移前的中文原文', async () => {
    const noNamespace = startHostStore(hostStoreDeps(fakeChannel({ load: async () => undefined })))
    await noNamespace.settled()
    expect(noNamespace.posture()).toEqual({
      kind: 'degraded',
      detail: '这台机器的设置通道里没有 threadharbor-host-store 命名空间（组合里缺 threadharbor-host-store 行）；名单这次存不进这台机器',
    })

    const readFailed = startHostStore(hostStoreDeps(fakeChannel({ load: async () => { throw new Error('boom') } })))
    await readFailed.settled()
    expect(readFailed.posture()).toEqual({ kind: 'degraded', detail: '读不到这台机器上已存的名单：boom' })

    const writeFailed = startHostStore(hostStoreDeps(fakeChannel({
      load: async () => ({}),
      mutate: async () => { throw new Error('boom') },
    })))
    await writeFailed.settled()
    writeFailed.storage.setItem('k', 'v')
    await vi.waitFor(() => { expect(writeFailed.posture().kind).toBe('degraded') })
    expect(writeFailed.posture()).toEqual({ kind: 'degraded', detail: '没存进这台机器：boom' })
  })
})

describe('buildHostSessions 的提示串', () => {
  const loadingWorkspaces: WorkspaceListSource = { items: [], archivedSessionIds: [], state: 'loading' }
  const erroredWorkspaces: WorkspaceListSource = { items: [], archivedSessionIds: [], state: 'error' }

  it('给 t 时三种提示都被翻译', () => {
    const noService = buildHostSessions(undefined, undefined, fakeT)
    expect(noService.ok).toBe(false)
    if (!noService.ok) expect(noService.note).toBe(fakeT('panel.session.noWorkspacesService'))

    const failed = buildHostSessions(erroredWorkspaces, undefined, fakeT)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.note).toBe(fakeT('panel.session.readFailed'))

    const loading = buildHostSessions(loadingWorkspaces, undefined, fakeT)
    expect(loading.ok).toBe(false)
    if (!loading.ok) expect(loading.note).toBe(fakeT('panel.session.stillLoading'))
  })

  it('不给 t 时回落到迁移前的中文原文', () => {
    const noService = buildHostSessions(undefined, undefined)
    if (!noService.ok) expect(noService.note).toBe('读不到项目列表：主机上没有 workspaces 服务（可能还没加载完）。')

    const failed = buildHostSessions(erroredWorkspaces, undefined)
    if (!failed.ok) expect(failed.note).toBe('项目列表读取失败：主机报了错误，稍后会随订阅自动重试。')

    const loading = buildHostSessions(loadingWorkspaces, undefined)
    if (!loading.ok) expect(loading.note).toBe('项目列表还在加载。')
  })
})

/** 拒答一切服务读取的入口上下文：workspaces 必然缺席。 */
function refusingCtx(): ClientPanelContext {
  return { get: () => { throw new Error('property does not exist') } } as unknown as ClientPanelContext
}

describe('hostSessionSource 的来源提示（入口接线透传 t）', () => {
  it('给 t 时 workspaces 缺席的提示被翻译', () => {
    const source = hostSessionSource(refusingCtx(), fakeT)
    expect(source.sourceNotes()).toEqual([fakeT('panel.session.noWorkspacesService')])
  })

  it('不给 t 时回落到迁移前的中文原文', () => {
    const source = hostSessionSource(refusingCtx())
    expect(source.sourceNotes()).toEqual(['读不到项目列表：主机上没有 workspaces 服务（可能还没加载完）。'])
  })
})
