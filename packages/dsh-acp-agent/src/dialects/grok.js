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
import { randomUUID } from 'node:crypto';
function record(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
/** Unwrap grok's `[{type:'content', content:{type:'text', text}}]` nesting. */
function nestedText(content) {
    if (!Array.isArray(content))
        return textOf(content);
    const parts = [];
    for (const item of content) {
        const entry = record(item);
        const inner = entry['content'] === undefined ? entry : record(entry['content']);
        const text = textOf(inner);
        if (text.length > 0)
            parts.push(text);
    }
    return parts.join('');
}
function textOf(content) {
    const entry = record(content);
    return typeof entry['text'] === 'string' ? entry['text'] : '';
}
const CHATTER = new Set(['available_commands_update', 'usage_update', 'session_info_update']);
export const grokDialect = {
    id: 'grok',
    foldTool(carried, update) {
        const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID();
        // Latch the name: later updates replace `title` with a human line.
        const name = carried?.name
            || (typeof update['title'] === 'string' ? update['title'] : undefined)
            || 'tool';
        const output = nestedText(update['content']);
        return {
            callId: toolCallId,
            name,
            arguments: update['rawInput'] ?? carried?.arguments ?? {},
            title: typeof update['title'] === 'string' ? update['title'] : carried?.title,
            status: typeof update['status'] === 'string' ? update['status'] : carried?.status,
            output: output.length > 0 ? output : (carried?.output ?? ''),
        };
    },
    toolOutput(update) {
        return nestedText(update['content']);
    },
    readModels(reply) {
        const available = record(record(reply)['models'])['availableModels'];
        if (!Array.isArray(available))
            return [];
        return available.map(record).flatMap(model => {
            const id = model['modelId'];
            if (typeof id !== 'string')
                return [];
            const name = typeof model['name'] === 'string' ? model['name'] : id;
            const description = typeof model['description'] === 'string' ? model['description'] : undefined;
            return [{ id, name, ...(description === undefined ? {} : { description }) }];
        });
    },
    readUpdateTokens(params) {
        const total = record(params['_meta'])['totalTokens'];
        return typeof total === 'number' ? total : undefined;
    },
    isContent(update) {
        return typeof update['sessionUpdate'] === 'string' && !CHATTER.has(update['sessionUpdate']);
    },
};
//# sourceMappingURL=grok.js.map