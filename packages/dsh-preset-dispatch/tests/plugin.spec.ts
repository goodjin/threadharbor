/**
 * The plugin that actually runs inside a preset.
 *
 * An agent preset is a composition: selecting one mounts its rows. So the
 * behaviour of an external agent has to come from a row inside that
 * composition, which is what this entry is — one row per agent, configured
 * with that agent's transport and dialect.
 *
 * The scope is the filter. A row only sees the agents mounted with it, so a
 * session on some other preset is simply not seen here and keeps its own
 * behaviour with nothing to undo.
 */

import { describe, expect, it, vi } from 'vitest'
import { applyAcpPlugin, type AcpPluginContext } from '../src/plugin.ts'

/** A context carrying only what this entry touches. */
function ctx(): AcpPluginContext & { created(agent: unknown): void } {
  const handlers: ((payload: { agent: unknown }) => void)[] = []
  return {
    on: (_event, handler) => { handlers.push(handler) },
    created: (agent) => { for (const handler of handlers) handler({ agent }) },
  }
}

const session = (preset?: string) => ({
  id: 's1',
  header: preset === undefined ? {} : { agentPreset: preset },
  session: { header: preset === undefined ? {} : { agentPreset: preset } },
})

const CONFIG = { agent: 'grok', url: 'ws://127.0.0.1:2419' }

describe('applyAcpPlugin', () => {
  it('takes over a session created on this preset', () => {
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-grok'))
    expect(patched).toHaveLength(1)
  })

  it('falls back to the session header before the projection is written', () => {
    // The projection is the truth about which preset a session is on now, but it
    // is only written once the preset has been selected — and `agent/created`
    // fires before that write lands. A resolver that returns nothing at that
    // moment would leave every session on a real host unclaimed, silently.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
      presetOf: () => undefined,
    })
    context.created(session('acp-grok'))
    expect(patched).toHaveLength(1)
  })

  it('trusts the projection over a header left by an earlier preset', () => {
    // The header records the preset a session was created with and never
    // changes afterwards, so once a session has moved it is the wrong answer.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
      presetOf: () => 'standard',
    })
    context.created(session('acp-grok'))
    expect(patched).toHaveLength(0)
  })

  it('leaves a session on another preset alone', () => {
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-claude'))
    expect(patched).toEqual([])
  })

  it('leaves a session with no preset alone', () => {
    // The native agent's sessions must keep their own step, with nothing to undo
    // afterwards — that is what keeps native presets behaving as they did.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session())
    expect(patched).toEqual([])
  })

  it('tells the installer which preset and dialect this row is', () => {
    const context = ctx()
    const install = vi.fn()
    applyAcpPlugin(context, 'acp-grok', CONFIG, { install })
    context.created(session('acp-grok'))
    expect(install).toHaveBeenCalledWith(
      expect.anything(),
      'acp-grok',
      expect.objectContaining({ id: 'grok' }),
      expect.any(Map),
    )
  })

  it('ignores a preset it was not configured for', () => {
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-codex'))
    expect(patched).toEqual([])
  })

  it('reports an unknown agent rather than taking the session over', () => {
    // A typo in the config must leave the session on the native agent rather
    // than hand it to a dialect that does not exist.
    const context = ctx()
    const patched: unknown[] = []
    applyAcpPlugin(context, 'acp-grok', { agent: 'nonesuch' }, {
      install: agent => { patched.push(agent) },
    })
    context.created(session('acp-grok'))
    expect(patched).toEqual([])
  })

  it('does not stop working after one session throws', () => {
    const context = ctx()
    let calls = 0
    applyAcpPlugin(context, 'acp-grok', CONFIG, {
      install: () => { calls++; if (calls === 1) throw new Error('one bad session') },
    })
    expect(() => context.created(session('acp-grok'))).not.toThrow()
    context.created(session('acp-grok'))
    expect(calls).toBe(2)
  })
})

