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
 * It also keeps its token count as a running `totalTokens` on the update
 * frame's `_meta` — a session-to-date total that cannot be split into the
 * input/output pair a DSH usage requires, so grok turns carry no usage. codex
 * and claude send a full breakdown on the `session/prompt` response instead.
 *
 * Transport note: grok is reached over a WebSocket whose URL carries the secret
 * as `server-key` — there is no Authorization header. That is a property of
 * the transport, not of the dialect, so it lives with the client that needs it.
 */

import { randomUUID } from 'node:crypto'
import type { AcpDialect, ToolCall } from './types.ts'
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** Unwrap grok's `[{type:'content', content:{type:'text', text}}]` nesting. */
function nestedText(content: unknown): string {
  if (!Array.isArray(content)) return textOf(content)
  const parts: string[] = []
  for (const item of content) {
    const entry = record(item)
    const inner = entry['content'] === undefined ? entry : record(entry['content'])
    const text = textOf(inner)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('')
}

function textOf(content: unknown): string {
  const entry = record(content)
  return typeof entry['text'] === 'string' ? (entry['text'] as string) : ''
}

const CHATTER = new Set(['available_commands_update', 'usage_update', 'session_info_update'])

export const grokDialect: AcpDialect = {
  id: 'grok',

  capabilities: {
    cancelsTurns: true,
    acceptsImageContent: true,
    // grok emits an opening frame and a completed frame per call — no
    // in-progress status in between.
    toolFrameShape: 'two_frame',
    commandVia: 'tool_frame',
    // The latched first-frame `title` is grok's tool identity. The one tool
    // observed live (2026-10-09 capture, `tests/live.spec.ts`) is the terminal
    // command tool; DSH's bash card is the matching view (value verified
    // against the reference client's `classifyTool`, 2026-10-13). Any other
    // title stays itself and degrades to the generic card.
    toolNameMap: {
      run_terminal_command: 'bash',
    },
  },

  foldTool(carried, update) {
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
    // Latch the name: later updates replace `title` with a human line.
    const name = carried?.name
      || (typeof update['title'] === 'string' ? update['title'] : undefined)
      || 'tool'
    const output = nestedText(update['content'])
    return {
      callId: toolCallId,
      name,
      arguments: update['rawInput'] ?? carried?.arguments ?? {},
      title: typeof update['title'] === 'string' ? update['title'] : carried?.title,
      status: typeof update['status'] === 'string' ? update['status'] : carried?.status,
      output: output.length > 0 ? output : (carried?.output ?? ''),
    } satisfies ToolCall
  },

  toolOutput(update) {
    return nestedText(update['content'])
  },

  readModels(reply) {
    const available = record(record(reply)['models'])['availableModels']
    if (!Array.isArray(available)) return []
    return available.map(record).flatMap(model => {
      const id = model['modelId']
      if (typeof id !== 'string') return []
      const name = typeof model['name'] === 'string' ? model['name'] : id
      const description = typeof model['description'] === 'string' ? model['description'] : undefined
      return [{ id, name, ...(description === undefined ? {} : { description }) }]
    })
  },

  readReplyUsage() {
    // grok never sends a usage object on the prompt reply; it keeps a running
    // `totalTokens` on update frames' `_meta`. A total alone cannot be split
    // into the input/output pair a DSH usage requires, so there is nothing
    // honest to report — the projection writes no usage for grok turns.
    return undefined
  },

  isContent(update) {
    return typeof update['sessionUpdate'] === 'string' && !CHATTER.has(update['sessionUpdate'] as string)
  },
}