/**
 * How one agent's frames are shaped.
 *
 * The three agents we drive disagree in exactly the places a naive shared
 * projection gets wrong, so every field-reading decision lives here rather
 * than in the projection. Measured differences (2026-10-09):
 *
 *   tool name    grok  → update.title (first frame)
 *                codex → update.kind ("execute"; there is no tool name at all)
 *                claude→ update._meta.claudeCode.toolName
 *   tool output  grok/claude → update.content, nested twice
 *                codex        → update.rawOutput.formatted_output (no content)
 *   models       grok/codex → session/new .models.availableModels
 *                claude      → session/new .configOptions[id=model].options
 *   turn tokens  codex/claude → the session/prompt *response*'s `usage`
 *                grok        → nothing usable: only a running total on
 *                              session/update ._meta, which cannot be split
 *                              into the input/output pair a DSH usage needs
 */

/** A tool call as this agent reported it, folded across its update frames. */
export type ToolCall = {
  readonly callId: string
  /** The tool's identity. Where this comes from is agent-specific. */
  name: string
  /** Raw arguments exactly as the agent produced them. */
  arguments: unknown
  /** Human-readable activity line, which later updates usually overwrite. */
  title?: string | undefined
  status?: string | undefined
  /** Output text harvested from whichever field this agent uses. */
  output: string
}

/**
 * One turn's token usage, in the bucket names DSH's own session events use.
 *
 * Shaped after the reference `TokenUsage`: `inputTokens` and `outputTokens`
 * are the required pair; every other bucket is present only when the agent
 * actually reported it. A field the agent did not report must stay absent —
 * a `0` in its place is a fabricated number, and DSH's token accounting
 * reads these fields as facts.
 */
export type TurnUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly totalTokens?: number
}

export interface AcpDialect {
  /** Stable id, used in logs and tests. */
  readonly id: string

  /**
   * Fold one tool-related update frame into the call it belongs to.
   *
   * `carried` is the call as earlier frames of the same id established, or
   * undefined on the opening frame. Folding rather than "reading a field" is
   * deliberate: most agents overwrite `title` with a human activity line after
   * the first update, so the name has to be latched on the way in — but where
   * the name comes from differs per agent, so the latching rule does too.
   */
  foldTool(carried: ToolCall | undefined, update: Record<string, unknown>): ToolCall

  /** Output text for one update frame. Empty means "nothing new yet". */
  toolOutput(update: Record<string, unknown>): string

  /** The model list carried by a `session/new` reply. */
  readModels(reply: unknown): readonly { id: string; name: string; description?: string }[]

  /**
   * The token usage carried by a turn's `session/prompt` reply, if any.
   *
   * The reply frame reaches the projection among the turn's frames, so this
   * reads it there. Where the usage lives — and whether the agent reports one
   * at all — is agent-specific: codex and claude put a full breakdown on the
   * reply, grok only keeps a running total on its update frames, which cannot
   * be split into the required input/output pair and therefore yields nothing.
   */
  readReplyUsage(result: unknown): TurnUsage | undefined

  /** True when this update frame is conversation content rather than chatter. */
  isContent(update: Record<string, unknown>): boolean
}