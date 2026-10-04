import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SLICE_CHARS,
  isSliceable,
  pacerOptionsFromEnv,
  pacedSessionUpdate,
  planSlices,
  updateText,
} from '../deploy/acp-stream/stream-pacer.mjs'
import {
  BRIDGE_ANCHOR,
  NOTIFY_ANCHOR,
  NOTIFY_CONTEXT,
  countOccurrences,
  transformAcpSource,
} from '../deploy/acp-stream/acp-source-transform.mjs'

const HELPER_URL = 'file:///tmp/live-stream.mjs'

/** A miniature of the upstream bridge, with both injection sites. */
const UPSTREAM_SHAPE = `import { methods } from './codec.js';
export function apply(ctx, conn) {
\tconst logger = ctx.logger;
\t/** Send one ordered protocol update while containing transport-only failure. */
\tconst notify = async (notification) => {
\t\ttry {
\t\t\t${NOTIFY_ANCHOR}
\t\t} catch (error) {
\t\t\tlogger.warn(\\\`acp: session/update failed: \\\${String(error)}\\\`);
\t\t}
\t};
\tconst connection = connect(logger);
\t${BRIDGE_ANCHOR}
\tctx.on("session/event", (session, event) => {
\t\tvoid notify(event);
\t});
\treturn { notify };
}
`

function locateUpstreamSource() {
  const bases = [
    '/Users/good/.local/share/node-v24.18.1-darwin-arm64/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ]
  for (const base of bases) {
    try {
      return readFileSync(createRequire(base).resolve('@deepseek-ai/dsh-acp'), 'utf8')
    } catch {
      // next base
    }
  }
  return undefined
}

function thought(text, sessionId = 'session-a') {
  return {
    sessionId,
    update: { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text } },
  }
}

function options(overrides = {}) {
  return {
    enabled: true,
    sliceChars: DEFAULT_SLICE_CHARS,
    minIntervalMs: 0,
    maxIntervalMs: 0,
    maxTotalMs: 0,
    sliceKinds: new Set(['agent_thought_chunk', 'agent_message_chunk']),
    ...overrides,
  }
}

describe('acp source transform', () => {
  it('injects the live relay at both sites and keeps upstream wire calls intact', () => {
    const { code, applied } = transformAcpSource(UPSTREAM_SHAPE, HELPER_URL)
    expect(applied).toBe(true)
    // Committed blocks now go through the relay, which de-duplicates them.
    expect(code).not.toContain(NOTIFY_ANCHOR)
    expect(code).toContain('__threadharborNotify(notification, (sliced) => conn.notify(methods.client.session.update, sliced))')
    // The relay is handed the connection as soon as upstream has one, so live
    // chunks can travel on the same channel in order.
    expect(code).toContain(`${BRIDGE_ANCHOR}\n\t__threadharborBridge(conn, methods);`)
    expect(code).toContain(`import { installBridge as __threadharborBridge, notifyThroughBridge as __threadharborNotify } from "${HELPER_URL}"`)
    // The import has to precede module code for ESM.
    expect(code.indexOf('__threadharborNotify } from')).toBeLessThan(code.indexOf('export function apply'))
    // Everything else is untouched.
    expect(code).toContain('ctx.on("session/event", (session, event) => {')
  })

  it('refuses to patch twice', () => {
    const once = transformAcpSource(UPSTREAM_SHAPE, HELPER_URL).code
    const twice = transformAcpSource(once, HELPER_URL)
    expect(twice.applied).toBe(false)
    expect(twice.code).toBe(once)
  })

  it('refuses when the notify shape moved upstream', () => {
    const moved = UPSTREAM_SHAPE.replace(NOTIFY_CONTEXT, 'const notify = async function (n) {')
    const result = transformAcpSource(moved, HELPER_URL)
    expect(result.applied).toBe(false)
    expect(result.reason).toContain('notify() shape changed')
  })

  it('refuses when the connection setup moved upstream', () => {
    const moved = UPSTREAM_SHAPE.replace(BRIDGE_ANCHOR, 'const conn = connection.other;')
    const result = transformAcpSource(moved, HELPER_URL)
    expect(result.applied).toBe(false)
    expect(result.reason).toContain('connection setup changed')
  })

  it('refuses when the notify anchor is no longer unique', () => {
    const doubled = UPSTREAM_SHAPE.replace(NOTIFY_ANCHOR, `${NOTIFY_ANCHOR}\n\t\t\t${NOTIFY_ANCHOR}`)
    const result = transformAcpSource(doubled, HELPER_URL)
    expect(result.applied).toBe(false)
    expect(result.reason).toContain('found 2')
  })

  it('refuses when the connection anchor is no longer unique', () => {
    const doubled = UPSTREAM_SHAPE.replace(BRIDGE_ANCHOR, `${BRIDGE_ANCHOR}\n\t${BRIDGE_ANCHOR}`)
    const result = transformAcpSource(doubled, HELPER_URL)
    expect(result.applied).toBe(false)
    expect(result.reason).toContain('found 2')
  })

  it('applies to the installed dsh-acp build', () => {
    const source = locateUpstreamSource()
    if (source === undefined) return
    expect(countOccurrences(source, NOTIFY_ANCHOR)).toBe(1)
    expect(countOccurrences(source, BRIDGE_ANCHOR)).toBe(1)
    expect(source).toContain(NOTIFY_CONTEXT)
    const result = transformAcpSource(source, HELPER_URL)
    expect(result.applied).toBe(true)
    expect(result.code).toContain('__threadharborNotify(notification')
    expect(result.code).toContain('__threadharborBridge(conn, methods)')
    expect(result.code.length).toBeGreaterThan(source.length)
  })
})

describe('pacer options', () => {
  it('reads overrides from the environment and ignores junk', () => {
    const parsed = pacerOptionsFromEnv({
      THREADHARBOR_ACP_STREAM_SLICE_CHARS: '120',
      THREADHARBOR_ACP_STREAM_MIN_INTERVAL_MS: '5',
      THREADHARBOR_ACP_STREAM_KINDS: 'agent_message_chunk, tool_call ',
      THREADHARBOR_ACP_STREAM_ENABLED: 'false',
    })
    expect(parsed).toMatchObject({
      enabled: false, sliceChars: 120, minIntervalMs: 5,
    })
    expect([...parsed.sliceKinds]).toEqual(['agent_message_chunk', 'tool_call'])
  })

  it('keeps defaults for unusable values', () => {
    const parsed = pacerOptionsFromEnv({
      THREADHARBOR_ACP_STREAM_SLICE_CHARS: '0',
      THREADHARBOR_ACP_STREAM_MIN_INTERVAL_MS: 'nope',
    })
    expect(parsed.sliceChars).toBe(DEFAULT_SLICE_CHARS)
    expect(parsed.minIntervalMs).toBe(60)
  })
})

describe('pacer planning', () => {
  it('honours the total budget and both interval clamps', () => {
    expect(planSlices('x'.repeat(4000), options({ sliceChars: 1000, minIntervalMs: 10, maxIntervalMs: 50, maxTotalMs: 0 })))
      .toMatchObject({ intervalMs: 10 })
    // 40 slices over a 1000ms budget: 25ms each, inside both clamps.
    expect(planSlices('x'.repeat(4000), options({ sliceChars: 100, minIntervalMs: 10, maxIntervalMs: 50, maxTotalMs: 1000 })))
      .toMatchObject({ intervalMs: 25 })
    // A budget too small for the floor yields the floor, not a zero-delay burst.
    expect(planSlices('x'.repeat(2000), options({ sliceChars: 100, minIntervalMs: 60, maxIntervalMs: 400, maxTotalMs: 1000 })))
      .toMatchObject({ intervalMs: 60 })
  })

  it('reassembles the original text', () => {
    const text = 'a'.repeat(2001)
    const { slices } = planSlices(text, options({ sliceChars: 300 }))
    expect(slices.length).toBe(7)
    expect(slices.join('')).toBe(text)
  })
})

describe('paced session update', () => {
  it('forwards small and non-text updates untouched', async () => {
    const sent = []
    const send = async (value) => { sent.push(value) }
    const small = thought('short')
    expect(await pacedSessionUpdate(small, send, options())).toBe(1)
    expect(sent[0]).toBe(small)

    const toolUpdate = { sessionId: 's', update: { sessionUpdate: 'tool_call', content: { text: 'x'.repeat(5000) } } }
    expect(await pacedSessionUpdate(toolUpdate, send, options())).toBe(1)
    expect(sent[1]).toBe(toolUpdate)
    expect(isSliceable(toolUpdate, options())).toBe(false)
    expect(updateText(toolUpdate)).toBe('x'.repeat(5000))
  })

  it('slices a long block in order and losslessly', async () => {
    const sent = []
    const send = async (value) => { sent.push(value) }
    const text = Array.from({ length: 5000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('')
    const count = await pacedSessionUpdate(thought(text), send, options({ sliceChars: 500 }))

    expect(count).toBe(10)
    expect(sent).toHaveLength(10)
    expect(sent.map((entry) => entry.update.content.text).join('')).toBe(text)
    for (const entry of sent) {
      expect(entry.sessionId).toBe('session-a')
      expect(entry.update.sessionUpdate).toBe('agent_thought_chunk')
      expect(entry.update.messageId).toBe('m1')
      expect(entry.update.content.type).toBe('text')
    }
    // The original envelope must not be mutated.
    expect(thought(text).update.content.text).toBe(text)
  })

  it('sends the first slice without waiting, then paces the rest', async () => {
    const stamps = []
    let start = Date.now()
    const send = async () => { stamps.push(Date.now() - start) }
    const text = 'y'.repeat(3000)
    await pacedSessionUpdate(thought(text), send, options({ sliceChars: 1000, minIntervalMs: 40, maxIntervalMs: 40, maxTotalMs: 0 }))

    expect(stamps).toHaveLength(3)
    expect(stamps[0]).toBeLessThan(30)
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(30)
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(30)
    start = 0
  })

  it('is a no-op when disabled', async () => {
    const sent = []
    const send = async (value) => { sent.push(value) }
    const big = thought('z'.repeat(5000))
    expect(await pacedSessionUpdate(big, send, options({ enabled: false }))).toBe(1)
    expect(sent[0]).toBe(big)
  })

  it('keeps a 68k block inside the configured replay budget', async () => {
    const sent = []
    const send = async (value) => { sent.push(value) }
    const opts = options({ sliceChars: 800, minIntervalMs: 5, maxIntervalMs: 250, maxTotalMs: 400 })
    const started = Date.now()
    await pacedSessionUpdate(thought('q'.repeat(68233)), send, opts)
    const elapsed = Date.now() - started

    expect(sent.length).toBe(86)
    expect(elapsed).toBeLessThan(3000)
    expect(sent.map((entry) => entry.update.content.text).join('')).toHaveLength(68233)
  })
})

describe('installed build matches the test doubles', () => {
  it('keeps the upstream export surface the shim forwards', () => {
    const source = locateUpstreamSource()
    if (source === undefined) return
    const exportLine = source.slice(source.lastIndexOf('export {'))
    expect(exportLine).toContain('Config')
    expect(exportLine).toContain('apply')
    expect(exportLine).toContain('inject')
    expect(exportLine).toContain('name')
  })

  it('has no leftover reference to a moved cache path', () => {
    const source = locateUpstreamSource()
    if (source === undefined) return
    expect(source).not.toContain(join('deploy', 'acp-stream'))
  })
})
