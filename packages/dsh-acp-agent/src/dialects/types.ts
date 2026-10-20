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

/**
 * What one agent can do, declared up front instead of re-derived from frames.
 *
 * Each field is a measured fact about that agent (live captures 2026-09/10),
 * read by the stop, visibility, reply-replay and attachment work rather than
 * guessed at again:
 *
 *   cancelsTurns         the agent honors a `session/cancel` mid-turn
 *   acceptsImageContent  `session/prompt` accepts an image content block
 *   toolFrameShape       'in_progress' — one `tool_call_update` carries a
 *                        live status while the call runs (claude, cursor);
 *                        'two_frame' — an opening frame plus a completed
 *                        one, no progress in between (codex, grok)
 *   commandVia           how the agent's own slash commands reach us;
 *                        every ACP agent pushes them as a `tool_frame`
 *   toolNameMap          the agent's native tool names translated onto the
 *                        short names DSH renders, e.g. `Read → read`
 *   supportsSessionResume `session/resume` can reattach a session the agent
 *                        kept server-side (its initialize advertised
 *                        `loadSession`). Absent means unmeasured — the runner
 *                        then never resumes, exactly as before.
 */
export type AcpCapabilities = {
  readonly cancelsTurns: boolean
  readonly acceptsImageContent: boolean
  readonly toolFrameShape: 'in_progress' | 'two_frame'
  readonly commandVia: 'tool_frame'
  readonly toolNameMap: Readonly<Record<string, string>>
  readonly supportsSessionResume?: boolean | undefined
}

export interface AcpDialect {
  /** Stable id, used in logs and tests. */
  readonly id: string

  /** What this agent can do — see `AcpCapabilities`. Required: every dialect declares its own. */
  readonly capabilities: AcpCapabilities

  /**
   * The `authenticate` method to call between `initialize` and `session/new`.
   *
   * Most agents go straight from `initialize` to `session/new`. Cursor does not:
   * it requires an `authenticate { methodId }` round-trip (after an interactive
   * `agent login`) first, and `session/new` fails without it. When set, the
   * runner sends it; when absent, no authenticate step happens.
   */
  readonly authenticateMethodId?: string | undefined

  /**
   * The `authenticate` method to derive from the `initialize` reply.
   *
   * Qoder's method id differs between its CN and international builds
   * (`qoderclicn-login` vs `qoder-login`), so the agent's own `authMethods` list
   * is the only source that holds across both. Tried after the static id.
   */
  readonly authenticateMethodIdFrom?: ((initializeResult: unknown) => string | undefined) | undefined

  /**
   * Whether `authenticate` can wait until `session/new` refuses the session.
   *
   * Qoder works without the round-trip once its CLI has logged in, and its
   * `authenticate` occasionally stalled for the whole timeout while logged in
   * (measured 2026-10-20: two of three captures hit 120 s, the third returned
   * `{}` instantly). Opening first and authenticating only on a refusal keeps
   * the working path fast. Cursor, whose session/new always fails without it,
   * keeps the eager step.
   */
  readonly authenticateOnDemand?: boolean | undefined

  /**
   * Whether a `session/new` rejection is the agent asking for authentication.
   *
   * Consulted only for `authenticateOnDemand` dialects, to tell "log in first"
   * (worth one authenticate + retry) from every other open failure.
   */
  readonly sessionNeedsAuthenticate?: ((error: unknown) => boolean) | undefined

  /**
   * The tool identity on a permission request.
   *
   * Draft ACP puts it in `toolCall.name`; qoder reports it only in
   * `toolCall._meta.qoder.toolName`, which the shared reader cannot know without
   * asking the dialect. Absent means read `toolCall.name`.
   */
  readonly readPermissionToolName?: ((toolCall: Record<string, unknown>) => string | undefined) | undefined

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
   * How a user-picked modelId reaches the agent.
   *
   * `'prompt_param'` (the default; every dialect so far) tucks `modelId` onto
   * the `session/prompt` params — an extension outside the ACP schema that
   * those agents honor. `'config_option'` uses the protocol's own write path:
   * `session/set_config_option` with the config option that carries the model
   * selector. Qoder publishes that selector in `session/new` (configOptions,
   * category `"model"`) and documents no modelId param on `session/prompt`, so
   * the prompt param would land on a server free to ignore it — the picker
   * would offer a choice the agent never applies.
   */
  readonly modelVia?: 'prompt_param' | 'config_option' | undefined

  /**
   * The config-option id carrying the model selector, read off the
   * `session/new` reply. Consulted per opened session when `modelVia` is
   * `'config_option'`; the selector's id is the agent's to spell.
   */
  readonly modelConfigId?: ((sessionNewReply: unknown) => string | undefined) | undefined

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

  /**
   * The session-update payload this vendor's update-carrying frame holds, or
   * undefined when the frame carries none.
   *
   * The default (no hook) reads `session/update` — every draft-conforming
   * agent. grok ALSO wraps lifecycle updates in a private `_x.ai/session_notification`
   * method (measured 2026-10-20: its whole subagent vocabulary arrives only
   * there), so its dialect claims both methods; the chain still ignores the
   * kinds it does not understand.
   */
  frameUpdate?(frame: { readonly method?: string; readonly params?: unknown }): Record<string, unknown> | undefined

  /**
   * Normalize this vendor's private subagent vocabulary onto the draft-#1992
   * update shape, or return undefined when the update is not one of theirs.
   *
   * grok is the measured case (2026-10-20 capture): it sends the same
   * lifecycle under its own kinds and snake_case fields (`subagent_spawned`
   * with `child_session_id`, `subagent_finished` with `status` and `output`,
   * a metrics-only `subagent_progress`), all on the parent session id. Field
   * reading is a dialect decision by this file's own rule; the normalized
   * update then flows through the shared projection's draft branches.
   */
  normalizeSubagentUpdate?(update: Record<string, unknown>): Record<string, unknown> | undefined
}