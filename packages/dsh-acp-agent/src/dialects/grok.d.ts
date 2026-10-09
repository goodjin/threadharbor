/**
 * grok dialect.
 *
 * Captured from a live `grok agent serve` (grok 1.0.46), the same frames the
 * original `packages/dsh-grok-agent` projection was written against. grok is
 * the only one of the three that puts the tool's name in `title`, and it only
 * does so on the *opening* frame: every later `tool_call_update` overwrites
 * `title` with a human activity line ("Execute `echo ...`"). The name therefore
 * has to be latched, which is what `carried?.name ||` below does.
 *
 * It is also the only one that reports token counts on the update frame's
 * `_meta`; codex and claude send them on the `session/prompt` response instead.
 *
 * Transport note: grok is reached over a WebSocket whose URL carries the secret
 * as `server-key` — there is no Authorization header. That is a property of
 * the transport, not of the dialect, so it lives with the client that needs it.
 */
import type { AcpDialect } from './types.ts';
export declare const grokDialect: AcpDialect;
//# sourceMappingURL=grok.d.ts.map