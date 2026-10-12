/**
 * 模型清单去重 + 思考强度独立出来。
 *
 * 用户 2026-10-12 反馈：「现在的模型列表包含了思考强度，导致一个模型出现了多次，
 * 应该将思考强度独立出来作为单独一个选择框。」以及「各 Agent 下面的模型如果相同
 * 则去重，不要展示多个」。
 *
 * 根因（真机探针确认，见会话记录）：codex-acp 把思考强度拼进模型 id——`gpt-6-astra[low]`、
 * `[medium]`、`[high]`、`[xhigh]`、`[max]`、`[ultra]` 是六个**真实不同的 wire id**，不是
 * 显示标签。claude / grok 则是裸 id（default/opus/sonnet…），不带任何强度后缀。
 *
 * 因此「去重 + 强度独立」必须数据驱动、按 agent 各自处理，不能写死一张后缀表：
 * - 带 `[后缀]` 的项按基础模型归并，基础模型只出现一次，各后缀收进 reasoning.efforts；
 * - 裸 id 原样保留，reasoning 不带（DSH 的选择器只在模型带 reasoning 时渲染强度子控件）。
 *
 * 基础 id 取「同一基础下出现次数最多」的那个写法，平手取首次出现——清单本来自真机探针，
 * 同一模型的六项写法一致，这个规则只是稳定兜底。拼回时按 effort.id 原样拼回 `base[id]`，
 * 与 agent 接受的 wire id 一字不差。
 */

import { describe, expect, it } from 'vitest'
import { collapseEffortModels } from '../src/catalog.ts'

describe('collapseEffortModels', () => {
  it('把同一基础模型的多个 [强度] 归并成一个', () => {
    const result = collapseEffortModels([
      { id: 'gpt-6-astra[low]', name: 'GPT-6-Astra (low)' },
      { id: 'gpt-6-astra[medium]', name: 'GPT-6-Astra (medium)' },
      { id: 'gpt-6-astra[high]', name: 'GPT-6-Astra (high)' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.baseId).toBe('gpt-6-astra')
    expect(result[0]?.displayName).toBe('GPT-6-Astra')
  })

  it('归并后附上各强度的 efforts（含 wire id 与原显示名）', () => {
    const result = collapseEffortModels([
      { id: 'gpt-6-astra[low]', name: 'GPT-6-Astra (low)' },
      { id: 'gpt-6-astra[high]', name: 'GPT-6-Astra (high)' },
    ])
    const efforts = result[0]?.efforts
    expect(efforts?.map(e => e.id)).toEqual(['low', 'high'])
    expect(efforts?.find(e => e.id === 'high')?.name).toBe('GPT-6-Astra (high)')
    expect(efforts?.find(e => e.id === 'high')?.wireId).toBe('gpt-6-astra[high]')
  })

  it('裸 id（无强度后缀）原样保留，不带 efforts', () => {
    const result = collapseEffortModels([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'opus', name: 'Claude Opus' },
    ])
    expect(result).toEqual([
      { baseId: 'default', displayName: 'Default (recommended)', efforts: undefined },
      { baseId: 'opus', displayName: 'Claude Opus', efforts: undefined },
    ])
  })

  it('显示名相同的多个裸 id 归并成一行，wire id 取第一个真实 id', () => {
    // claude 发布 default/opus/fable/sonnet/haiku 五个裸 id，全显示成同一个名字。
    // 旧逻辑按 id 归并 → 五行；按 name 归并 → 一行，且 baseId 必须是真 wire id 而非显示名。
    const result = collapseEffortModels([
      { id: 'default', name: 'GLM-5.3' },
      { id: 'opus', name: 'GLM-5.3' },
      { id: 'fable', name: 'GLM-5.3' },
      { id: 'sonnet', name: 'GLM-5.3' },
      { id: 'haiku', name: 'GLM-5.3' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.baseId).toBe('default')
    expect(result[0]?.displayName).toBe('GLM-5.3')
    expect(result[0]?.efforts).toBeUndefined()
  })

  it('不同基础模型不互相归并', () => {
    const result = collapseEffortModels([
      { id: 'gpt-6-astra[low]', name: 'A (low)' },
      { id: 'gpt-5.6-sol[low]', name: 'S (low)' },
    ])
    expect(result.map(r => r.baseId)).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
  })

  it('空清单返回空', () => {
    expect(collapseEffortModels([])).toEqual([])
  })

  it('去重：基础模型相同的项只出现一次（跨多个后缀）', () => {
    const result = collapseEffortModels([
      { id: 'm[low]', name: 'M (low)' },
      { id: 'm[medium]', name: 'M (medium)' },
      { id: 'm[high]', name: 'M (high)' },
      { id: 'm[xhigh]', name: 'M (xhigh)' },
      { id: 'm[max]', name: 'M (max)' },
      { id: 'm[ultra]', name: 'M (ultra)' },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.efforts?.map(e => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })
})
