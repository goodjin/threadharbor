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
 */

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
  /** No answer within the deadline. */
  | { readonly kind: 'hung'; readonly ms: number }
  /** Could not even reach it: wrong address, nothing listening, bad credentials. */
  | { readonly kind: 'unreachable'; readonly reason: string }

/** The raw evidence a probe run gathered, before any judgement. */
export type ProbeEvidence =
  /** The agent answered; `ms` is how long the answer took. */
  | { readonly kind: 'replied'; readonly ms: number }
  /** The deadline passed with no answer and no error. */
  | { readonly kind: 'silent'; readonly ms: number }
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
      return { kind: 'hung', ms: evidence.ms }
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
 * Turn a probe verdict into the row a person reads.
 * @param verdict - what the probe found.
 * @returns headline, evidence, and the matching instruction.
 */
export function describeVerdict(verdict: ProbeVerdict): VerdictDisplay {
  switch (verdict.kind) {
    case 'ok':
      return {
        tone: 'ok',
        headline: '正常',
        detail: `${verdict.ms} ms`,
        advice: '有回应，速度正常，不用处理。',
      }
    case 'slow':
      return {
        tone: 'slow',
        headline: '偏慢',
        detail: `${verdict.ms} ms`,
        advice: '回来了但超过正常阈值——建议再探测一次，慢不代表卡。',
      }
    case 'hung':
      return {
        tone: 'hung',
        headline: '卡住',
        detail: `${verdict.ms} ms 内无回应`,
        advice: '到点没有回应——agent 多半没在工作。去主机上查看这个 agent 的进程和日志；连接如果断了，主机会在下一次对话时自动重连。',
      }
    case 'unreachable':
      return {
        tone: 'unreachable',
        headline: '连不上',
        detail: verdict.reason,
        advice: '先检查主机的 agent 地址和凭证是否正确；这不是等待或重连能解决的问题。',
      }
  }
}
