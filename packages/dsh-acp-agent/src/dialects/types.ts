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
 *   turn tokens  grok  → session/update params._meta.totalTokens
 *                codex/claude → the session/prompt *response* (not an update)
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

  /** Token counts carried by a `session/update` frame, if any. */
  readUpdateTokens(params: Record<string, unknown>): number | undefined

  /** True when this update frame is conversation content rather than chatter. */
  isContent(update: Record<string, unknown>): boolean
}