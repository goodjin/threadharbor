/**
 * Line-oriented transport for ACP agents that speak JSON-RPC over stdio.
 *
 * Kept behind an interface so the client can be tested without a child process;
 * the grok agent needs a WebSocket instead, which is the other side of the same
 * interface.
 */
export interface AcpTransport {
    /** Write one newline-delimited JSON frame. */
    send(line: string): void;
    /** Register the handler for frames arriving from the agent. */
    onLine(handler: (line: string) => void): void;
    close(): void;
}
export type StdioTransportOptions = {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    /** Agent diagnostics land here; they are never part of the protocol. */
    readonly onDiagnostic?: (line: string) => void;
};
/** ACP over a child process's stdin/stdout, as codex and claude both speak it. */
export declare class StdioAcpTransport implements AcpTransport {
    private readonly options;
    private readonly child;
    private handler;
    constructor(options: StdioTransportOptions);
    send(line: string): void;
    onLine(handler: (line: string) => void): void;
    close(): void;
}
//# sourceMappingURL=transport.d.ts.map