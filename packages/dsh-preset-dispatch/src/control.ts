/**
 * Probe and restart for one external agent.
 *
 * Both exist because of what a hung agent looks like from outside: the process
 * is alive and the port is open, so every check that asks "is it there?" says
 * yes. The only honest test is to give it a small piece of work and see whether
 * it does it.
 *
 * That is why the probe asks a question rather than checking the connection.
 * A connection check passes on exactly the agent that cannot do any work.
 */

import type { AcpSession, PresetConfig } from './registry.ts'
import type { AcpSessionFactory } from './registry.ts'

/** What the probe found, in terms a person can act on. */
export type ProbeVerdict =
  | { readonly kind: 'ok'; readonly ms: number }
  /** Answered, but slower than this agent is allowed to be. */
  | { readonly kind: 'slow'; readonly ms: number }
  /** No answer within the deadline. */
  | { readonly kind: 'hung'; readonly ms: number }
  /** Could not even reach it: wrong address, nothing listening, bad credentials. */
  | { readonly kind: 'unreachable'; readonly reason: string }

export type ProbeOptions = {
  /** Longer than this is slow, not hung. */
  readonly slowAfterMs: number
  /** No answer by here is hung. */
  readonly timeoutMs: number
  /** What to ask. Kept short: it is a liveness check, not a conversation. */
  readonly prompt?: string
  readonly now?: () => number
}

const DEFAULT_PROBE: Required<Pick<ProbeOptions, 'slowAfterMs' | 'timeoutMs' | 'prompt'>> = {
  slowAfterMs: 15_000,
  timeoutMs: 60_000,
  prompt: 'ping',
}

/** What one agent can be told to do from the outside. */
export type AgentControl = {
  readonly presetId: string
  probe(options?: Partial<ProbeOptions>): Promise<ProbeVerdict>
  /** Drop every open conversation, so the next turn builds a fresh one. */
  restart(): number
  readonly openSessions: () => number
}

/**
 * Controls for every configured agent.
 *
 * Restart counts what it closed and says so, because "restarted" with nothing
 * to show is indistinguishable from "restarted and nothing was wrong".
 */
export function makeAgentControls(
  config: PresetConfig,
  factory: AcpSessionFactory,
  openSessions: (presetId: string) => ReadonlyMap<string, AcpSession>,
  dropSession: (presetId: string) => void,
): Map<string, AgentControl> {
  const controls = new Map<string, AgentControl>()
  for (const [presetId, preset] of Object.entries(config.presets)) {
    if (preset.agent === undefined) continue
    if (factory.dialectFor(presetId, preset) === undefined) continue
    controls.set(presetId, {
      presetId,
      openSessions: () => openSessions(presetId).size,
      restart: () => {
        const sessions = openSessions(presetId)
        const closed = sessions.size
        for (const session of sessions.values()) session.close()
        dropSession(presetId)
        return closed
      },
      probe: async (options = {}) => {
        const merged = { ...DEFAULT_PROBE, ...options }
        const now = options.now ?? Date.now
        const probeId = `probe:${presetId}`
        let session: AcpSession
        try {
          session = factory.open(presetId, { cwd: preset.cwd ?? process.cwd() })
        } catch (error: unknown) {
          return { kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) }
        }
        const started = now()
        let timer: ReturnType<typeof setTimeout> | undefined
        const overDeadline = new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => { resolve('timeout') }, merged.timeoutMs)
        })
        try {
          const answered = session
            .run(
              {
                kind: 'enter',
                messages: [{ type: 'text', text: merged.prompt }],
              },
              {
                sessionId: probeId,
                produce: () => [],
                write: () => undefined,
              },
            )
            .then(() => 'answered' as const)
          const outcome = await Promise.race([answered, overDeadline])
          session.close()
          if (outcome === 'timeout') return { kind: 'hung', ms: now() - started }
          const ms = now() - started
          return ms > merged.slowAfterMs ? { kind: 'slow', ms } : { kind: 'ok', ms }
        } catch (error: unknown) {
          session.close()
          return { kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) }
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      },
    })
  }
  return controls
}
