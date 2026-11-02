/**
 * The gateway's feed plan: what one native step's request means for the
 * external conversation — prime on first contact, increments afterwards, and
 * loud refusals for the states that would silently corrupt the context.
 *
 * Only the human's own messages are user input. Injected context also rides in
 * the user role (`agent-instructions`, `runtime-context`, …), and tool results
 * are role `tool`; neither is something the external agent has not already
 * seen through its own conversation, and re-feeding them is what once built a
 * 1.2-million-character prompt out of a 122-character question.
 */

import { describe, expect, it } from 'vitest'
import { feedCountsOf, planFeed } from '../src/gateway-feed.ts'
import type { FeedPlan } from '../src/gateway-feed.ts'

const system = { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'You are a harness agent.' }] }
const user = (text: string) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }], id: `u-${text}` })
const assistant = (text: string) => ({
  role: 'assistant',
  source: { kind: 'model', provider: 'deepseek', model: 'chat' },
  content: [{ type: 'text', text }],
  id: `a-${text}`,
})
const injected = (text: string, kind = 'agent-instructions') => ({
  role: 'user',
  source: { kind },
  content: [{ type: 'text', text }],
  id: `i-${kind}-${text}`,
})
const tool = (text: string) => ({
  role: 'tool',
  source: { kind: 'tool', callId: 'c1' },
  content: [{ type: 'text', text }],
  id: 't-1',
})
const attached = (text: string | undefined, block: { type: string; [extra: string]: unknown } = {
  type: 'image',
  data: 'aGVsbG8=',
  mimeType: 'image/png',
}) => ({
  role: 'user',
  source: { kind: 'user' },
  content: [...(text === undefined ? [] : [{ type: 'text', text }]), block],
  id: 'u-attached',
})

function planOf(messages: readonly unknown[], cursor?: Parameters<typeof planFeed>[1]): FeedPlan {
  return planFeed(messages, cursor)
}

describe('planFeed — first request', () => {
  it('primes with the prior conversation and asks the trailing question', () => {
    // The pick lands mid-conversation: the native model's earlier turns are
    // history the external agent has not seen, and they travel as a primer —
    // the same assembly the retired fork used, so the agent reads the same
    // handover block either way.
    const question = user('那再总结一下')
    const plan = planOf([system, user('先帮我看下这个服务'), assistant('好的，我看了。'), question], undefined)
    expect(plan.kind).toBe('first')
    if (plan.kind !== 'first') return
    expect(plan.prompt).toBe('那再总结一下')
    expect(plan.messages).toEqual([question])
    expect(plan.primer).toContain('先帮我看下这个服务')
    expect(plan.primer).toContain('好的，我看了。')
    expect(plan.primer).not.toContain('You are a harness agent.')
    expect(plan.cursor.fed).toBe(3)
  })

  it('keeps tool traffic and injected context out of the primer', () => {
    // The primer is conversation words, not the old agent's scratch work:
    // handing over a 1 MB tool result would overflow the target before the
    // first question is even asked.
    const plan = planOf([
      system,
      user('先看下这个服务'),
      injected('这里的指令只属于宿主'),
      tool('x'.repeat(200_000)),
      assistant('看完了'),
      user('总结一下'),
    ], undefined)
    expect(plan.kind).toBe('first')
    if (plan.kind !== 'first') return
    expect(plan.primer).toContain('先看下这个服务')
    expect(plan.primer).toContain('【助手】看完了')
    expect(plan.primer).not.toContain('只属于宿主')
    expect(plan.primer).not.toContain('xxxxxxxxxx')
    expect(plan.primer.length).toBeLessThan(1_000)
    expect(plan.prompt).toBe('总结一下')
  })

  it('sends no primer when the conversation is just the question', () => {
    const plan = planOf([system, user('你好')], undefined)
    expect(plan).toMatchObject({ kind: 'first', primer: '', prompt: '你好' })
  })

  it('does not read a missing source as human input', () => {
    // The host validates a source on every durable message, but a shape
    // without one is still not evidence of a human: refusing is recoverable,
    // guessing can leak injected context to the agent as a question.
    const plan = planOf([system, { role: 'user', content: [{ type: 'text', text: '无来源' }] }], undefined)
    expect(plan.kind).toBe('nothing')
  })

  it('keeps an attachment-only question and asks it as an attachment', () => {
    const picture = attached(undefined)
    const plan = planOf([system, user('先前的问'), assistant('先前的答'), picture], undefined)
    expect(plan.kind).toBe('first')
    if (plan.kind !== 'first') return
    expect(plan.prompt).toBe('')
    expect(plan.messages).toEqual([picture])
    expect(plan.primer).toContain('先前的问')
  })

  it('refuses a human message that carries neither text nor an attachment', () => {
    const empty = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '' }], id: 'u-empty' }
    const plan = planOf([system, user('第一问'), empty], undefined)
    expect(plan.kind).toBe('nothing')
  })
})

describe('planFeed — later requests', () => {
  it('feeds only the new user-side text and skips the external agent’s own words', () => {
    // The assistant message between the two requests is the external agent's
    // answer arriving back through the native loop; re-sending it would make
    // the agent argue with its own transcript.
    const question = user('第二问')
    const plan = planOf(
      [system, user('第一问'), assistant('第一答'), question],
      { fed: 1 },
    )
    expect(plan).toMatchObject({ kind: 'next', prompt: '第二问' })
    if (plan.kind !== 'next') return
    expect(plan.messages).toEqual([question])
    expect(plan.cursor.fed).toBe(3)
  })

  it('never re-feeds the first turn’s tool results, injected context, or reply', () => {
    // 2026-10-27 session 8b518c00: a 1,048,607-character bash result from the
    // first turn was joined into the second request, turning a 122-character
    // question into 1,221,980 characters — over codex's 1,048,576 limit. The
    // agent already owns those tool calls; they are not new user input.
    const first = user('看看这个仓库')
    const second = user('继续修')
    const plan = planOf([
      system,
      first,
      injected('宿主指令'.repeat(100), 'agent-instructions'),
      injected('运行上下文'.repeat(100), 'runtime-context'),
      tool('工具输出'.repeat(100_000)),
      assistant('看完了'),
      second,
    ], { fed: 1 })
    expect(plan.kind).toBe('next')
    if (plan.kind !== 'next') return
    expect(plan.prompt).toBe('继续修')
    expect(plan.messages).toEqual([second])
    expect(plan.prompt.length).toBe(second.content[0]!.text.length)
    expect(plan.cursor.fed).toBe(6)
  })

  it('feeds every new human message, not only the last one', () => {
    const second = user('改问这个')
    const third = user('还有这个')
    const plan = planOf(
      [system, user('第一问'), assistant('第一答'), second, injected('注入', 'user-approval'), tool('结果'), third],
      { fed: 1 },
    )
    expect(plan.kind).toBe('next')
    if (plan.kind !== 'next') return
    expect(plan.prompt).toBe('改问这个\n还有这个')
    expect(plan.messages).toEqual([second, third])
  })

  it('finds the new human question even when injected context trails it', () => {
    // The literal last message is not always the question: the loop can append
    // context after it. Requiring the array to end in a user message would
    // refuse a perfectly askable turn.
    const question = user('新问题')
    const plan = planOf(
      [system, user('第一问'), injected('当步上下文', 'runtime-context'), question, injected('尾部注入', 'watcher')],
      { fed: 1 },
    )
    expect(plan.kind).toBe('next')
    if (plan.kind !== 'next') return
    expect(plan.prompt).toBe('新问题')
    expect(plan.messages).toEqual([question])
  })

  it('refuses when the increment carries only injected context or tool traffic', () => {
    const plan = planOf(
      [system, user('第一问'), injected('指令', 'agent-instructions'), tool('结果')],
      { fed: 1 },
    )
    expect(plan.kind).toBe('nothing')
  })

  it('refuses when nothing new arrived on the user side', () => {
    const plan = planOf([system, user('第一问'), assistant('第一答')], { fed: 1 })
    // The trailing message is not a user message: there is no question to ask.
    expect(plan.kind).toBe('nothing')
  })

  it('refuses when the history got shorter than what was already fed', () => {
    // Compaction rewrites the derived history; feeding the external agent the
    // whole transcript again would duplicate everything it already holds.
    const plan = planOf([system, user('压缩后的问题')], { fed: 5 })
    expect(plan.kind).toBe('nothing')
    if (plan.kind !== 'nothing') return
    expect(plan.reason).toContain('compact')
  })

  it('carries attachments alongside their text', () => {
    const question = attached('这是什么颜色')
    const plan = planOf([system, user('第一问'), assistant('第一答'), question], { fed: 1 })
    expect(plan.kind).toBe('next')
    if (plan.kind !== 'next') return
    expect(plan.prompt).toBe('这是什么颜色')
    expect(plan.messages).toEqual([question])
  })
})

describe('feedCountsOf — diagnostics categories', () => {
  it('separates human input from injected context, tools, and the agent’s words', () => {
    const counts = feedCountsOf([
      system,
      user('第一问'),
      assistant('第一答'),
      injected('指令'),
      tool('结果'),
      { role: 'user', content: [{ type: 'text', text: '无来源' }] },
      { role: 'narrator', content: [{ type: 'text', text: '旁白' }] },
    ], undefined)
    expect(counts).toEqual({
      total: 7,
      human: 1,
      assistant: 1,
      tool: 1,
      injected: 1,
      system: 1,
      other: 2,
    })
  })
})
