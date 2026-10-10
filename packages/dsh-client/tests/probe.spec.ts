/**
 * The probe itself: one small session, one shortest message, one measurement.
 *
 * This is the browser finally walking the path the rest of the UI already
 * walks — create a session on the preset, say one word, time the reply, leave
 * no trace. The four verdicts are deliberately kept apart because each one
 * means a different remedy: reply in time (nothing to do), reply late (wait),
 * no reply and no error (the agent is not working), no connection (check the
 * address and the credentials).
 *
 * Time is injected so the tests can make a reply arrive before or after the
 * slow threshold without waiting real seconds.
 */

import { describe, expect, it } from 'vitest'
import { runSessionProbe } from '../src/probe.ts'
import type { ProbeRunOptions } from '../src/probe.ts'
import type { GatewayResult, SessionGateway } from '../src/gateway.ts'

const ok = <T>(value: T): GatewayResult<T> => ({ ok: true, value })
const fail = (message: string): GatewayResult<never> => ({ ok: false, error: { code: 'test', message } })

/** A gateway that plays a scripted conversation and records every call. */
function scriptedGateway(script: {
  readonly createResult?: GatewayResult<{ readonly sessionId: string }>
  readonly promptResult?: GatewayResult<unknown>
  /** Events per page call, in order; the last one repeats from then on. */
  readonly pages?: readonly (readonly string[])[]
  readonly pageFailure?: string
  readonly errorAfter?: number
  readonly archiveResult?: GatewayResult<unknown>
}): SessionGateway & {
  readonly calls: string[]
  readonly archiveRequests: readonly unknown[]
  readonly fireError: (sessionId: string, message: string) => void
} {
  const calls: string[] = []
  const archiveRequests: unknown[] = []
  let pageCall = 0
  let errorListener: ((sessionId: string, message: string) => void) | undefined
  const emitError = (sessionId: string, message: string): void => { errorListener?.(sessionId, message) }
  const pages = script.pages ?? []
  return {
    calls,
    archiveRequests,
    fireError: emitError,
    listAgents: async () => ok([]),
    subscribeSessionErrors: listener => {
      errorListener = listener
      return () => { errorListener = undefined }
    },
    createSession: async request => {
      calls.push(`create ${request.agentPreset}`)
      return script.createResult ?? ok({ sessionId: 's-probe' })
    },
    sendPrompt: async request => {
      calls.push(`prompt ${request.sessionId} ${request.text}`)
      const at = calls.length
      if (script.errorAfter === at) emitError(request.sessionId, 'connection refused')
      return script.promptResult ?? ok({ accepted: true })
    },
    readRecentEvents: async request => {
      calls.push(`page ${request.sessionId}`)
      if (script.pageFailure !== undefined) return fail(script.pageFailure)
      const seen = pages[Math.min(pageCall, pages.length - 1)] ?? []
      pageCall += 1
      return ok(seen.map(type => ({ type })))
    },
    archiveSession: async request => {
      calls.push(`archive ${request.sessionId}`)
      ;(archiveRequests as unknown[]).push(request)
      return script.archiveResult ?? ok({})
    },
  }
}

/** A clock that jumps forward on every read, so loops cannot spin forever. */
function steppedClock(stepMs: number): { now(): number; elapsed(): number } {
  let current = 0
  return {
    now: () => {
      current += stepMs
      return current
    },
    elapsed: () => current,
  }
}

const baseOptions: ProbeRunOptions = {
  slowAfterMs: 1_000,
  timeoutMs: 5_000,
  pollMs: 0,
  prompt: 'ping',
  now: () => 0,
  delay: async () => {},
  mintId: () => 'probe-1',
}

describe('探测的四种结论', () => {
  it('按时回复：正常', async () => {
    const gateway = scriptedGateway({ pages: [[], ['user/message', 'assistant/message']] })
    const outcome = await runSessionProbe(gateway, 'acp-grok', { ...baseOptions, now: steppedClock(100).now })
    expect(outcome.verdict).toEqual({ kind: 'ok', ms: 200 })
  })

  it('回复太慢：偏慢', async () => {
    const gateway = scriptedGateway({ pages: [[], [], ['assistant/message']] })
    const outcome = await runSessionProbe(gateway, 'acp-grok', { ...baseOptions, now: steppedClock(900).now })
    // The reply exists but took longer than the threshold — the remedy is to
    // wait, not to restart anything.
    expect(outcome.verdict).toEqual({ kind: 'slow', ms: 2_700 })
  })

  it('超时既没有回复也没有报错：卡住', async () => {
    const gateway = scriptedGateway({ pages: [[]] })
    const outcome = await runSessionProbe(gateway, 'acp-grok', { ...baseOptions, now: steppedClock(1_000).now })
    expect(outcome.verdict).toEqual({ kind: 'hung', ms: 5_000 })
    expect(outcome.archiveNote).toBeUndefined()
  })

  it('会话都建不出来：连不上，带着主机的原话', async () => {
    const gateway = scriptedGateway({
      createResult: fail('route not found: acp:acp-grok'),
    })
    const outcome = await runSessionProbe(gateway, 'acp-grok', baseOptions)
    expect(outcome.verdict).toEqual({ kind: 'unreachable', reason: 'route not found: acp:acp-grok' })
    // Nothing was created, so there is nothing to archive.
    expect(gateway.calls.some(call => call.startsWith('archive'))).toBe(false)
  })

  it('发话被拒：连不上', async () => {
    const gateway = scriptedGateway({ promptResult: fail('session not found') })
    const outcome = await runSessionProbe(gateway, 'acp-grok', baseOptions)
    expect(outcome.verdict).toEqual({ kind: 'unreachable', reason: 'session not found' })
  })

  it('主机报了会话错误：连不上，而不是干等到超时', async () => {
    const gateway = scriptedGateway({ pages: [[]], errorAfter: 2 })
    const outcome = await runSessionProbe(gateway, 'acp-grok', baseOptions)
    expect(outcome.verdict).toEqual({ kind: 'unreachable', reason: 'connection refused' })
  })
})

describe('小会话的善后', () => {
  it('无论结论是什么，会话都会被归档', async () => {
    // The verdicts are the headline; the cleanup is the promise. A probe that
    // leaves a session behind would haunt the session list forever. (That the
    // archive stops the running work is the gateway's promise, asserted in
    // gateway.spec; here it is enough that the archive happens at all.)
    for (const script of [
      { pages: [[]] as readonly (readonly string[])[] },
      { createResult: fail('nope') as GatewayResult<{ readonly sessionId: string }> },
    ]) {
      const gateway = scriptedGateway(script)
      // The hung script needs a clock that reaches its deadline; the stepped
      // one does in five reads what a wall clock needs five seconds for.
      await runSessionProbe(gateway, 'acp-grok', { ...baseOptions, now: steppedClock(1_000).now })
      if (script.createResult?.ok === false) {
        // Nothing was created, so there is nothing to archive.
        expect(gateway.archiveRequests).toEqual([])
      } else {
        expect(gateway.archiveRequests).toEqual([{ sessionId: 's-probe' }])
      }
    }
  })

  it('归档失败不吞掉结论，只附加一句说明', async () => {
    const gateway = scriptedGateway({ pages: [[], ['assistant/message']], archiveResult: fail('workspace is stopping') })
    const outcome = await runSessionProbe(gateway, 'acp-grok', baseOptions)
    expect(outcome.verdict.kind).toBe('ok')
    expect(outcome.archiveNote).toBe('workspace is stopping')
  })

  it('别的会话的错误不会连累这次探测', async () => {
    const gateway = scriptedGateway({ pages: [[], ['assistant/message']] })
    // An unrelated session's error arrives between prompt and reply.
    const originalFire = gateway.fireError.bind(gateway)
    let armed = false
    const probe = runSessionProbe(gateway, 'acp-grok', {
      ...baseOptions,
      delay: async () => {
        if (!armed) {
          armed = true
          // The scripted gateway fires the error for the session the prompt
          // named; this call points at a different session on purpose.
          originalFire('s-someone-else', 'boom')
        }
      },
    })
    const outcome = await probe
    expect(outcome.verdict.kind).toBe('ok')
  })

  it('先订好错误事件再发话：报错来得再快也接得住', async () => {
    // A connection that dies instantly must be classified, not missed because
    // the listener was attached one await too late.
    const calls: string[] = []
    let listener: ((sessionId: string, message: string) => void) | undefined
    const gateway: SessionGateway = {
      listAgents: async () => ok([]),
      subscribeSessionErrors: handle => {
        calls.push('subscribe')
        listener = handle
        return () => { listener = undefined }
      },
      createSession: async () => { calls.push('create'); return ok({ sessionId: 's-probe' }) },
      sendPrompt: async request => {
        calls.push('prompt')
        listener?.(request.sessionId, 'died at once')
        return ok({ accepted: true })
      },
      readRecentEvents: async () => { calls.push('page'); return ok([]) },
      archiveSession: async () => ok({}),
    }
    const outcome = await runSessionProbe(gateway, 'acp-grok', baseOptions)
    expect(outcome.verdict).toEqual({ kind: 'unreachable', reason: 'died at once' })
    expect(calls.indexOf('subscribe')).toBeLessThan(calls.indexOf('prompt'))
  })
})
