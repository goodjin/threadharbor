/**
 * Whether a handover can carry the whole conversation across.
 *
 * Switching agent mid-conversation means the target has to take the history as
 * it stands. If it cannot, the options are to fail or to quietly carry part of
 * it — and a conversation that starts missing its own earlier turns is worse
 * than one that plainly refuses, because the agent cannot tell what it lost
 * and neither can the user.
 *
 * So this decides before anything is moved, and on failure says by how much.
 */

import { describe, expect, it } from 'vitest'
import { assembleHandover, decideHandover, messagesOf } from '../src/handover.ts'

const BASE = {
  historyTokens: 1_000,
  reservedForOutput: 8_000,
}

describe('decideHandover', () => {
  it('carries the whole history when it fits', () => {
    // The size that survived comes back too, so a caller can record what was
    // actually handed over rather than assuming.
    expect(decideHandover({ ...BASE, targetContextWindow: 200_000 }))
      .toEqual({ kind: 'ok', keptTokens: 1_000 })
  })

  it('carries a history that exactly fills what is left', () => {
    expect(decideHandover({ ...BASE, historyTokens: 192_000, targetContextWindow: 200_000 }).kind).toBe('ok')
  })

  it('refuses a history that does not fit, rather than carrying part of it', () => {
    const d = decideHandover({ ...BASE, historyTokens: 300_000, targetContextWindow: 200_000 })
    expect(d.kind).toBe('too-long')
  })

  it('says by how much it does not fit', () => {
    // Without the numbers the user has no idea whether trimming an old message
    // would be enough, or whether it is off by a thousand or a million.
    const d = decideHandover({ ...BASE, historyTokens: 300_000, targetContextWindow: 200_000 })
    expect(d.kind === 'too-long' && d.shortBy).toBe(108_000)
  })

  it('counts the room reserved for the answer against the history', () => {
    // The space the target needs to reply is not available to the history.
    const d = decideHandover({ ...BASE, historyTokens: 195_000, targetContextWindow: 200_000 })
    expect(d.kind).toBe('too-long')
  })

  it('carries the history when the target declares no limit', () => {
    // An agent that reports no context window is not known to be too small.
    expect(decideHandover({ ...BASE, targetContextWindow: undefined }).kind).toBe('ok')
  })

  it('refuses when there is no room for an answer at all', () => {
    // A target smaller than the reserved output cannot answer anything, so
    // handing it a history — even an empty one — would produce a dead session.
    const d = decideHandover({ ...BASE, historyTokens: 0, targetContextWindow: 4_000 })
    expect(d.kind).toBe('too-long')
  })

  it('refuses a zero-sized target window rather than reading it as unlimited', () => {
    // Zero cannot mean "no limit" — but it is a reported value that makes no
    // sense, so it is rejected as bad input rather than reasoned about. Either
    // way it refuses; what matters is that it never carries the history.
    expect(decideHandover({ ...BASE, targetContextWindow: 0 }).kind).toBe('bad-input')
  })

  it('carries an empty conversation even into a small target', () => {
    const d = decideHandover({ ...BASE, historyTokens: 0, targetContextWindow: 16_000 })
    expect(d.kind).toBe('ok')
  })

  it('allows trimming only when asked for, and says what survives', () => {
    // Trimming is a legitimate choice, but it must be the user's — and the
    // result must state plainly that history was shortened.
    const d = decideHandover({ ...BASE, historyTokens: 300_000, targetContextWindow: 200_000 }, { trim: true })
    expect(d).toMatchObject({ kind: 'trimmed', keptTokens: 192_000, droppedTokens: 108_000 })
  })

  it('does not trim when nothing needs dropping', () => {
    const d = decideHandover({ ...BASE, targetContextWindow: 200_000 }, { trim: true })
    expect(d.kind).toBe('ok')
  })

  it('keeps the newest history when trimming', () => {
    // Trimming the oldest turns keeps the thread coherent; trimming the newest
    // would drop the very exchange the user just had.
    const d = decideHandover({ ...BASE, historyTokens: 300_000, targetContextWindow: 200_000 }, { trim: true })
    expect(d.kind !== 'trimmed' || d.keepsNewest).toBe(true)
  })

  it('refuses a nonsensical history size rather than treating it as small', () => {
    expect(decideHandover({ ...BASE, historyTokens: -1, targetContextWindow: 200_000 }).kind).toBe('bad-input')
  })

  it('refuses a target window that is not a real number', () => {
    const d = decideHandover({ ...BASE, targetContextWindow: Number.NaN })
    expect(d.kind).toBe('bad-input')
  })
})
describe('messagesOf', () => {
  it('reads the human’s and the assistant’s words, and nothing else', () => {
    // Only conversation words travel. System instructions belong to the
    // target, tool traffic is the old agent's scratch work, and injected
    // context is host plumbing — none of it is something the user said.
    const messages = messagesOf([
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '一' }] },
      { role: 'assistant', content: '二' },
      { role: 'system', content: [{ type: 'text', text: '指令' }] },
      { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: '注入' }] },
      { role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: '结果' }] },
      { role: 'user', content: [{ type: 'text', text: '无来源' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', data: 'x' }] },
      '不是对象',
    ])
    expect(messages).toEqual([
      { role: 'user', text: '一' },
      { role: 'assistant', text: '二' },
    ])
  })

  it('carries the text of a message that also has an attachment', () => {
    expect(messagesOf([
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', data: 'x' }] },
    ])).toEqual([{ role: 'user', text: '看图' }])
  })

  it('reads nothing from an absent conversation', () => {
    expect(messagesOf(undefined)).toEqual([])
  })
})

describe('assembleHandover', () => {
  it('states what the block is and labels the roles', () => {
    const text = assembleHandover([
      { role: 'user', text: '一' },
      { role: 'assistant', text: '二' },
    ])
    expect(text).toContain('共 2 条')
    expect(text).toContain('【用户】一')
    expect(text).toContain('【助手】二')
    expect(text).toContain('记录结束')
  })

  it('says zero for an empty conversation rather than pretending', () => {
    expect(assembleHandover([])).toContain('共 0 条')
  })
})
