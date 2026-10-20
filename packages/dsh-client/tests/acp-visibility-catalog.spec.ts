/**
 * The settings section's catalog read.
 *
 * This listing is deliberately RAW: hidden providers and models have to remain
 * visible here or there would be no way to unhide them. The tests pin the key
 * derivation (ACP routes lose their prefix, every other route is its own key),
 * the name cleanup, the failure rows, and each way a host can decline to
 * answer.
 */

import { describe, expect, it } from 'vitest'
import { createAcpCatalogStore, parseAcpCatalog } from '../src/acp-visibility-catalog.ts'

const catalog = {
  default: { provider: 'deepseek', model: 'chat' },
  routableProviders: ['deepseek', 'acp:cursor'],
  groups: [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] },
    {
      id: 'acp:cursor',
      name: 'acp:Cursor',
      models: [
        { id: 'grok', name: 'Grok' },
        { id: '', name: 'broken' },
      ],
    },
    { id: 'acp:codex', name: 'Codex', models: [{ id: 'gpt' }] },
    { id: 'acp:cursor', name: 'Duplicate', models: [] },
  ],
  failures: [
    { id: 'acp:qwen', name: 'Qwen', message: 'lookup failed' },
    { id: 'acp:cursor', name: 'Cursor again', message: 'duplicate' },
    { id: 'deepseek-account', name: 'DeepSeek account', message: 'unavailable' },
  ],
}

describe('目录解析', () => {
  it('列出每个提供方：名字去掉 acp: 前缀，坏模型跳过，重复键只留第一次', () => {
    const parsed = parseAcpCatalog(catalog)
    expect(parsed.error).toBeUndefined()
    expect(parsed.agents).toEqual([
      {
        key: 'deepseek',
        route: 'deepseek',
        name: 'DeepSeek',
        models: [{ id: 'chat', name: 'Chat' }],
      },
      {
        key: 'cursor',
        route: 'acp:cursor',
        name: 'Cursor',
        models: [{ id: 'grok', name: 'Grok' }],
      },
      {
        key: 'codex',
        route: 'acp:codex',
        name: 'Codex',
        models: [{ id: 'gpt', name: 'gpt' }],
      },
      {
        key: 'qwen',
        route: 'acp:qwen',
        name: 'Qwen',
        models: [],
        failure: 'lookup failed',
      },
      {
        key: 'deepseek-account',
        route: 'deepseek-account',
        name: 'DeepSeek account',
        models: [],
        failure: 'unavailable',
      },
    ])
  })

  it('没有 groups 列表就是形状错误', () => {
    expect(parseAcpCatalog(null).error).toEqual({ kind: 'shape' })
    expect(parseAcpCatalog({ failures: [] }).error).toEqual({ kind: 'shape' })
  })
})

describe('目录存储', () => {
  it('解开 { ok, value } 包装并进入 ready', async () => {
    const store = createAcpCatalogStore(async () => ({ ok: true, value: catalog }))
    expect(store.getSnapshot()).toEqual({ status: 'idle', agents: [], error: null })
    await store.load()
    expect(store.getSnapshot().status).toBe('ready')
    expect(store.getSnapshot().agents.map(agent => agent.key))
      .toEqual(['deepseek', 'cursor', 'codex', 'qwen', 'deepseek-account'])
  })

  it('主机没有提供方法时是 missing', async () => {
    const store = createAcpCatalogStore(undefined)
    await store.load()
    expect(store.getSnapshot()).toEqual({ status: 'error', agents: [], error: { kind: 'missing' } })
  })

  it('远端拒绝时报出原文，抛错也收成 failed', async () => {
    const denied = createAcpCatalogStore(async () => ({
      ok: false,
      error: { code: 'session/unavailable', message: 'catalog is warming up' },
    }))
    await denied.load()
    expect(denied.getSnapshot().error).toEqual({ kind: 'failed', detail: 'catalog is warming up' })

    const thrown = createAcpCatalogStore(async () => {
      throw new Error('socket closed')
    })
    await thrown.load()
    expect(thrown.getSnapshot().error).toEqual({ kind: 'failed', detail: 'socket closed' })
  })

  it('返回形状不对时是 shape，不把半份目录当真', async () => {
    const store = createAcpCatalogStore(async () => ({ ok: true, value: { groups: 'nope' } }))
    await store.load()
    expect(store.getSnapshot()).toEqual({ status: 'error', agents: [], error: { kind: 'shape' } })
  })

  it('并发 load 共用一次读取；force 才会再读', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const store = createAcpCatalogStore(() => {
      calls += 1
      return new Promise(resolve => {
        release = () => { resolve({ ok: true, value: catalog }) }
      })
    })
    const first = store.load()
    const second = store.load()
    expect(store.getSnapshot().status).toBe('loading')
    release?.()
    await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(store.getSnapshot().status).toBe('ready')

    const third = store.load(true)
    expect(store.getSnapshot().status).toBe('loading')
    release?.()
    await third
    expect(calls).toBe(2)
  })

  it('订阅者在状态落定时收到通知', async () => {
    const store = createAcpCatalogStore(async () => ({ ok: true, value: catalog }))
    const seen: string[] = []
    store.subscribe(() => { seen.push(store.getSnapshot().status) })
    await store.load()
    expect(seen).toEqual(['loading', 'ready'])
  })
})
