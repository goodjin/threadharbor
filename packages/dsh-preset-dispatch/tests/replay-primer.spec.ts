/**
 * 历史回灌：把 DSH 会话自己的转录交给外部 agent 的第一条提问。
 *
 * 外部会话是首开时新建的，但 DSH 会话的记录可能早就有了——最典型的是宿主重启：
 * 会话日志在，外部连接没了，第一条提问就要替一个"失忆"的 agent 把之前的对话
 * 补上。回灌文本骑在首条提问前面；agent 拒收（超长、不支持）时，回合以错误
 * 结束并写明是回灌被拒，而不是让这一轮悄悄丢掉。
 *
 * 这些测试钉住的性质：
 *
 * - 回灌只发生在外部会话的首开，之后的回合不再携带；
 * - 没有可回灌的转录时，提问保持原样；
 * - 回灌随第一条提问发出而提问被拒时，回合以 `error` 结束且消息写明"历史回灌被拒绝"；
 * - 没有回灌时，提问失败照旧抛出（原有错误路径不变）；
 * - 移交（primer）优先于回灌，两者不同时出现。
 */

import { describe, expect, it } from 'vitest'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'
import { makeSwitchShared } from '../src/switch-shared.ts'
import type { StepDecisionLike } from '../src/dispatch.ts'

/** Records every call so the tests can assert on the prompt that was sent. */
function fakeClient() {
  const calls: { method: string; params: unknown }[] = []
  let nextSession = 1
  const client: AcpClientPort & { calls: typeof calls } = {
    calls,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'session/new') return { sessionId: `s${nextSession++}` }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    },
    notify: () => {},
    onFrame: () => {},
  }
  return client
}

const TURN = { sessionId: 's1', position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 }

const decision = (text: string): StepDecisionLike => ({
  kind: 'enter',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
})

/** The prompt text of the n-th `session/prompt` call (0-based). */
function promptOf(client: ReturnType<typeof fakeClient>, index: number): string {
  const prompts = client.calls.filter(call => call.method === 'session/prompt')
  const params = prompts[index]!.params as { prompt: { text: string }[] }
  return params.prompt[0]!.text
}

describe('AcpTurnRunner — 历史回灌', () => {
  it('首开时把转录整理成之前对话随首条提问发出，之后不再带', async () => {
    const client = fakeClient()
    let takes = 0
    const runner = new AcpTurnRunner(client, {
      cwd: '/tmp',
      replay: {
        take: () => {
          takes += 1
          return '用户：上次聊了重构\n助手：好'
        },
      },
    })

    await runner.run(decision('继续'), TURN)
    await runner.run(decision('再问一次'), TURN)

    const first = promptOf(client, 0)
    expect(first).toContain('【之前对话】')
    expect(first).toContain('上次聊了重构')
    expect(first).toContain('【当前问题】')
    expect(first).toContain('继续')
    // The second turn talks to a conversation that already has its history.
    expect(promptOf(client, 1)).not.toContain('【之前对话】')
    expect(takes).toBe(1)
  })

  it('没有转录时只发当前提问', async () => {
    const client = fakeClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', replay: { take: () => undefined } })

    await runner.run(decision('继续'), TURN)

    expect(promptOf(client, 0)).toBe('继续')
  })

  it('首条提问被拒时回合以错误结束并写明历史回灌被拒绝', async () => {
    // The replay rode this prompt, so it is the likeliest reason the agent
    // refused it; the turn says so instead of dying with a bare agent error.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') throw new Error('prompt too long')
      return {}
    }
    const runner = new AcpTurnRunner(client, {
      cwd: '/tmp',
      replay: { take: () => '用户：上次聊了重构\n助手：好' },
    })

    const result = await runner.run(decision('继续'), TURN)

    expect(result.end).toMatchObject({
      kind: 'error',
      error: { message: expect.stringContaining('历史回灌被拒绝') },
    })
    expect((result.end as { error: { message: string } }).error.message).toContain('prompt too long')
  })

  it('没有回灌时提问失败按类别收尾，而不是抛原始错误', async () => {
    // The failure ends the turn as a classified error row, the same seam every
    // other failed turn takes; the replay path alone keeps its own named
    // ending. The fake's text is not `acp `-shaped, so it classifies as the
    // neutral internal bucket, not a connection failure.
    const client = fakeClient()
    client.request = async (method, params) => {
      client.calls.push({ method, params })
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') throw new Error('agent died')
      return {}
    }
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', replay: { take: () => undefined } })

    const result = await runner.run(decision('继续'), TURN)
    expect(result.end).toMatchObject({ kind: 'error', error: { code: 'ACP_INTERNAL' } })
  })

  it('移交优先：有移交的回合不再取回灌', async () => {
    const client = fakeClient()
    let takes = 0
    const runner = new AcpTurnRunner(client, {
      cwd: '/tmp',
      primer: { take: () => '【移交记录】', restore: () => {} },
      replay: {
        take: () => {
          takes += 1
          return '用户：历史'
        },
      },
    })

    await runner.run(decision('继续'), TURN)

    expect(takes).toBe(0)
    expect(promptOf(client, 0)).toBe('【移交记录】\n\n继续')
  })
})

describe('replayPrimer', () => {
  const LONG_RESULT = `开头标记${'x'.repeat(600)}结尾标记`
  const LONG_ANSWER = '长'.repeat(2000)

  /** A finished turn plus the question of the turn now opening. */
  function transcript(): readonly unknown[] {
    return [
      { type: 'request/header', data: { header: {}, reason: 'initial' } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '问题a' }] } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: LONG_ANSWER }] }, stream: [] } },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: LONG_RESULT }] } } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      // The question of the turn that is opening right now: written to the log
      // before its step runs, so it must read as the question, not as history.
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '继续' }] } },
    ]
  }

  function sharedWithSession(events: readonly unknown[]): ReturnType<typeof makeSwitchShared> {
    return makeSwitchShared({ sessionById: id => (id === 'n1' ? { snapshotEvents: () => events } : undefined) })
  }

  it('按顺序整理用户、助手、工具标题与结果，且只截断工具结果本身', () => {
    const text = sharedWithSession(transcript()).replayPrimer('n1')

    expect(text).toContain('【用户】问题a')
    expect(text).toContain(`【助手】${LONG_ANSWER}`)
    expect(text).toContain('【工具】read')
    const resultLine = text!.split('\n').find(line => line.includes('【工具结果】'))
    expect(resultLine).toContain('开头标记')
    expect(resultLine!.length).toBeLessThanOrEqual('【工具结果】'.length + 500 + 1)
    expect(text).not.toContain('结尾标记')
    // The order is the conversation's own order.
    expect(text!.indexOf('问题a')).toBeLessThan(text!.indexOf('read'))
    // The current question travels as the question, not as history.
    expect(text).not.toContain('继续')
  })

  it('读不到会话或没有可回灌的转录时返回 undefined', () => {
    expect(makeSwitchShared().replayPrimer('n1')).toBeUndefined()
    expect(sharedWithSession(transcript()).replayPrimer('missing')).toBeUndefined()
    // A brand-new session's log holds only the question now being asked.
    expect(sharedWithSession([transcript()[9]!]).replayPrimer('n1')).toBeUndefined()
  })
})
