/**
 * 状态帧的界面接线：状态要更新快照；值得说的状态写一条系统提示。
 *
 * 提示走的是宿主自己的 system/message（source 必须是 system-prompt），不是
 * 卡片也不是原始 JSON——用户要看的是「它在等你审批」这句话本身。
 */

import { describe, expect, it } from 'vitest'
import type { AcpFrame } from '@threadharbor/dsh-acp-agent'
import { codexDialect } from '@threadharbor/dsh-acp-agent'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'
import type { StepDecisionLike } from '../src/dispatch.ts'

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

function turnOf(): {
  turn: { sessionId: string; position: { turn: number; step: number }; produce: () => never[]; write: (events: readonly Written[]) => number }
  writes: Written[][]
} {
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

function systemNotes(writes: Written[][]): string[] {
  return writes.flat()
    .filter(event => event.type === 'system/message')
    .map(event => {
      const message = (event.payload as { message?: { content?: { text?: string }[] } }).message
      return message?.content?.[0]?.text ?? ''
    })
}

const codexStatus = (status: Record<string, unknown>): AcpFrame =>
  parentUpdate({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: status } } })

describe('状态帧接线（run）', () => {
  it('等待审批的状态写一条系统提示，重复上报不重复写', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(codexStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }))
    client.deliver(codexStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }))
    client.releaseReply()
    await running

    expect(systemNotes(writes)).toEqual(['codex 正在处理（等待审批）'])
    expect(runner.lastStatusSnapshot()).toMatchObject({
      key: 'codex:active:waitingOnApproval',
      label: 'codex 正在处理（等待审批）',
      working: true,
    })
  })

  it('普通 active/idle 不写提示，但快照跟着走', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(codexStatus({ type: 'active', activeFlags: [] }))
    client.deliver(codexStatus({ type: 'idle' }))
    client.releaseReply()
    await running

    expect(systemNotes(writes)).toEqual([])
    expect(runner.lastStatusSnapshot()).toMatchObject({ key: 'codex:idle', working: false })
  })

  it('模式切换写提示', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(parentUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'agent' }))
    client.releaseReply()
    await running

    expect(systemNotes(writes)).toEqual(['模式切换：agent'])
  })

  it('压缩上下文更新快照（提示由原始输出卡片承担，不重复写系统提示）', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(parentUpdate({ sessionUpdate: 'compaction_update', status: 'in_progress' }))
    client.releaseReply()
    await running

    expect(systemNotes(writes)).toEqual([])
    expect(runner.lastStatusSnapshot()).toMatchObject({ key: 'compaction:in_progress', working: true })
    const raw = writes.flat().filter(event => event.type === 'acp/raw-output')
    expect(raw.map(event => (event.payload as { kind: string }).kind)).toContain('compaction_update')
  })

  it('子会话的状态帧不写父会话，也不改父会话快照', async () => {
    const client = fakeClient()
    const { turn, writes } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(childUpdate({
      sessionUpdate: 'session_info_update',
      _meta: { codex: { threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } } },
    }))
    client.releaseReply()
    await running

    expect(systemNotes(writes)).toEqual([])
    expect(runner.lastStatusSnapshot()).toBeUndefined()
  })

  it('提示写失败不影响帧流与快照，回合照常收尾', async () => {
    const client = fakeClient()
    const turn = {
      sessionId: 'dsh-1',
      position: { turn: 1, step: 1 },
      produce: () => [],
      write: (events: readonly Written[]) => {
        if (events.some(event => event.type === 'system/message')) throw new Error('refused')
        return 1
      },
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })

    client.deliver(codexStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }))
    client.releaseReply()
    await expect(running).resolves.toMatchObject({ end: { kind: 'completed' } })
    expect(runner.lastStatusSnapshot()).toMatchObject({ key: 'codex:active:waitingOnApproval' })
  })

  it('外部会话 id 在开会话后可见（日志探针按它查）', async () => {
    const client = fakeClient()
    const { turn } = turnOf()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const running = runner.run(DECISION, turn as never)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(runner.externalSessionId()).toBe('ext1')
    client.releaseReply()
    await running
  })
})
