/**
 * 未知输出块的泵内接线：块落在帧到来时的位置、顺序不被聚合打乱、父子各写各的。
 *
 * 载体是合成工具卡（公告+卡片+结果），由内容写入器展开；这里断言的是写入流：
 * 块的时机、块的次数与内容、子会话帧只写子会话。
 */

import { describe, expect, it } from 'vitest'
import type { AcpFrame } from '@threadharbor/dsh-acp-agent'
import { codexDialect } from '@threadharbor/dsh-acp-agent'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'
import type { StepDecisionLike } from '../src/dispatch.ts'
import type { ChildSessionLike, SubagentSessionHost } from '../src/subagent-sessions.ts'

const DECISION: StepDecisionLike = {
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
}

type Written = { type: string; payload: unknown }

function fakeClient(): AcpClientPort & { deliver(frame: AcpFrame): void; releaseReply(): void } {
  let handler: ((frame: AcpFrame) => void) | undefined
  let release: (() => void) | undefined
  return {
    request: async (method) => {
      if (method === 'session/new') return { sessionId: 'ext1' }
      if (method === 'session/prompt') {
        await new Promise<void>(resolve => { release = resolve })
        return { stopReason: 'end_turn' }
      }
      return {}
    },
    notify: () => {},
    onFrame: (h) => { handler = h },
    deliver: (frame) => { handler?.(frame) },
    releaseReply: () => { release?.() },
  }
}

const parentUpdate = (update: Record<string, unknown>): AcpFrame => ({ method: 'session/update', params: { sessionId: 'ext1', update } })
const childUpdate = (update: Record<string, unknown>): AcpFrame => ({ method: 'session/update', params: { sessionId: 'c1', update } })

/** A turn whose write records every event list it is handed. */
function turnOf(): { turn: { sessionId: string; position: { turn: number; step: number }; produce: () => never[]; write: (events: readonly Written[]) => number }; writes: Written[][] } {
  const writes: Written[][] = []
  return {
    writes,
    turn: {
      sessionId: 'dsh-1',
      position: { turn: 1, step: 1 },
      produce: () => [],
      write: (events: readonly Written[]) => { writes.push([...events]); return writes.length },
    },
  }
}

function rawBlocks(writes: Written[][]): { count: number; kind: string }[] {
  return writes.flat().filter(event => event.type === 'acp/raw-output')
    .map(event => event.payload as { count: number; kind: string })
}

describe('未知输出块接线（run）', () => {
  it('连续同类帧成一块、被正文打断、回合末封块；块的时机在打断帧之前', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(parentUpdate({ sessionUpdate: 'mystery_update', a: 1 }))
    client.deliver(parentUpdate({ sessionUpdate: 'mystery_update', a: 2 }))
    client.deliver(parentUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正文' } }))
    client.deliver(parentUpdate({ sessionUpdate: 'mystery_update', a: 3 }))
    client.releaseReply()
    await running

    const blocks = rawBlocks(writes)
    expect(blocks.map(block => block.count)).toEqual([2, 1])
    expect(blocks[0]!.kind).toBe('mystery_update')
  })

  it('应答与审批帧夹在中间不闭段', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(parentUpdate({ sessionUpdate: 'usage_update', a: 1 }))
    client.deliver({ id: 9, result: {} })
    client.deliver({ id: 10, method: 'session/request_permission', params: {} })
    client.deliver(parentUpdate({ sessionUpdate: 'usage_update', a: 2 }))
    client.releaseReply()
    await running

    expect(rawBlocks(writes).map(block => block.count)).toEqual([2])
  })

  it('写未知块抛错不打死帧流，回合照常收尾', async () => {
    const client = fakeClient()
    const writes: Written[][] = []
    const turn = {
      sessionId: 'dsh-1',
      position: { turn: 1, step: 1 },
      produce: () => [],
      write: (events: readonly Written[]) => {
        if (events.some(event => event.type === 'acp/raw-output')) throw new Error('refused')
        writes.push([...events])
        return writes.length
      },
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    client.deliver(parentUpdate({ sessionUpdate: 'mystery_update', a: 1 }))
    client.releaseReply()
    await expect(running).resolves.toMatchObject({ end: { kind: 'completed' } })
  })
})

describe('未知输出块接线（遥测汇总）', () => {
  it('遥测帧不在中途出块，回合末按种类汇总', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(parentUpdate({ sessionUpdate: 'usage_update', a: 1 }))
    client.deliver(parentUpdate({ sessionUpdate: 'session_info_update', t: 'x' }))
    client.deliver(parentUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '答案' } }))
    client.deliver(parentUpdate({ sessionUpdate: 'usage_update', a: 2 }))
    client.releaseReply()
    await running

    const blocks = rawBlocks(writes)
    expect(blocks.map(block => [block.kind, block.count])).toEqual([
      ['usage_update', 2],
      ['session_info_update', 1],
    ])
    // 汇总批在回合最后才出现：最后一个含遥测块的写入晚于正文帧到达之后。
    const lastBlockIndex = writes.findIndex((batch, index) =>
      batch.some(event => event.type === 'acp/raw-output')
      && index === writes.length - 2)
    expect(lastBlockIndex).toBeGreaterThanOrEqual(0)
  })
})

describe('未知输出块接线（子会话）', () => {
  it('子会话帧只写子会话：公告+卡片+结果，父会话零未知块', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const emitted: { childId: string; type: string }[] = []
    const parentEvents: string[] = []
    const childAppends: Written[] = []
    let seq = 0
    const host: SubagentSessionHost = {
      available: true,
      openChild(_parent, childId) {
        const child: ChildSessionLike = {
          id: childId,
          header: { createdAt: 1 },
          get seq() { return seq },
          append: (type, payload) => { seq += 1; childAppends.push({ type, payload }); return { seq } },
        }
        return child
      },
      appendParent(_parent, type) { parentEvents.push(type) },
      emitChildStream(child, frame) { emitted.push({ childId: child.id, type: String(frame['type']) }) },
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect, subagents: host })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(parentUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'c1', name: 'Calc', task: 't' }))
    client.deliver(childUpdate({ sessionUpdate: 'mystery_update', x: 1 }))
    client.deliver(childUpdate({ sessionUpdate: 'mystery_update', x: 2 }))
    client.deliver(childUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }))
    client.releaseReply()
    await running

    expect(rawBlocks(writes)).toEqual([])
    const types = childAppends.map(entry => entry.type)
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
    const card = childAppends.find(entry => entry.type === 'tool/call')!.payload as { name: string }
    expect(card.name).toContain('mystery_update')
    const result = childAppends.find(entry => entry.type === 'tool/result')!.payload as { message: { content: { text: string }[] } }
    expect(result.message.content[0]!.text).toContain('（2 帧）')
    expect(emitted.some(entry => entry.type === 'chunk')).toBe(true)
  })
})
