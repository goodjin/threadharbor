/**
 * 运行时层的本地化文案：住在 panel.tsx 下面的那批用户可见串。
 *
 * panel.tsx 通过框架注入的 `t` 席位读词典，但有三个产出文案的地方更深：
 * 入口接线的端口（client/index.ts —— agent 列表、探测结论、Tailscale
 * 选择器）与 ssh-deploy 的 HTTP 层。它们的串经端口结果到达屏幕，不经过
 * JSX，所以 ui-i18n 门禁看不见（属性赋值规则只扫 .tsx）。这份 spec 把
 * 门禁管不到的契约钉住：键在两种语言里都齐；拿到 `t` 就翻译；不给 `t`
 * 就回落到词典源语言，且逐字节等于迁移前的硬编码串（无 locale 行为不变）。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
// The client entry reaches the composer model seat, upstream's component, which
// renders over ui-primitives' styled components — CSS modules Node cannot load.
// Nothing in this spec renders them.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => await import('./stubs/ui-primitives.ts'))

import { agentListPort, panelProbe } from '../src/client/index.ts'
import { inspectSshHost, startSshDeploy, waitSshDeployOperation } from '../src/ssh-deploy.ts'
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
  'panel.ssh.httpInvalid',
  'panel.ssh.httpFailed',
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
    expect(fallbackT('panel.ssh.httpInvalid', { status: 502 })).toBe('无效响应（HTTP 502）')
    expect(fallbackT('panel.ssh.httpFailed', { status: 500 })).toBe('请求失败（HTTP 500）')
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
