/**
 * cursor dialect.
 *
 * Read off a live `cursor-agent` build 2026.10.01 (2026-09-14), not guessed.
 * Cursor is the case that forces the authenticate step and carries two blocking
 * custom methods the other three do not. The frame-reading differences from
 * codex (the closest of the three):
 *
 *   - **Tool output is at `rawOutput.stdout`**, not `formatted_output`. Cursor
 *     reports `{exitCode, stdout, stderr}`; reading the codex field yields empty
 *     output for every cursor tool call.
 *   - **The tool name is `kind`** ("execute"), the same as codex — there is no
 *     `name` field on `toolCall`.
 *   - **`toolCallId` can contain a literal newline** (it concatenates two ids).
 *     Left in, it breaks single-line logging and the JSON stream, so it is
 *     collapsed here; every frame of one call shares the id, so folding still
 *     matches.
 *   - **No token usage over ACP.** The `session/prompt` reply is a bare
 *     `stopReason`; `readReplyUsage` returns undefined so the UI shows nothing
 *     rather than a fabricated zero.
 *   - **`authenticateMethodId: 'cursor_login'`** — the runner must call
 *     `authenticate` between `initialize` and `session/new`; skip it and the
 *     session/new fails.
 *
 * Models come from `session/new` `.models.availableModels` like codex, but the
 * ids carry a config suffix (`grok-4.7[context=256k,reasoning_effort=high,
 * fast=true]`) that is a distinct configuration, not a reasoning-effort axis —
 * so the catalog does not collapse cursor's ids (see the preset's
 * `collapseEfforts: false`).
 */

import { randomUUID } from 'node:crypto'
import type { AcpDialect, ToolCall } from './types.ts'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

const CHATTER = new Set([
  'current_mode_update',
  'available_commands_update',
  'session_info_update',
])

/** Cursor joins two ids with a newline; collapse it so the id is single-line. */
function singleLineId(id: string): string {
  return id.replace(/[\r\n]+/g, '')
}

export const cursorDialect: AcpDialect = {
  id: 'cursor',

  // The runner sends `authenticate { methodId: 'cursor_login' }` after
  // `initialized` and before `session/new`. Without it session/new fails.
  authenticateMethodId: 'cursor_login',

  foldTool(carried, update) {
    const rawId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
    const toolCallId = singleLineId(rawId)
    // `kind` ("execute") is the only identity cursor offers, as with codex.
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
      const name = typeof model['name'] === 'string' ? model.name : id
      const description = typeof model['description'] === 'string' ? model['description'] : undefined
      return [{ id, name, ...(description === undefined ? {} : { description }) }]
    })
  },

  readReplyUsage() {
    return undefined
  },

  isContent(update) {
    return typeof update['sessionUpdate'] === 'string' && !CHATTER.has(update['sessionUpdate'] as string)
  },
}

/** Cursor puts the result at `rawOutput.stdout`, never in `content`. */
function outputFrom(update: Record<string, unknown>): string {
  const raw = record(update['rawOutput'])
  return typeof raw['stdout'] === 'string' ? raw['stdout'] : ''
}
