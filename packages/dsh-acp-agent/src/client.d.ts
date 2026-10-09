/**
 * The agent-agnostic half of talking ACP: request/response bookkeeping and the
 * agent-initiated requests we have to answer.
 *
 * What lives here is the protocol; what varies per agent lives in its dialect.
 * The one thing worth reading closely is `answerPermission` — see the comment
 * there for the hang this shape was measured producing.
 */
import type { AcpFrame, AcpSession } from './acp-client.ts';
import type { AcpDialect } from './dialects/types.ts';
import type { AcpTransport } from './transport.ts';
/** A permission request, flattened out of the raw frame for the caller. */
export type PermissionRequest = {
    readonly requestId?: string | number;
    readonly sessionId?: string;
    /** The tool asking, when the agent names it. */
    readonly toolName?: string;
    /** The tool's arguments, for rendering "this is what it wants to do". */
    readonly rawInput?: unknown;
    readonly title?: string;
    /** The agent's own choices, so a decision maps onto what it accepts. */
    readonly options: readonly {
        optionId: string;
        name: string;
        kind: string;
    }[];
};
export type PermissionDecision = {
    readonly outcome: 'allow';
} | {
    readonly outcome: 'reject';
};
export declare class AcpClient {
    private readonly transport;
    private readonly dialect;
    private readonly pending;
    private nextId;
    onNotification: (frame: AcpFrame) => void;
    onPermissionRequest: (request: PermissionRequest) => Promise<PermissionDecision>;
    constructor(transport: AcpTransport, dialect: {
        readonly id: string;
    });
    /** Send a request and resolve when the agent answers it. */
    request(method: string, params: unknown): Promise<unknown>;
    /** Tell the agent something without waiting for an answer. */
    notify(method: string, params: unknown): void;
    /**
     * Read the model list out of a `session/new` reply through the dialect.
     *
     * The three agents disagree on where it lives, so this delegates rather than
     * assuming a shape.
     */
    static toSession(reply: unknown, dialect: AcpDialect): AcpSession;
    close(): void;
    private receive;
    /**
     * Answer a permission request.
     *
     * The answer **must** be a JSON-RPC response echoing the request's own id.
     * Answering with a notification (no id) is accepted silently by the agent and
     * the turn then never returns — measured: a real capture hung for the full
     * 240 s budget with no error, no timeout, no further frames.
     */
    private answerPermission;
    private failAll;
}
//# sourceMappingURL=client.d.ts.map