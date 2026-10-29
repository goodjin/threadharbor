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

/**
 * Parse a buffered argument JSON string into the object the card carries.
 *
 * grok streams its tool arguments as `arguments_delta` fragments; the buffer is
 * only complete JSON once the last fragment lands. A partial buffer is the
 * normal state mid-stream, so an incomplete parse yields an empty object — the
 * card shows nothing rather than a fabricated half-argument.
 */
function parseArgs(buffer: string): Record<string, unknown> {
  if (buffer.trim() === '') return {}
  try {
    const parsed = JSON.parse(buffer)
    return typeof parsed === 'object' && parsed !== null ? record(parsed) : {}
  } catch {
    return {}
  }
}

function modelSelector(reply: unknown): Record<string, unknown> | undefined {
  const options = record(reply)['configOptions']
  if (!Array.isArray(options)) return undefined
  return options
    .map(record)
    .find(option => option['id'] === 'model' || option['category'] === 'model')
}

const CHATTER = new Set(['available_commands_update', 'usage_update', 'session_info_update'])

export const grokDialect: AcpDialect = {
  id: 'grok',

  capabilities: {
    cancelsTurns: true,
    acceptsImageContent: true,
    // `session/resume` is real (measured 2026-10-29): a live session reattached
    // in its own `agent serve`, and the same session id reattached again in a
    // freshly spawned serve after the first process was killed. grok keeps the
    // conversation in `~/.grok/sessions/<项目>/<sessionId>/updates.jsonl`, so a
    // process restart does not cost the history.
    supportsSessionResume: true,
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

  foldToolDelta(carried, update) {
    // grok's incremental tool frames: the first carries the tool identity
    // (`name` + `tool_call_id`); the rest carry an `arguments_delta` JSON-string
    // fragment. These arrive before the canonical `tool_call` frame, so the card
    // they build has to stand on its own until that frame (or a terminal) lands.
    const toolCallId = typeof update['tool_call_id'] === 'string'
      ? update['tool_call_id']
      : typeof update['toolCallId'] === 'string'
        ? update['toolCallId']
        : carried?.callId ?? randomUUID()
    const name = carried?.name
      || (typeof update['name'] === 'string' ? update['name'] : undefined)
      || 'tool'
    // Accumulate the streamed fragments onto the carried buffer; the next frame
    // appends rather than replaces, so a JSON object split across frames
    // reassembles.
    const delta = typeof update['arguments_delta'] === 'string' ? update['arguments_delta'] : ''
    const buffer = `${carried?.argumentsBuffer ?? ''}${delta}`
    return {
      callId: toolCallId,
      name,
      arguments: parseArgs(buffer),
      argumentsBuffer: buffer,
      title: carried?.title,
      status: carried?.status,
      output: carried?.output ?? '',
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

  // grok publishes the model as a standard config option and names no
  // prompt-side model param (grok 1.0.62 probe, 2026-10-22). The picker's ids
  // are the selector's values verbatim, so the write is a direct pass-through.
  modelVia: 'config_option',

  modelConfigId(reply) {
    const id = modelSelector(reply)?.['id']
    return typeof id === 'string' ? id : undefined
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

  /**
   * grok wraps part of its lifecycle in a private `_x.ai/session_notification`
   * method beside the standard `session/update` (measured 2026-10-20): the
   * whole subagent vocabulary, plus vendor-only kinds the projection chain
   * ignores. Claiming the method here is what lets those frames through the
   * shared gate at all.
   */
  frameUpdate(frame) {
    if (frame.method !== 'session/update' && frame.method !== '_x.ai/session_notification') return undefined
    return record(record(frame.params)['update'])
  },

  /**
   * grok's private subagent lifecycle (real capture 2026-10-20, grok 1.0.60)
   * onto the draft-#1992 shape the shared projection speaks:
   *
   *   subagent_spawned  { child_session_id, subagent_type, description } →
   *       spawned { subagentSessionId, name: subagent_type, task: description }
   *   subagent_finished { child_session_id, status, output } →
   *       state_update { subagentSessionId, state: status, output }
   *   subagent_progress → dropped: pure metrics (tokens, duration, context
   *       usage) with no text; inventing a line from them would fabricate a
   *       progress string the agent never wrote.
   */
  normalizeSubagentUpdate(update) {
    const kind = typeof update['sessionUpdate'] === 'string' ? update['sessionUpdate'] : ''
    const childId = typeof update['child_session_id'] === 'string' ? update['child_session_id'] : undefined
    if (kind === 'subagent_spawned') {
      if (childId === undefined) return undefined
      return {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: childId,
        name: typeof update['subagent_type'] === 'string' ? update['subagent_type'] : childId,
        task: typeof update['description'] === 'string' ? update['description'] : '',
      }
    }
    if (kind === 'subagent_finished') {
      if (childId === undefined) return undefined
      const normalized: Record<string, unknown> = {
        sessionUpdate: 'subagent_state_update',
        subagentSessionId: childId,
        state: typeof update['status'] === 'string' ? update['status'] : 'failed',
      }
      if (typeof update['output'] === 'string') normalized['output'] = update['output']
      return normalized
    }
    return undefined
  },
}