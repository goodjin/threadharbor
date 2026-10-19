/**
 * Split one external turn's frame stream into segments.
 *
 * The whole-turn projection packs an external turn into one DSH step, so the
 * live view shows thinking, tool calls and text without their true ordering.
 * The segmenter walks the frames as they arrive and marks the boundary where
 * one burst of model work — its thought/text plus the batch of tool calls it
 * issued — has fully settled and fresh content begins. A caller driving one
 * DSH step per segment asks every frame `observe(frame)`; true means the
 * frame closes the previous segment, and the frame itself belongs to the NEW
 * one (close first, then fold it in).
 *
 * The boundary rule is the native loop's: a segment stays open while any tool
 * call it opened is still running, and once every call has settled, the next
 * non-empty content chunk (thought or text) closes the segment. Subagent and
 * async-task frames and vendor chatter never open, settle or close anything —
 * a delegation is rendered by its own card, not by the parent's segmentation.
 */

import type { AcpFrame } from './acp-client.ts'
import type { AcpDialect } from './dialects/types.ts'

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(content: unknown): string {
  const entry = recordOf(content)
  return typeof entry['text'] === 'string' ? (entry['text'] as string) : ''
}

/** A tool status that closes its call — the same terminals the projection writes results for. */
function settledOf(status: string): boolean {
  return status === 'completed' || status === 'failed'
}

export class AcpSegmenter {
  private readonly dialect: AcpDialect

  /** Calls opened in the current segment whose terminal frame has not arrived. */
  private readonly openCalls = new Set<string>()

  /** True once any call of the current segment settled — even while others still run. */
  private anySettled = false

  constructor(dialect: AcpDialect) {
    this.dialect = dialect
  }

  /**
   * Fold one frame and report whether it starts a new segment.
   *
   * The update gate is the dialect's, exactly the way the projection's
   * `accumulate` reads frames: without a hook only draft-conforming
   * `session/update` frames carry an update at all.
   */
  observe(frame: AcpFrame): boolean {
    const update = this.dialect.frameUpdate === undefined
      ? (frame.method === 'session/update' ? recordOf(recordOf(frame.params)['update']) : undefined)
      : this.dialect.frameUpdate(frame)
    if (update === undefined) return false
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : ''
      const status = typeof update['status'] === 'string' ? update['status'] : ''
      if (settledOf(status)) {
        this.openCalls.delete(id)
        this.anySettled = true
      } else {
        this.openCalls.add(id)
      }
      // The completion frame does not close the segment itself: the batch is
      // only done once the model says something new after it.
      return false
    }
    if ((kind === 'agent_thought_chunk' || kind === 'agent_message_chunk')
      && textOf(update['content']).length > 0
      && this.anySettled && this.openCalls.size === 0) {
      // New content after a fully settled tool batch: the chunk opens the
      // next segment, so the per-segment state resets under it.
      this.openCalls.clear()
      this.anySettled = false
      return true
    }
    return false
  }
}
