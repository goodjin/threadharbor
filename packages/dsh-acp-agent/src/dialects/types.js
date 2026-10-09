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
export {};
//# sourceMappingURL=types.js.map