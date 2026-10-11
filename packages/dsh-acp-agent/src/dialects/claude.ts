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

import { randomUUID } from 'node:crypto'
import type { AcpDialect, ToolCall } from './types.ts'
import { replyUsageOf } from './usage.ts'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(content: unknown): string {
  return typeof record(content)['text'] === 'string' ? (record(content)['text'] as string) : ''
}

/**
 * Unwrap ACP's nested content list.
 *
 * claude sends `[{ type: 'content', content: { type: 'text', text } }]`, so the
 * text sits two levels down. A flat `[{ type: 'text', text }]` is accepted too,
 * and an in-progress chunk with empty text yields '' so the previous output
 * survives.
 */
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

const CHATTER = new Set([
  'available_commands_update',
  'usage_update',
  'session_info_update',
  'current_mode_update',
  'config_option_update',
])

export const claudeDialect: AcpDialect = {
  id: 'claude',

  foldTool(carried, update) {
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
    const meta = record(record(update['_meta'])['claudeCode'])
    // The name only ever appears under _meta for updates, but a permission
    // request carries it as `name`; accept both so one extractor serves both.
    const reported = typeof meta['toolName'] === 'string'
      ? meta['toolName']
      : typeof update['name'] === 'string' ? update['name'] : undefined
    // Latch the identity: `title` is rewritten as the call progresses, so once
    // a name is known, later frames must not replace it.
    const name = carried?.name || reported || (typeof update['title'] === 'string' ? update['title'] : 'tool')
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
    const direct = nestedText(update['content'])
    if (direct.length > 0) return direct
    return nestedText(record(update['rawOutput'])['formatted_output'])
  },

  readModels(reply) {
    const options = record(reply)['configOptions']
    if (!Array.isArray(options)) return []
    const entry = options
      .map(record)
      .find(option => option['id'] === 'model' || option['category'] === 'model')
    const choices = record(entry)['options']
    if (!Array.isArray(choices)) return []
    return choices.map(record).flatMap(choice => {
      const id = choice['value']
      if (typeof id !== 'string') return []
      const name = typeof choice['name'] === 'string' ? choice['name'] : id
      const description = typeof choice['description'] === 'string' ? choice['description'] : undefined
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