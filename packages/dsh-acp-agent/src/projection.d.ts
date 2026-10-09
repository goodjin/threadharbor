/**
 * Translate one turn of ACP session updates into DSH session events.
 *
 * The projection itself is agent-agnostic: every field-reading decision is
 * delegated to an `AcpDialect`, because the three agents we drive disagree
 * about where a tool's name lives, where its output lives, and how it reports
 * tokens. What lives here is the shape of a DSH turn, which is fixed.
 */
import type { AcpFrame } from './acp-client.ts';
import type { AcpDialect } from './dialects/types.ts';
/** The DSH event names this projection writes. */
export type ProjectionEvent = {
    readonly type: string;
    readonly payload: unknown;
};
/**
 * Fold one turn's ACP frames into the events that describe it.
 *
 * Returns an ordered event list; an empty list means the frames carried
 * nothing the session log records. The caller appends them in order.
 */
export declare function projectTurn(frames: readonly AcpFrame[], options: {
    readonly turn: number;
    readonly dialect: AcpDialect;
}): ProjectionEvent[];
/** The user turn's own event, appended before the agent starts work. */
export declare function projectUserMessage(text: string, turn: number): ProjectionEvent[];
//# sourceMappingURL=projection.d.ts.map