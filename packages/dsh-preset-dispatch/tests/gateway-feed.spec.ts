/**
 * The gateway's feed plan: what one native step's request means for the
 * external conversation — prime on first contact, increments afterwards, and
 * loud refusals for the states that would silently corrupt the context.
 */

import { describe, expect, it } from 'vitest'
import { planFeed } from '../src/gateway-feed.ts'

const system = { role: 'system', content: [{ type: 'text', text: 'You are a harness agent.' }] }
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], id: `u-${text}` })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], id: `a-${text}` })

describe('planFeed — first request', () => {
  it('primes with the prior conversation and asks the trailing question', () => {
    // The pick lands mid-conversation: the native model's earlier turns are
    // history the external agent has not seen, and they travel as a primer —
    // the same assembly the retired fork used, so the agent reads the same
    // handover block either way.
    const plan = planFeed([system, user('先帮我看下这个服务'), assistant('好的，我看了。'), user('那再总结一下')], undefined)
    expect(plan.kind).toBe('first')
    if (plan.kind !== 'first') return
    expect(plan.prompt).toBe('那再总结一下')
    expect(plan.primer).toContain('先帮我看下这个服务')
    expect(plan.primer).toContain('好的，我看了。')
    expect(plan.primer).not.toContain('You are a harness agent.')
    expect(plan.cursor.fed).toBe(3)
  })

  it('sends no primer when the conversation is just the question', () => {
    const plan = planFeed([system, user('你好')], undefined)
    expect(plan).toMatchObject({ kind: 'first', primer: '', prompt: '你好' })
  })
})

describe('planFeed — later requests', () => {
  it('feeds only the new user-side text and skips the external agent’s own words', () => {
    // The assistant message between the two requests is the external agent's
    // answer arriving back through the native loop; re-sending it would make
    // the agent argue with its own transcript.
    const plan = planFeed(
      [system, user('第一问'), assistant('第一答'), user('第二问')],
      { fed: 1 },
    )
    expect(plan).toMatchObject({ kind: 'next', prompt: '第二问' })
    if (plan.kind !== 'next') return
    expect(plan.cursor.fed).toBe(3)
  })

  it('refuses when nothing new arrived on the user side', () => {
    const plan = planFeed([system, user('第一问'), assistant('第一答')], { fed: 1 })
    // The trailing message is not a user message: there is no question to ask.
    expect(plan.kind).toBe('nothing')
  })

  it('refuses when the history got shorter than what was already fed', () => {
    // Compaction rewrites the derived history; feeding the external agent the
    // whole transcript again would duplicate everything it already holds.
    const plan = planFeed([system, user('压缩后的问题')], { fed: 5 })
    expect(plan.kind).toBe('nothing')
    if (plan.kind !== 'nothing') return
    expect(plan.reason).toContain('compact')
  })
})
