/**
 * claude-agent-acp dialect.
 *
 * Read off a live `claude-agent-acp@0.76.0` (2026-10-09), not guessed. Two
 * details here are the reason this cannot be the grok projection:
 *
 *   - The tool's name is in `update._meta.claudeCode.toolName` ("Bash"), *not*
 *     in `title` — `title` holds a human line ("Write 'ok' to probe file") and
 *     changes as the call progresses. The permission request frame is worse:
 *     there the name is in `toolCall.name` while updates use `_meta`, so the
 *     same agent disagrees with itself.
 *   - Output is the same double-nested content grok uses, and the final update
 *     also carries `rawOutput`.
 *
 * Note the model behind this capture is a relay, not Anthropic's Claude — the
 * adapter's frame shapes are what this dialect encodes, and those are real.
 */
import type { AcpDialect } from './types.ts';
export declare const claudeDialect: AcpDialect;
//# sourceMappingURL=claude.d.ts.map