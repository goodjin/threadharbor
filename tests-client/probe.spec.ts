/**
 * The probe itself: one small session, one shortest message, one measurement.
 *
 * This is the browser finally walking the path the rest of the UI already
 * walks — create a session on the preset, say one word, time the reply, leave
 * no trace. The verdicts are deliberately kept apart because each one means a
 * different remedy: reply in time (nothing to do), reply late (wait), started
 * but never finished (the agent is stuck), never moved (the agent is not
 * working), no connection (check the address and the credentials).
 *
 * The reply is read off the host's own turn signal — `api-session/status`
 * running → idle — because the session-page read needs a log cut only the
 * follow stream hands out, and the probe does not open one.
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
  readonly errorAfter?: number
  readonly archiveResult?: GatewayResult<unknown>
}): SessionGateway & {
  readonly calls: string[]
  readonly archiveRequests: readonly unknown[]
  readonly fireError: (sessionId: string, message: string) => void
  readonly fireStatus: (sessionId: string, running: boolean) => void
} {
  const calls: string[] = []
  const archiveRequests: unknown[] = []
  let errorListener: ((sessionId: string, message: string) => void) | undefined
  let statusListener: ((sessionId: string, running: boolean) => void) | undefined
  const emitError = (sessionId: string, message: string): void => { errorListener?.(sessionId, message) }
  const emitStatus = (sessionId: string, running: boolean): void => { statusListener?.(sessionId, running) }
  return {
    calls,
    archiveRequests,
    fireError: emitError,
    fireStatus: emitStatus,
    listAgents: async () => ok([]),
    subscribeSessionErrors: listener => {
      errorListener = listener
      return () => { errorListener = undefined }
    },
    subscribeSessionStatus: listener => {
      statusListener = listener
      return () => { statusListener = undefined }
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

describe('探测的几种结论', () => {
  it('按时回复：正常', async () => {
    const gateway = scriptedGateway({})
    const outcome = await runSessionProbe(gateway, 'acp-grok', {
      ...baseOptions,
      now: steppedClock(100).now,
      delay: async () => {
        // One wait, then the host's pair: the agent took the turn and put it
        // back down. The probe should read that as a reply.
        gateway.fireStatus('s-probe', true)
        gateway.fireStatus('s-probe', false)
      },
    })
    expect(outcome.verdict).toEqual({ kind: 'ok', ms: 200 })
  })

  it('回复太慢：偏慢', async () => {
    const gateway = scriptedGateway({})
    let waits = 0
    const outcome = await runSessionProbe(gateway, 'acp-grok', {
      ...baseOptions,
      now: steppedClock(900).now,
      delay: async () => {
        waits += 1
        if (waits === 1) gateway.fireStatus('s-probe', true)
        else gateway.fireStatus('s-probe', false)
      },
    })
    // The reply exists but took longer than the threshold — the remedy is to
    // wait, not to restart anything.
    expect(outcome.verdict).toEqual({ kind: 'slow', ms: 2_700 })
  })

  it('开了工但到点没交回：卡住，说明白是哪种卡', async () => {
    const gateway = scriptedGateway({})
    const outcome = await runSessionProbe(gateway, 'acp-grok', {
      ...baseOptions,
      now: steppedClock(1_000).now,
      delay: async () => { gateway.fireStatus('s-probe', true) },
    })
    expect(outcome.verdict).toEqual({ kind: 'hung', ms: 5_000, started: true })
  })

  it('到点毫无动静：卡住', async () => {
    const gateway = scriptedGateway({})
    const outcome = await runSessionProbe(gateway, 'acp-grok', { ...baseOptions, now: steppedClock(1_000).now })
    expect(outcome.verdict).toEqual({ kind: 'hung', ms: 5_000, started: false })
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
    const gateway = scriptedGateway({ errorAfter: 2 })
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
      { kind: 'hung' as const },
      { kind: 'uncreated' as const },
    ]) {
      const gateway = scriptedGateway(script.kind === 'uncreated' ? { createResult: fail('nope') } : {})
      // The hung script needs a clock that reaches its deadline; the stepped
      // one does in five reads what a wall clock needs five seconds for.
      await runSessionProbe(gateway, 'acp-grok', { ...baseOptions, now: steppedClock(1_000).now })
      if (script.kind === 'uncreated') {
        // Nothing was created, so there is nothing to archive.
        expect(gateway.archiveRequests).toEqual([])
      } else {
        expect(gateway.archiveRequests).toEqual([{ sessionId: 's-probe' }])
      }
    }
  })

  it('归档失败会附上主机的原话', async () => {
    const gateway = scriptedGateway({ archiveResult: fail('workspace is stopping') })
    const outcome = await runSessionProbe(gateway, 'acp-grok', {
      ...baseOptions,
      delay: async () => {
        gateway.fireStatus('s-probe', true)
        gateway.fireStatus('s-probe', false)
      },
    })
    expect(outcome.verdict.kind).toBe('ok')
    expect(outcome.archiveNote).toBe('workspace is stopping')
  })

  it('别的会话的错误和状态都不会连累这次探测', async () => {
    const gateway = scriptedGateway({})
    const originalFireError = gateway.fireError.bind(gateway)
    const originalFireStatus = gateway.fireStatus.bind(gateway)
    let armed = false
    const outcome = await runSessionProbe(gateway, 'acp-grok', {
      ...baseOptions,
      delay: async () => {
        if (!armed) {
          armed = true
          // Another session's noise arrives between prompt and reply.
          originalFireError('s-someone-else', 'boom')
          originalFireStatus('s-someone-else', true)
          originalFireStatus('s-someone-else', false)
          // This session's own pair still lands and still counts.
          originalFireStatus('s-probe', true)
          originalFireStatus('s-probe', false)
        }
      },
    })
    expect(outcome.verdict.kind).toBe('ok')
  })

  it('先订好事件再发话：报错来得再快也接得住', async () => {
    // A connection that dies instantly must be classified, not missed because
    // the listener was attached one await too late.
    const calls: string[] = []
    let errorListener: ((sessionId: string, message: string) => void) | undefined
    const gateway: SessionGateway = {
      listAgents: async () => ok([]),
      subscribeSessionErrors: handle => {
        calls.push('subscribe')
        errorListener = handle
        return () => { errorListener = undefined }
      },
      subscribeSessionStatus: () => () => {},
      createSession: async () => { calls.push('create'); return ok({ sessionId: 's-probe' }) },
      sendPrompt: async request => {
        calls.push('prompt')
        errorListener?.(request.sessionId, 'died at once')
        return ok({ accepted: true })
      },
      archiveSession: async () => ok({}),
    }
    const outcome = await runSessionProbe(gateway, 'acp-grok', baseOptions)
    expect(outcome.verdict).toEqual({ kind: 'unreachable', reason: 'died at once' })
    expect(calls.indexOf('subscribe')).toBeLessThan(calls.indexOf('prompt'))
  })
})
