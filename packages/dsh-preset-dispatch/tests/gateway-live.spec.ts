/**
 * The gateway against the real codex binary.
 *
 * Skipped unless `THREADHARBOR_LIVE_ACP=1`: real binary, real model, real wall
 * clock. This is the acceptance gate for in-place answering: a foreign
 * session's first request must prime the external conversation with the
 * transcript and answer in place, and a SECOND request must feed only the
 * increment — the external agent never receives the first question twice.
 */

import { describe, expect, it } from 'vitest'
import { makeSessionFactory } from '../src/factory.ts'
import { GatewayConversations } from '../src/gateway.ts'
import type { GatewayChunk } from '../src/gateway.ts'
import type { PresetConfig } from '../src/registry.ts'

const LIVE = process.env['THREADHARBOR_LIVE_ACP'] === '1'
const CODEX_ACP = process.env['THREADHARBOR_CODEX_ACP'] ?? '/Users/good/.local/bin/codex-acp'

const CONFIG: PresetConfig = {
  presets: {
    'acp-codex': { agent: 'codex', command: CODEX_ACP },
  },
}

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], id: `u-${text}` })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], id: `a-${text}` })

async function answer(gate: GatewayConversations, messages: readonly unknown[]): Promise<{ text: string; finish: string }> {
  const chunks: GatewayChunk[] = []
  await gate.answer('live-s1', 'acp-codex', {
    messages,
    position: { turn: 1, step: 1 },
    modelId: 'gpt-6-astra',
  }, { chunk: c => { chunks.push(c) } })
  const text = chunks.filter((c): c is Extract<GatewayChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    .map(c => c.text).join('')
  const finish = chunks.find(c => c.type === 'finish')
  return { text, finish: JSON.stringify(finish?.reason ?? {}) }
}

describe.skipIf(!LIVE)('gateway against real codex', () => {
  it('answers in place, then answers the follow-up as an increment', async () => {
    const factory = makeSessionFactory(CONFIG, { answerPermission: async () => ({ outcome: 'allow' }) })
    const gate = new GatewayConversations(async (presetId, options) => await factory.open(presetId, {
      cwd: process.cwd(),
      dshSessionId: options.dshSessionId,
      primer: options.primer,
    }))
    try {
      // First request: mid-conversation pick — the history primes, the
      // question rides it. The answer must arrive as a chunk stream ending in
      // a stop finish, exactly what the native loop assembles a message from.
      const first = await answer(gate, [user('记住暗号：潮水'), assistant('好的。'), user('暗号是什么？只回答暗号本身')])
      expect(first.finish).toContain('"stop"')
      expect(first.text).toContain('潮水')

      // Second request on the same session: only the new question may be
      // sent — the external conversation already holds the first exchange.
      const second = await answer(gate, [
        user('记住暗号：潮水'), assistant('好的。'), user('暗号是什么？只回答暗号本身'),
        assistant(first.text), user('现在只回答：退潮'),
      ])
      expect(second.finish).toContain('"stop"')
      expect(second.text).toContain('退潮')
    } finally {
      gate.close('live-s1')
    }
  }, 240_000)
})
