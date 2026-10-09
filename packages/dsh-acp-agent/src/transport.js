/**
 * Line-oriented transport for ACP agents that speak JSON-RPC over stdio.
 *
 * Kept behind an interface so the client can be tested without a child process;
 * the grok agent needs a WebSocket instead, which is the other side of the same
 * interface.
 */
import { spawn } from 'node:child_process';
/**
 * Split a byte stream into lines.
 *
 * ACP stdio is newline-delimited JSON, but one frame can be split across chunks,
 * so this buffers rather than splitting each chunk blindly.
 */
function lineSplitter(onLine) {
    let buffer = '';
    return chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line.length > 0)
                onLine(line);
        }
    };
}
/** ACP over a child process's stdin/stdout, as codex and claude both speak it. */
export class StdioAcpTransport {
    options;
    child;
    handler = () => { };
    constructor(options) {
        this.options = options;
        // Spawned here rather than in a field initializer: with class fields, the
        // initializers run before the constructor assigns `this.options`, so a
        // field initializer would dereference an undefined options.
        this.child = spawn(this.options.command, [...(this.options.args ?? [])], {
            ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(this.options.env === undefined ? {} : { env: this.options.env }),
        });
        // Typed as possibly-null because spawn's stdio is a union; asking for
        // pipes above is what makes them present.
        const stdout = this.child.stdout;
        const stderr = this.child.stderr;
        const stdin = this.child.stdin;
        if (stdout === null || stderr === null || stdin === null) {
            throw new Error(`acp agent ${this.options.command} did not start with pipes`);
        }
        stdout.setEncoding('utf8');
        stdout.on('data', lineSplitter(line => this.handler(line)));
        stderr.setEncoding('utf8');
        stderr.on('data', chunk => {
            if (this.options.onDiagnostic === undefined)
                return;
            for (const line of chunk.split('\n')) {
                if (line.trim().length > 0)
                    this.options.onDiagnostic(line.trim());
            }
        });
    }
    send(line) {
        this.child.stdin?.write(`${line}\n`);
    }
    onLine(handler) {
        this.handler = handler;
    }
    close() {
        this.child.kill('SIGTERM');
    }
}
//# sourceMappingURL=transport.js.map