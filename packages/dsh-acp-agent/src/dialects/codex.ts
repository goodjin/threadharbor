/**
 * codex-acp dialect.
 *
 * Read off a live `codex-acp` (2026-10-09), not guessed. Codex is the awkward
 * one of the three — it is the case that makes a shared projection wrong:
 *
 *   - **It never reports a tool name.** `title` holds the command the agent
 *     wants to run ("ls -la\nfind . | wc -l"), and the only other identity-ish
 *     field is `kind` ("execute"). So `kind` is the closest thing available and
 *     is used as the tool name. Rendering the command as a tool name — what
 *     grok's projection does — would put a whole shell command where a tool
 *     name belongs.
 *   - **Tool output is not in `content`.** The `tool_call_update` has no
 *     `content` field at all; the result lives at `rawOutput.formatted_output`
 *     alongside `exit_code`. Reading `content` the way grok's projection does
 *     silently yields empty output for every codex tool call.
 *
 * `session/new` returns `models.availableModels` like grok, but **without**
 * `currentModelId`. Token counts arrive on the `session/prompt` response under
 * `usage`, with the cache buckets spelled `cachedReadTokens`/`cachedWriteTokens`
 * and the output's reasoning subset as `thoughtTokens` — DSH's names differ, so
 * `readReplyUsage` translates instead of passing the object through.
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

export const codexDialect: AcpDialect = {
  id: 'codex',

  capabilities: {
    cancelsTurns: true,
    acceptsImageContent: true,
    // codex emits an opening frame and a completed frame per call — no
    // in-progress status in between.
    toolFrameShape: 'two_frame',
    commandVia: 'tool_frame',
    // foldTool names a call after `kind`, the only identity codex offers. The
    // one kind observed live (2026-10-09 capture) is `execute` — a shell
    // command on `rawInput.command` — and DSH's bash card is the matching view
    // (value verified against the reference client's `classifyTool`, 2026-10-13).
    // The other ACP kinds (read/edit/search/…) are unmeasured and stay
    // unmapped: they degrade to the generic card instead of risking a wrong
    // dedicated one.
    toolNameMap: {
      execute: 'bash',
    },
  },

  foldTool(carried, update) {
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
    // `kind` is the tool category ("execute"), which is the only identity codex
    // offers. Latch it so a later frame without `kind` cannot blank it out.
    const name = carried?.name
      || (typeof update['kind'] === 'string' ? update['kind'] : undefined)
      || (typeof update['title'] === 'string' ? update['title'] : 'tool')
    const output = outputFrom(update)
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
    return outputFrom(update)
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

/** Codex puts the result at `rawOutput.formatted_output`, never in `content`. */
function outputFrom(update: Record<string, unknown>): string {
  const raw = record(update['rawOutput'])
  return typeof raw['formatted_output'] === 'string' ? raw['formatted_output'] : ''
}