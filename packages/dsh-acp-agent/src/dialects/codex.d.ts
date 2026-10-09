/**
 * codex-acp dialect.
 *
 * Read off a live `codex-acp` (2026-10-09), not guessed. Codex is the awkward
 * one of the three — it is the case that makes a shared projection wrong:
 *
 *   - **It never reports a tool name.** `title` holds the command the agent
 *     wants to run ("ls -la\nfind . | wc -l"), and the only other identity-ish
 *     field is `kind` ("execute"). So `kind` is the closest thing available and
 *     is used as the tool name. Rendering the command as a tool name — what
 *     grok's projection does — would put a whole shell command where a tool
 *     name belongs.
 *   - **Tool output is not in `content`.** The `tool_call_update` has no
 *     `content` field at all; the result lives at `rawOutput.formatted_output`
 *     alongside `exit_code`. Reading `content` the way grok's projection does
 *     silently yields empty output for every codex tool call.
 *
 * `session/new` returns `models.availableModels` like grok, but **without**
 * `currentModelId`. Token counts arrive on the `session/prompt` response, not
 * on any update frame, so `readUpdateTokens` reports nothing here.
 */
import type { AcpDialect } from './types.ts';
export declare const codexDialect: AcpDialect;
//# sourceMappingURL=codex.d.ts.map