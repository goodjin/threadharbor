/**
 * The one door from this page to the host: DSH's own Remote namespaces.
 *
 * The probe lives in the browser and drives the exact calls the rest of the UI
 * drives — `remote.session.create/prompt`, `remote.session.modelCatalog`,
 * `remote.workspace.archiveSession`, and the `api-session/error` and
 * `api-session/status` events. What this module adds is the shape-checking
 * around them: a namespace that is absent, half-loaded, or answering with
 * something unexpected must read as "missing" or "failed", never as a
 * TypeError from deep inside a panel click.
 *
 * These tests stand in for the namespaces with plain objects, because what is
 * under test is exactly the checking — not the wire.
 */

import { describe, expect, it } from 'vitest'
import { openSessionGateway } from '../src/gateway.ts'

type Namespaces = Record<string, unknown>

/** A stand-in for the cordis context: only `get`, only these names. */
function fakeCtx(table: Namespaces): { get(name: string): unknown } {
  return {
    get: name => {
      if (name in table) return table[name]
      throw new Error(`property "${name}" does not exist`)
    },
  }
}

function okResult(value: unknown): unknown {
  return { ok: true, value }
}

function sessionNamespace(overrides: Namespaces = {}): Namespaces {
  return {
    create: async () => okResult({ sessionId: 's-probe' }),
    prompt: async () => okResult({ accepted: true }),
    page: async () => okResult({ records: [] }),
    modelCatalog: async () => okResult({ groups: [], failures: [] }),
    ...overrides,
  }
}

describe('打开会话网关', () => {
  it('服务都在时给出可用网关', () => {
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': sessionNamespace({
        prompt: async () => okResult({ accepted: true }),
        page: async () => okResult({ records: [] }),
        modelCatalog: async () => okResult({ groups: [], failures: [] }),
      }),
      'remote.workspace': { archiveSession: async () => okResult({ archivedSessionIds: [] }) },
    }))
    expect(opening.gateway).not.toBeUndefined()
    expect(opening.missing).toEqual([])
  })

  it('读不到的服务按名字列进缺失清单', () => {
    const opening = openSessionGateway(fakeCtx({}))
    expect(opening.gateway).toBeUndefined()
    expect(opening.missing.some(name => name.includes('remote.session'))).toBe(true)
    expect(opening.missing.some(name => name.includes('remote.workspace'))).toBe(true)
  })

  it('服务在但方法缺一半，同样按缺失处理而不是用的时候才炸', () => {
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': { create: async () => okResult({ sessionId: 's' }) },
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    expect(opening.gateway).toBeUndefined()
    expect(opening.missing.some(name => name.includes('remote.session.prompt'))).toBe(true)
  })
})

describe('经网关建会话、发话、读历史', () => {
  it('建会话把预设带进 session.create，并带回会话 id', async () => {
    const seen: unknown[] = []
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': sessionNamespace({
        create: async (request: unknown) => { seen.push(request); return okResult({ sessionId: 's-probe' }) },
      }),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    const result = await opening.gateway!.createSession({ agentPreset: 'acp-grok' })
    expect(result).toEqual({ ok: true, value: { sessionId: 's-probe' } })
    expect(seen).toEqual([{ agentPreset: 'acp-grok' }])
  })

  it('发话走 session.prompt：一句文本、排队模式、带请求标识', async () => {
    const seen: unknown[] = []
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': sessionNamespace({
        prompt: async (request: unknown) => { seen.push(request); return okResult({ accepted: true }) },
      }),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    const result = await opening.gateway!.sendPrompt({ requestId: 'probe-1', sessionId: 's-probe', text: 'ping' })
    expect(result).toEqual({ ok: true, value: { accepted: true } })
    expect(seen[0]).toMatchObject({
      requestId: 'probe-1',
      sessionId: 's-probe',
      mode: 'queue',
      content: [{ type: 'text', text: 'ping' }],
    })
  })

  it('远端返回失败时原样带出代码和消息', async () => {
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': sessionNamespace({
        create: async () => ({ ok: false, error: { code: 'session/not-found', message: 'no such preset' } }),
      }),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    const result = await opening.gateway!.createSession({ agentPreset: 'acp-grok' })
    expect(result).toEqual({ ok: false, error: { code: 'session/not-found', message: 'no such preset' } })
  })

  it('远端返回了意料之外的形状时，按网关自己的失败报出，不抛异常', async () => {
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': sessionNamespace({
        create: async () => ({ hello: 'world' }),
      }),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    const result = await opening.gateway!.createSession({ agentPreset: 'acp-grok' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('gateway/shape')
  })
})

describe('经网关归档小会话', () => {
  it('归档走 workspace.archiveSession，带着 stopActivity：连同在跑的回合一起停', async () => {
    const seen: unknown[] = []
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': sessionNamespace(),
      'remote.workspace': {
        archiveSession: async (request: unknown) => { seen.push(request); return okResult({ archivedSessionIds: [] }) },
      },
    }))
    await opening.gateway!.archiveSession({ sessionId: 's-probe' })
    expect(seen).toEqual([{ sessionId: 's-probe', stopActivity: true }])
  })
})

describe('订阅会话错误与状态事件', () => {
  it('经 remote.$on 订阅 api-session/error，退订生效', () => {
    let listener: ((sessionId: string, message: string) => void) | undefined
    let disposed = 0
    const opening = openSessionGateway(fakeCtx({
      'remote': {
        $on: (event: string, handler: (sessionId: string, message: string) => void) => {
          listener = handler
          expect(event).toBe('api-session/error')
          return () => { disposed += 1 }
        },
      },
      'remote.session': sessionNamespace(),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    const unsubscribe = opening.gateway!.subscribeSessionErrors(() => {})
    expect(listener).toBeTypeOf('function')
    listener!('s-probe', 'boom')
    unsubscribe()
    expect(disposed).toBe(1)
  })

  it('经 remote.$on 订阅 api-session/status，拿到的是 (会话, 是否在跑)', () => {
    let listener: ((sessionId: string, running: boolean) => void) | undefined
    let disposed = 0
    const opening = openSessionGateway(fakeCtx({
      'remote': {
        $on: (event: string, handler: (sessionId: string, running: boolean) => void) => {
          listener = handler
          expect(event).toBe('api-session/status')
          return () => { disposed += 1 }
        },
      },
      'remote.session': sessionNamespace(),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    const unsubscribe = opening.gateway!.subscribeSessionStatus(() => {})
    expect(listener).toBeTypeOf('function')
    listener!('s-probe', true)
    unsubscribe()
    expect(disposed).toBe(1)
  })

  it('remote 本体缺席时退订是无操作，缺失进清单', () => {
    const opening = openSessionGateway(fakeCtx({
      'remote.session': sessionNamespace(),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    expect(() => opening.gateway!.subscribeSessionErrors(() => {})).not.toThrow()
    expect(() => opening.gateway!.subscribeSessionStatus(() => {})).not.toThrow()
    expect(opening.missing.some(name => name === 'remote')).toBe(true)
  })
})

describe('从模型目录认出本机的 agent', () => {
  it('目录里 acp: 前缀的提供方就是 agent，别的提供方不进来', async () => {
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': sessionNamespace({
        modelCatalog: async () => okResult({
          groups: [
            { id: 'acp:acp-grok', name: 'Grok', models: [{ id: 'grok-4.7', name: 'Grok 4.7' }] },
            { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
          ],
          failures: [{ id: 'acp:acp-broken', name: 'acp:acp-broken', message: 'lookup failed' }],
        }),
      }),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    const result = await opening.gateway!.listAgents()
    expect(result).toEqual({
      ok: true,
      value: [
        { presetId: 'acp-grok', label: 'Grok' },
        { presetId: 'acp-broken', label: 'acp-broken' },
      ],
    })
  })

  it('目录读不出来时报失败，不抛异常', async () => {
    const opening = openSessionGateway(fakeCtx({
      'remote': { $on: () => () => {} },
      'remote.session': sessionNamespace({
        modelCatalog: async () => { throw new Error('gateway down') },
      }),
      'remote.workspace': { archiveSession: async () => okResult({}) },
    }))
    const result = await opening.gateway!.listAgents()
    expect(result.ok).toBe(false)
  })
})
