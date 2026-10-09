/**
 * Grok's projection, now a thin binding over the shared ACP layer.
 *
 * The frame-shape knowledge that used to live here moved to
 * `@threadharbor/dsh-acp-agent`'s grok dialect, because codex and claude need
 * the same walk over the same event vocabulary and the parts that differ —
 * where a tool's name sits, where its output sits — differ per agent. What is
 * left here is the grok-specific calling convention.
 *
 * `packages/dsh-grok-agent`'s own regression suite, run against frames
 * captured from a live `grok agent serve`, is what guards this binding.
 */

import {
  projectTurn as projectTurnWith,
  projectUserMessage as projectUserMessageWith,
  type ProjectionEvent,
} from '@threadharbor/dsh-acp-agent'
import { grokDialect } from '@threadharbor/dsh-acp-agent'

export type { ProjectionEvent } from '@threadharbor/dsh-acp-agent'

/** One tool call reported by grok, carried as-is. */
export type ReportedToolCall = {
  readonly callId: string
  name: string
  arguments: unknown
  title?: string | undefined
  status?: string | undefined
  output: string
}

/** Fold one turn of grok ACP updates into the DSH events that describe it. */
export function projectTurn(frames: Parameters<typeof projectTurnWith>[0], options: { readonly turn: number }): ProjectionEvent[] {
  return projectTurnWith(frames, { turn: options.turn, dialect: grokDialect })
}

/** The user turn's own event, appended before the agent starts work. */
export function projectUserMessage(text: string, turn: number): ProjectionEvent[] {
  return projectUserMessageWith(text, turn)
}