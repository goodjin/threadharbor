/**
 * The probe: one small session, one shortest message, one measurement.
 *
 * This is the browser walking the path the rest of the UI already walks —
 * create a session on the preset, say one word, time the reply, leave no
 * trace. It uses DSH's own public calls through the gateway; nothing here is
 * a new host interface.
 *
 * The four verdicts stay apart on purpose, because each means a different
 * remedy: 正常 (nothing to do), 偏慢 (wait), 卡住 (the agent is not working —
 * look at the agent, not at this page), 连不上 (check the address and the
 * credentials).
 */

import { PROBE_DEFAULTS, judgeProbe } from './verdict.ts'
import type { ProbeEvidence, ProbeVerdict } from './verdict.ts'
import type { SessionGateway } from './gateway.ts'

/** Knobs for tests; production runs on the defaults. */
export type ProbeRunOptions = {
  readonly slowAfterMs?: number
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly prompt?: string
  readonly now?: () => number
  readonly delay?: (ms: number) => Promise<void>
  readonly mintId?: () => string
}

/** What one probe run concluded, plus anything the cleanup wants on record. */
export type ProbeOutcome = {
  readonly verdict: ProbeVerdict
  /**
   * Said only when the probe session could not be archived afterwards.
   *
   * Never replaces the verdict: a measurement that succeeded is still a
   * measurement, but a session left behind must be admitted, not hidden.
   */
  readonly archiveNote?: string
}

/** A request id without depending on a crypto object being present. */
function defaultMintId(): string {
  const globalCrypto = globalThis.crypto
  if (globalCrypto !== undefined && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }
  return `probe-${Math.random().toString(36).slice(2)}`
}

/**
 * Run the probe against one preset.
 *
 * Never throws: every failure along the way is classified as one of the four
 * verdicts, because "the probe itself blew up" is 连不上 as the user
 * experiences it.
 */
export async function runSessionProbe(
  gateway: SessionGateway,
  presetId: string,
  options: ProbeRunOptions = {},
): Promise<ProbeOutcome> {
  const slowAfterMs = options.slowAfterMs ?? PROBE_DEFAULTS.slowAfterMs
  const timeoutMs = options.timeoutMs ?? PROBE_DEFAULTS.timeoutMs
  const pollMs = options.pollMs ?? 100
  const prompt = options.prompt ?? PROBE_DEFAULTS.prompt
  const now = options.now ?? (() => Date.now())
  const delay = options.delay ?? (async (ms: number) => await new Promise(resolve => { setTimeout(resolve, ms) }))
  const mintId = options.mintId ?? defaultMintId

  const started = now()

  // The session must exist before anything can be heard or archived, so its
  // failure short-circuits the rest — including the cleanup.
  const created = await gateway.createSession({ agentPreset: presetId })
  if (!created.ok) {
    return { verdict: judgeProbe({ kind: 'failed', reason: created.error.message }, { slowAfterMs }) }
  }
  const sessionId = created.value.sessionId

  // Both host signals attach before the prompt: an error or a status flip that
  // lands between prompt and reply is the classification, and a listener
  // attached one await too late misses exactly the fastest deaths.
  let failure: string | undefined
  const unsubscribeErrors = gateway.subscribeSessionErrors((eventSessionId, message) => {
    if (eventSessionId === sessionId && failure === undefined) failure = message
  })
  let sawRunning = false
  let finishedAt: number | undefined
  const unsubscribeStatus = gateway.subscribeSessionStatus((eventSessionId, running) => {
    if (eventSessionId !== sessionId) return
    if (running) sawRunning = true
    else if (sawRunning && finishedAt === undefined) finishedAt = now()
  })
  const unsubscribe = (): void => {
    unsubscribeErrors()
    unsubscribeStatus()
  }

  // stopActivity rides along in the gateway: a hung turn must be stopped, not
  // just forgotten. Written before the stops land, the archive also takes the
  // session out of the user's list even if the stop is slow.
  const cleanUp = async (judged: ProbeVerdict): Promise<ProbeOutcome> => {
    const archived = await gateway.archiveSession({ sessionId })
    if (archived.ok) return { verdict: judged }
    return { verdict: judged, archiveNote: archived.error.message }
  }

  try {
    const prompted = await gateway.sendPrompt({ requestId: mintId(), sessionId, text: prompt })
    if (!prompted.ok) {
      return await cleanUp(judgeProbe({ kind: 'failed', reason: prompted.error.message }, { slowAfterMs }))
    }
    for (;;) {
      // The host's own account of the turn: the agent picked the work up
      // (running) and put it back down (idle again). That pair, with no error
      // in between, is the reply — reading the log back would need a session
      // page cut that only the follow stream hands out, and the probe does
      // not open one.
      if (finishedAt !== undefined) {
        return await cleanUp(judgeProbe({ kind: 'replied', ms: finishedAt - started } satisfies ProbeEvidence, { slowAfterMs }))
      }
      if (failure !== undefined) {
        return await cleanUp(judgeProbe({ kind: 'failed', reason: failure }, { slowAfterMs }))
      }
      const elapsed = now() - started
      if (elapsed >= timeoutMs) {
        return await cleanUp(judgeProbe({ kind: 'silent', ms: elapsed, started: sawRunning } satisfies ProbeEvidence, { slowAfterMs }))
      }
      await delay(pollMs)
    }
  } finally {
    unsubscribe()
  }
}
