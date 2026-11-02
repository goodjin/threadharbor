/**
 * 去重：各 agent 下面的模型如果相同，列表里不重复展示。
 *
 * 用户 2026-10-12 反馈：「各 Agent 下面的模型如果相同则去重，不要展示多个」。
 * 在 agent 粒度去重——同一个 preset 在目录里出现多次（例如一个 provider 列在
 * groups 里、又在 failures 里因运行时解析失败被再列一次），列表只该有一个入口。
 * 去重按 presetId，保留首次出现的那条（groups 先于 failures，所以保留的是
 * provider 那条，不是失败兜底那条）。探针按 presetId 触发，重复的 presetId
 * 会指向同一个 agent，去掉重复不丢能力。
 *
 * 纯函数，单独测；面板从 agents 端口读到列表后先过它再渲染。
 */

import { describe, expect, it } from 'vitest'
import { dedupeAgents } from '../src/panel.tsx'
import type { AgentDescriptor } from '../src/gateway.ts'

const agent = (presetId: string, label = presetId): AgentDescriptor => ({ presetId, label })

describe('agent 列表去重', () => {
  it('同一个 presetId 出现多次时只保留一个', () => {
    const result = dedupeAgents([agent('acp-codex'), agent('acp-claude'), agent('acp-codex')])
    expect(result.map(a => a.presetId)).toEqual(['acp-codex', 'acp-claude'])
  })

  it('保留首次出现的那条，顺序不变', () => {
    const result = dedupeAgents([
      agent('acp-codex', 'Codex 主'),
      agent('acp-codex', 'Codex 重复'),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.label).toBe('Codex 主')
  })

  it('没有重复时原样返回', () => {
    const list = [agent('acp-codex'), agent('acp-claude'), agent('acp-grok')]
    expect(dedupeAgents(list)).toEqual(list)
  })

  it('空列表返回空', () => {
    expect(dedupeAgents([])).toEqual([])
  })
})
