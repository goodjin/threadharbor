/**
 * 子代理帧接线：泵把出生帧、子会话增量、终态帧接到影子子会话上。
 *
 * 两条路径（run 就地回答 / runSteps 接管）共用同一个泵；这里钉的是接线本身：
 * 帧到场时宿主被正确调用、没有端口时零调用、父回合结束的通知按时发出。
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

function fakeClient(): AcpClientPort & { deliver(frame: AcpFrame): void; releaseReply(): void } {
  let handler: ((frame: AcpFrame) => void) | undefined
  let release: (() => void) | undefined
  let nextSession = 1
  return {
    request: async (method) => {
      if (method === 'session/new') return { sessionId: `ext${nextSession++}` }
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

function fakeHost(): {
  host: SubagentSessionHost
  opened: string[]
  parentEvents: { type: string; payload: unknown }[]
  emitted: { childId: string; type: string }[]
  childAppends: Map<string, { type: string; payload: unknown }[]>
} {
  const opened: string[] = []
  const parentEvents: { type: string; payload: unknown }[] = []
  const emitted: { childId: string; type: string }[] = []
  const childAppends = new Map<string, { type: string; payload: unknown }[]>()
  const host: SubagentSessionHost = {
    available: true,
    openChild(_parent, childId) {
      opened.push(childId)
      const appends: { type: string; payload: unknown }[] = []
      childAppends.set(childId, appends)
      let seq = 0
      const child: ChildSessionLike = {
        id: childId,
        header: { createdAt: 1 },
        get seq() { return seq },
        append: (type, payload) => { seq += 1; appends.push({ type, payload }); return { seq } },
      }
      return child
    },
    appendParent(_parent, type, payload) { parentEvents.push({ type, payload }) },
    emitChildStream(child, frame) { emitted.push({ childId: child.id, type: String(frame['type']) }) },
  }
  return { host, opened, parentEvents, emitted, childAppends }
}

const parentUpdate = (update: Record<string, unknown>): AcpFrame => ({ method: 'session/update', params: { sessionId: 'ext1', update } })
const childUpdate = (update: Record<string, unknown>): AcpFrame => ({ method: 'session/update', params: { sessionId: 'c1', update } })

const SPAWN = parentUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'c1', name: 'Calc', task: 'do math' })
const CHILD_TEXT = childUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } })
const TERMINAL = parentUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'c1', state: 'completed' })

describe('子代理帧接线（run）', () => {
  it('出生帧建会话、增量进流、终态收尾、回合末通知父回合结束', async () => {
    const client = fakeClient()
    const { host, opened, parentEvents, childAppends, emitted } = fakeHost()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect, subagents: host })
    const turn = {
      sessionId: 'dsh-1',
      position: { turn: 1, step: 1 },
      produce: () => [],
      write: () => 1,
    }
    const running = runner.run(DECISION, turn)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    client.deliver(SPAWN)
    client.deliver(CHILD_TEXT)
    client.deliver(TERMINAL)
    client.releaseReply()
    await running

    expect(opened).toEqual(['acp-sub-c1'])
    expect(parentEvents.map(entry => entry.type)).toEqual(['subagent/catalog'])
    expect(childAppends.get('acp-sub-c1')!.map(entry => entry.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(emitted.filter(entry => entry.type === 'chunk').length).toBeGreaterThan(0)
    expect(emitted.filter(entry => entry.type === 'end')).toHaveLength(1)
  })

  it('无端口时零调用，回合照常收尾', async () => {
    const client = fakeClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect })
    const turn = { sessionId: 'dsh-1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 }
    const running = runner.run(DECISION, turn)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    client.deliver(SPAWN)
    client.deliver(CHILD_TEXT)
    client.deliver(TERMINAL)
    client.releaseReply()
    const result = await running
    expect(result.end.kind).toBe('completed')
  })

  it('无 id 的出生帧：首个子会话帧懒建会话（grok）', async () => {
    const client = fakeClient()
    const { host, opened, parentEvents } = fakeHost()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect, subagents: host })
    const turn = { sessionId: 'dsh-1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 }
    const running = runner.run(DECISION, turn)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    client.deliver(parentUpdate({ sessionUpdate: 'subagent_spawned', description: 'Trivial arithmetic check' }))
    client.deliver(childUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }))
    client.releaseReply()
    await running

    expect(opened).toEqual(['acp-sub-c1'])
    expect(parentEvents[0]!.payload).toMatchObject({ label: 'Trivial arithmetic check' })
  })
})

describe('子代理帧接线（runSteps）', () => {
  it('末段收尾时通知父回合结束，终态帧在任意段之间都能收尾', async () => {
    const client = fakeClient()
    const { host, opened, childAppends } = fakeHost()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: codexDialect, subagents: host })
    const first = runner.runSteps(DECISION, {
      sessionId: 'dsh-1',
      position: { turn: 1, step: 1 },
      produce: () => [],
      write: () => 1,
    }, { first: true })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    client.deliver(SPAWN)
    client.deliver(CHILD_TEXT)
    // Segment 1 closes only after a tool batch: open, settle, then new content.
    client.deliver(parentUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'in_progress', kind: 'execute', rawInput: { command: 'ls' } }))
    client.deliver(parentUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: { formatted_output: 'ok' } }))
    client.deliver(parentUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'parent text' } }))
    client.deliver(parentUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'next' } }))
    await expect(first).resolves.toBeNull()

    const second = runner.runSteps(DECISION, {
      sessionId: 'dsh-1',
      position: { turn: 1, step: 2 },
      produce: () => [],
      write: () => 1,
    }, { first: false })
    client.deliver(TERMINAL)
    client.deliver(childUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tail' } }))
    client.releaseReply()
    const end = await second

    expect(opened).toEqual(['acp-sub-c1'])
    expect(end).toEqual({ kind: 'completed' })
    expect(childAppends.get('acp-sub-c1')!.map(entry => entry.type)).toContain('turn/end')
  })
})
