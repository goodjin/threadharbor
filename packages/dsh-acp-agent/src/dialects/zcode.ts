/**
 * zcode dialect.
 *
 * zcode is the one agent whose ACP side we own: `packages/zcode-acp` both
 * speaks the frames and is spawned as the command, so this dialect reads the
 * shapes that adapter emits rather than accommodating an external
 * implementation. The conventions it follows are the ones already measured on
 * the other agents (2026-10-13, live capture via the adapter against the real
 * app-server; facts also in docs/agent-acp/zcode.md):
 *
 * - Models ride `session/new` as `.models.availableModels[{modelId,name}]`,
 *   the same place codex and grok put them.
 * - Tool identity rides `title`, repeated on every frame of the call — the
 *   adapter never sends a human activity line there, but the latch stays
 *   because the shared projection overwrites titles as calls progress.
 * - Tool output would ride `content` (nested twice); ZCode exposes no tool
 *   output text, so the adapter sends `content: []` and the folded output is
 *   empty — the card closes without a body, which DSH renders fine.
 * - Usage rides the `session/prompt` reply under `usage`, spelled the way
 *   `replyUsageOf` reads (inputTokens/outputTokens + renamed buckets).
 *
 * The adapter's tool names are ZCode's own (Write/Edit/Read/Bash/…), the
 * same vocabulary claude reports, so the short-name map is claude's.
 */

import { randomUUID } from 'node:crypto'
import type { AcpDialect, ToolCall } from './types.ts'
import { replyUsageOf } from './usage.ts'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

const CHATTER = new Set([
  'available_commands_update',
  'usage_update',
  'session_info_update',
])

export const zcodeDialect: AcpDialect = {
  id: 'zcode',

  capabilities: {
    // session/stop underneath ends the turn; the prompt reply then carries
    // stopReason `cancelled`.
    cancelsTurns: true,
    // ZCode's session/send takes plain text only.
    acceptsImageContent: false,
    // The adapter emits an opening frame on tool.lifecycle `scheduled` and a
    // completed one on the terminal phase; no granular progress in between.
    toolFrameShape: 'two_frame',
    commandVia: 'tool_frame',
    // Values verified against the reference DSH client's classifyTool and
    // tool.call.toolview keys (2026-10-13), same as claude's map.
    toolNameMap: {
      Write: 'write',
      Edit: 'edit',
      MultiEdit: 'edit',
      Read: 'read',
      Bash: 'bash',
      Grep: 'grep',
      Glob: 'glob',
      WebFetch: 'web_fetch',
      WebSearch: 'web_search',
      TodoWrite: 'todo_write',
      Skill: 'skill',
    },
  },

  foldTool(carried, update) {
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
    // Latch the identity from `title`: the adapter repeats the tool name
    // there, and latching is the rule that survives any later rewrite.
    const name = carried?.name
      || (typeof update['title'] === 'string' ? update['title'] : undefined)
      || (typeof update['name'] === 'string' ? update['name'] : undefined)
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

  readReplyUsage(result) {
    return replyUsageOf(result)
  },

  isContent(update) {
    return typeof update['sessionUpdate'] === 'string' && !CHATTER.has(update['sessionUpdate'] as string)
  },
}

/** The shared double-nested `content` text, the shape grok and claude use. */
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
