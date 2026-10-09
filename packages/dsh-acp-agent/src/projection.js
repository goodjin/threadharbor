/**
 * Translate one turn of ACP session updates into DSH session events.
 *
 * The projection itself is agent-agnostic: every field-reading decision is
 * delegated to an `AcpDialect`, because the three agents we drive disagree
 * about where a tool's name lives, where its output lives, and how it reports
 * tokens. What lives here is the shape of a DSH turn, which is fixed.
 */
import { randomUUID } from 'node:crypto';
function recordOf(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
function textOf(content) {
    const entry = recordOf(content);
    return typeof entry['text'] === 'string' ? entry['text'] : '';
}
function assistantEvent(dialect, acc, content, turn) {
    return {
        type: 'assistant/message',
        payload: {
            turn,
            step: 1,
            message: {
                id: randomUUID(),
                role: 'assistant',
                content,
                source: { provider: `acp-${dialect.id}`, model: dialect.id },
            },
            stream: [],
            usage: acc.totalTokens === undefined ? undefined : { inputTokens: 0, outputTokens: acc.totalTokens },
        },
    };
}
/**
 * Fold one turn's ACP frames into the events that describe it.
 *
 * Returns an ordered event list; an empty list means the frames carried
 * nothing the session log records. The caller appends them in order.
 */
export function projectTurn(frames, options) {
    const { dialect, turn } = options;
    const thought = [];
    const text = [];
    const tools = new Map();
    let totalTokens;
    for (const frame of frames) {
        if (frame.method !== 'session/update')
            continue;
        const params = recordOf(frame.params);
        const update = recordOf(params['update']);
        const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : '';
        if (kind === 'agent_thought_chunk')
            thought.push(textOf(update['content']));
        else if (kind === 'agent_message_chunk')
            text.push(textOf(update['content']));
        else if (kind === 'tool_call' || kind === 'tool_call_update') {
            const carried = typeof update['toolCallId'] === 'string' ? tools.get(update['toolCallId']) : undefined;
            const call = dialect.foldTool(carried, update);
            tools.set(call.callId, call);
        }
        else if (!dialect.isContent(update)) {
            // chatter — setup phases, command lists, context-window updates
        }
        const reported = dialect.readUpdateTokens(params);
        if (reported !== undefined)
            totalTokens = reported;
    }
    const acc = { thought, text, tools, totalTokens };
    const events = [];
    events.push({ type: 'turn/start', payload: { turn } });
    events.push({ type: 'step/start', payload: { turn, step: 1 } });
    if (thought.length > 0) {
        events.push(assistantEvent(dialect, acc, [{ type: 'reasoning', text: thought.join('') }], turn));
    }
    if (text.length > 0) {
        events.push(assistantEvent(dialect, acc, [{ type: 'text', text: text.join('') }], turn));
    }
    for (const tool of tools.values()) {
        events.push({
            type: 'tool/call',
            payload: { turn, step: 1, callId: tool.callId, name: tool.name, arguments: JSON.stringify(tool.arguments) },
        });
        const isError = tool.status === 'failed';
        events.push({
            type: 'tool/result',
            payload: {
                turn,
                step: 1,
                message: {
                    id: randomUUID(),
                    role: 'tool',
                    content: tool.output.length > 0 ? [{ type: 'text', text: tool.output }] : [],
                    source: { kind: 'tool', callId: tool.callId },
                    toolCallId: tool.callId,
                    isError,
                },
                ...(isError ? { error: { name: 'tool', code: tool.status ?? 'failed', reason: tool.title } } : {}),
            },
        });
    }
    events.push({ type: 'step/end', payload: { turn, step: 1 } });
    events.push({ type: 'turn/end', payload: { turn } });
    return events;
}
/** The user turn's own event, appended before the agent starts work. */
export function projectUserMessage(text, turn) {
    return [
        { type: 'user/message', payload: { turn, message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { source: 'user' } } } },
        { type: 'turn/start', payload: { turn } },
    ];
}
//# sourceMappingURL=projection.js.map