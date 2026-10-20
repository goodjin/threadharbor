/**
 * The pure half of provider visibility: parsing, canonical form, edits,
 * filtering.
 *
 * These functions are where a corrupt stored value, a blank id, or a hidden
 * provider with a still-visible failure row is decided. The picker filter and
 * the settings section are thin over them, so the edge cases are pinned here.
 */

import { describe, expect, it } from 'vitest'
import {
  ACP_VISIBILITY_STORAGE_KEY,
  agentHidden,
  emptyAcpVisibility,
  modelHidden,
  normalizeAcpVisibility,
  parseAcpVisibility,
  serializeAcpVisibility,
  setAgentHidden,
  setModelHidden,
  startAcpVisibility,
  visibilityKeyOfRoute,
  visibleCatalogFailures,
  visibleProviderGroups,
} from '../src/acp-visibility.ts'

const cursor = 'acp:cursor'
const codex = 'acp:codex'

const groups = [
  { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] },
  {
    id: cursor,
    name: 'Cursor',
    models: [{ id: 'grok', name: 'Grok' }, { id: 'sonnet', name: 'Sonnet' }],
  },
  {
    id: codex,
    name: 'Codex',
    models: [{ id: 'gpt', name: 'GPT' }, { id: 'o3', name: 'o3' }],
  },
] as const

const failures = [
  { id: cursor, name: 'Cursor', message: 'lookup failed' },
  { id: 'deepseek-account', name: 'DeepSeek account', message: 'unavailable' },
] as const

function idsOf(groupList: readonly { readonly id: string; readonly models: readonly { readonly id: string }[] }[]): string[] {
  return groupList.map(group => `${group.id}:${group.models.map(model => model.id).join(',')}`)
}

describe('存储值的规范化', () => {
  it('没有值、坏 JSON、非对象都读成「什么都没屏蔽」', () => {
    const reported: string[] = []
    expect(parseAcpVisibility(null)).toEqual(emptyAcpVisibility())
    expect(parseAcpVisibility('   ')).toEqual(emptyAcpVisibility())
    expect(parseAcpVisibility('{oops', message => { reported.push(message) })).toEqual(emptyAcpVisibility())
    expect(parseAcpVisibility('"cursor"', message => { reported.push(message) })).toEqual(emptyAcpVisibility())
    expect(reported).toHaveLength(2)
    expect(reported.join('\n')).toContain('not valid JSON')
    expect(reported.join('\n')).toContain('not an object')
  })

  it('去掉空白、重复和空值，并按稳定顺序排列', () => {
    const parsed = parseAcpVisibility(JSON.stringify({
      hiddenAgents: [' codex ', 'cursor', 'codex', '', 42],
      hiddenModels: {
        codex: [' gpt ', 'gpt', ''],
        '  ': ['x'],
        cursor: [],
      },
    }))
    expect(parsed).toEqual({
      hiddenAgents: ['codex', 'cursor'],
      hiddenModels: { codex: ['gpt'] },
    })
  })

  it('规范化幂等，序列化后完全一致', () => {
    const first = normalizeAcpVisibility({
      hiddenAgents: ['cursor', 'cursor'],
      hiddenModels: { [codex]: ['o3', 'gpt'] },
    })
    const second = normalizeAcpVisibility(first)
    expect(second).toEqual(first)
    expect(serializeAcpVisibility(first)).toBe(serializeAcpVisibility(second))
  })

  it('路由取键：acp: 路线剥掉前缀，其余路线原样作键，空 key 不算', () => {
    expect(visibilityKeyOfRoute('acp:cursor')).toBe('cursor')
    expect(visibilityKeyOfRoute('deepseek-account')).toBe('deepseek-account')
    expect(visibilityKeyOfRoute('acp:')).toBeUndefined()
    expect(visibilityKeyOfRoute('')).toBeUndefined()
  })
})

describe('编辑操作', () => {
  it('屏蔽/恢复整个 agent 不丢它下面的模型选择', () => {
    const oneModel = setModelHidden(emptyAcpVisibility(), 'codex', 'gpt', true)
    const wholeAgent = setAgentHidden(oneModel, 'codex', true)
    expect(agentHidden(wholeAgent, 'codex')).toBe(true)
    expect(modelHidden(wholeAgent, 'codex', 'gpt')).toBe(true)
    const back = setAgentHidden(wholeAgent, 'codex', false)
    expect(agentHidden(back, 'codex')).toBe(false)
    expect(back.hiddenModels).toEqual({ codex: ['gpt'] })
  })

  it('模型列表空了就把这个 agent 的键删掉', () => {
    const hidden = setModelHidden(emptyAcpVisibility(), 'codex', 'gpt', true)
    const back = setModelHidden(hidden, 'codex', 'gpt', false)
    expect(back.hiddenModels).toEqual({})
  })

  it('每次编辑都返回新对象，原对象不动', () => {
    const before = emptyAcpVisibility()
    const after = setAgentHidden(before, 'cursor', true)
    expect(before.hiddenAgents).toEqual([])
    expect(after.hiddenAgents).toEqual(['cursor'])
  })
})

describe('目录过滤', () => {
  it('什么都没屏蔽时原样返回同一个数组', () => {
    expect(visibleProviderGroups(groups, emptyAcpVisibility())).toBe(groups)
    expect(visibleCatalogFailures(failures, emptyAcpVisibility())).toBe(failures)
  })

  it('屏蔽整个 agent：分组与它的失败行一起消失，别的组不动', () => {
    const visibility = setAgentHidden(emptyAcpVisibility(), 'cursor', true)
    expect(idsOf(visibleProviderGroups(groups, visibility))).toEqual([
      'deepseek:chat',
      'acp:codex:gpt,o3',
    ])
    expect(visibleCatalogFailures(failures, visibility).map(failure => failure.id))
      .toEqual(['deepseek-account'])
  })

  it('原生 provider 与 ACP agent 一样可屏蔽：分组、失败行认同一个键', () => {
    let visibility = setAgentHidden(emptyAcpVisibility(), 'deepseek', true)
    visibility = setAgentHidden(visibility, 'deepseek-account', true)
    expect(idsOf(visibleProviderGroups(groups, visibility))).toEqual([
      'acp:cursor:grok,sonnet',
      'acp:codex:gpt,o3',
    ])
    expect(visibleCatalogFailures(failures, visibility).map(failure => failure.id))
      .toEqual(['acp:cursor'])
  })

  it('原生 provider 的模型也能单个屏蔽，键就是它的 provider id', () => {
    const nativeGroups = [
      {
        id: 'deepseek-account',
        name: 'DeepSeek account',
        models: [{ id: 'chat', name: 'Chat' }, { id: 'reasoner', name: 'Reasoner' }],
      },
    ] as const
    const visibility = setModelHidden(emptyAcpVisibility(), 'deepseek-account', 'chat', true)
    expect(idsOf(visibleProviderGroups(nativeGroups, visibility)))
      .toEqual(['deepseek-account:reasoner'])
  })

  it('屏蔽个别模型：只去掉那一项，模型名与推理信息保留', () => {
    const visibility = setModelHidden(emptyAcpVisibility(), 'codex', 'gpt', true)
    const visible = visibleProviderGroups(groups, visibility)
    expect(idsOf(visible)).toEqual(['deepseek:chat', 'acp:cursor:grok,sonnet', 'acp:codex:o3'])
    expect(visible[2]).not.toBe(groups[2])
  })

  it('一个 agent 的模型全被屏蔽时，整个分组不出现', () => {
    let visibility = setModelHidden(emptyAcpVisibility(), 'codex', 'gpt', true)
    visibility = setModelHidden(visibility, 'codex', 'o3', true)
    expect(idsOf(visibleProviderGroups(groups, visibility))).toEqual([
      'deepseek:chat',
      'acp:cursor:grok,sonnet',
    ])
  })

  it('模型级屏蔽不影响失败行——失败行里没有模型可认', () => {
    const visibility = setModelHidden(emptyAcpVisibility(), 'qwen', 'qwen-max', true)
    expect(visibleCatalogFailures(failures, visibility)).toBe(failures)
  })
})

describe('可见性存储', () => {
  function memoryStorage(initial?: string): {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    values: Map<string, string>
  } {
    const values = new Map<string, string>()
    if (initial !== undefined) values.set(ACP_VISIBILITY_STORAGE_KEY, initial)
    return {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      values,
    }
  }

  it('从存储读出初值；set 写回并通知一次', () => {
    const storage = memoryStorage(JSON.stringify({ hiddenAgents: ['cursor'], hiddenModels: {} }))
    const store = startAcpVisibility(storage)
    expect(store.get().hiddenAgents).toEqual(['cursor'])
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.set(setModelHidden(store.get(), 'codex', 'gpt', true))
    expect(calls).toBe(1)
    expect(JSON.parse(storage.values.get(ACP_VISIBILITY_STORAGE_KEY) ?? '{}')).toEqual({
      hiddenAgents: ['cursor'],
      hiddenModels: { codex: ['gpt'] },
    })
  })

  it('值没变就不写、不通知', () => {
    const storage = memoryStorage()
    const store = startAcpVisibility(storage)
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.set(emptyAcpVisibility())
    expect(calls).toBe(0)
    expect(storage.values.has(ACP_VISIBILITY_STORAGE_KEY)).toBe(false)
  })

  it('refresh 读到别处的改动才通知（水合、另一个标签页）', () => {
    const storage = memoryStorage()
    const store = startAcpVisibility(storage)
    let calls = 0
    store.subscribe(() => { calls += 1 })
    storage.values.set(ACP_VISIBILITY_STORAGE_KEY, JSON.stringify({ hiddenAgents: ['qwen'], hiddenModels: {} }))
    store.refresh()
    expect(store.get().hiddenAgents).toEqual(['qwen'])
    expect(calls).toBe(1)
    store.refresh()
    expect(calls).toBe(1)
  })
})
