/**
 * What one probe verdict says to the person looking at it.
 *
 * The four verdicts ask for four different reactions, and the display has to
 * keep them apart: "slow" asks for patience, "hung" says the agent is not
 * doing its work, and "unreachable" is not about the agent's speed at all —
 * no amount of waiting fixes a wrong address. The wording here is the only
 * place that turns the probe's answer into instructions.
 *
 * None of the advice offers a restart button: this page is the least reliable
 * channel precisely when an agent is hung. Dead connections are dropped by the
 * host itself and rebuilt on the session's next turn, so a button here could
 * only ever order the host around at the moment the page is least able to.
 *
 * The wording lives in the locale dictionary (`locales.ts`) like every other
 * piece of product copy; this module is a plain function and cannot call `t`
 * itself, so the caller's seat rides in as a parameter.
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientLocaleKey } from './locales.ts'

/**
 * What one probe found, in terms a person can act on.
 *
 * The shape is the display's contract: the four kinds must stay distinct
 * because each one means a different remedy — collapsing any two collapses
 * their advice.
 */
export type ProbeVerdict =
  | { readonly kind: 'ok'; readonly ms: number }
  /** Answered, but slower than this agent is allowed to be. */
  | { readonly kind: 'slow'; readonly ms: number }
  /** No answer within the deadline. `started` says the agent picked the work up and never finished. */
  | { readonly kind: 'hung'; readonly ms: number; readonly started: boolean }
  /** Could not even reach it: wrong address, nothing listening, bad credentials. */
  | { readonly kind: 'unreachable'; readonly reason: string }

/** The raw evidence a probe run gathered, before any judgement. */
export type ProbeEvidence =
  /** The agent answered; `ms` is how long the answer took. */
  | { readonly kind: 'replied'; readonly ms: number }
  /**
   * The deadline passed with no answer and no error. `started` says whether
   * the host ever reported the agent picking the work up — the difference
   * between "took the turn and never finished" and "never moved at all".
   */
  | { readonly kind: 'silent'; readonly ms: number; readonly started?: boolean }
  /** The probe could not ask: creation, admission or the session itself failed. */
  | { readonly kind: 'failed'; readonly reason: string }

/** The thresholds one judgement is made against. */
export type ProbeThresholds = {
  /** Longer than this is slow, not hung. */
  readonly slowAfterMs: number
}

/** The probe's shared defaults: thresholds, deadline, and what to ask. */
export const PROBE_DEFAULTS = {
  slowAfterMs: 15_000,
  timeoutMs: 60_000,
  /** Kept short: it is a liveness check, not a conversation. */
  prompt: 'ping',
} as const

/**
 * Judge raw probe evidence into the verdict a person reads.
 * @param evidence - what the probe run observed.
 * @param thresholds - the slowness threshold, shared with the deadline defaults.
 * @returns one of the four verdicts; `slow` starts strictly past the threshold.
 */
export function judgeProbe(evidence: ProbeEvidence, thresholds: ProbeThresholds): ProbeVerdict {
  switch (evidence.kind) {
    case 'replied':
      return evidence.ms > thresholds.slowAfterMs
        ? { kind: 'slow', ms: evidence.ms }
        : { kind: 'ok', ms: evidence.ms }
    case 'silent':
      return { kind: 'hung', ms: evidence.ms, started: evidence.started ?? false }
    case 'failed':
      return { kind: 'unreachable', reason: evidence.reason }
  }
}

/** How the row is tinted: calm, wait-and-see, or act-now. */
export type VerdictTone = 'ok' | 'slow' | 'hung' | 'unreachable'

export type VerdictDisplay = {
  readonly tone: VerdictTone
  /** The one-word state, distinct for each of the four verdicts. */
  readonly headline: string
  /** The evidence: elapsed milliseconds, or why nothing was reached. */
  readonly detail: string
  /** What to do about it, in the terms the operator can act on. */
  readonly advice: string
}

/**
 * The `t` seat `describeVerdict` reads its copy through. Typed to the
 * dictionary's whole key domain, so the panel's seat (`PanelT`) plugs in
 * directly and a test fake with string keys fits too.
 */
export type VerdictT = Translate<ClientLocaleKey>

/**
 * Turn a probe verdict into the row a person reads.
 * @param verdict - what the probe found.
 * @param t - the caller's locale seat; the wording lives in the dictionary.
 * @returns headline, evidence, and the matching instruction.
 */
export function describeVerdict(verdict: ProbeVerdict, t: VerdictT): VerdictDisplay {
  switch (verdict.kind) {
    case 'ok':
      return {
        tone: 'ok',
        headline: t('panel.verdict.ok'),
        detail: `${verdict.ms} ms`,
        advice: t('panel.verdict.okAdvice'),
      }
    case 'slow':
      return {
        tone: 'slow',
        headline: t('panel.verdict.slow'),
        detail: `${verdict.ms} ms`,
        advice: t('panel.verdict.slowAdvice'),
      }
    case 'hung':
      return {
        tone: 'hung',
        headline: t('panel.verdict.hung'),
        detail: verdict.started
          ? t('panel.verdict.hungStartedDetail', { ms: verdict.ms })
          : t('panel.verdict.hungSilentDetail', { ms: verdict.ms }),
        advice: verdict.started
          ? t('panel.verdict.hungStartedAdvice')
          : t('panel.verdict.hungSilentAdvice'),
      }
    case 'unreachable':
      return {
        tone: 'unreachable',
        headline: t('panel.verdict.unreachable'),
        detail: verdict.reason,
        advice: t('panel.verdict.unreachableAdvice'),
      }
  }
}
