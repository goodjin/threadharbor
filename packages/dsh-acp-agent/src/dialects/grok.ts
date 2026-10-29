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

/**
 * grok's methods whose `params.update` is a session update.
 *
 * `session/update` is the standard one; `_x.ai/session_notification` carries the
 * vendor-only kinds (subagents, usage, compaction), and the two background-task
 * methods carry their own lifecycle (measured 2026-10-29).
 */
const UPDATE_METHODS = new Set([
  'session/update',
  '_x.ai/session_notification',
  '_x.ai/task_backgrounded',
  '_x.ai/task_completed',
])

/** Collapse a multi-line value into one readable line, bounded. */
function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

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
   * grok wraps part of its lifecycle in private methods beside the standard
   * `session/update` (measured 2026-10-20): the whole subagent vocabulary, and
   * its background-task lifecycle on two dedicated methods (measured
   * 2026-10-29). Claiming them here is what lets those frames through the
   * shared gate at all; without it they only reach the raw-output block as
   * opaque JSON, and a running background task has no card.
   */
  frameUpdate(frame) {
    if (frame.method === undefined || !UPDATE_METHODS.has(frame.method)) return undefined
    return record(record(frame.params)['update'])
  },

  /**
   * grok's private subagent lifecycle (real capture 2026-10-20, grok 1.0.60)
   * and background-task lifecycle (real capture 2026-10-29, grok 1.0.70) onto
   * the draft-#1992 shape the shared projection speaks:
   *
   *   subagent_spawned  { child_session_id, subagent_type, description } →
   *       spawned { subagentSessionId, name: subagent_type, task: description }
   *   subagent_finished { child_session_id, status, output } →
   *       state_update { subagentSessionId, state: status, output }
   *   subagent_progress → dropped: pure metrics (tokens, duration, context
   *       usage) with no text; inventing a line from them would fabricate a
   *       progress string the agent never wrote.
   *   task_backgrounded { task_id, command, description, output_file } →
   *       async_task_spawned { asyncTaskId, name, taskType: 'bash', ... }
   *   task_completed { task_snapshot: { task_id, output, exit_code, ... } } →
   *       async_task_state_update { asyncTaskId, state, summary }
   *
   * The background-task card is what tells the user a command is still
   * running: grok returns the prompt reply right after backgrounding, so
   * without this card the only visible trace is a completed dispatch call.
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
    if (kind === 'task_backgrounded') {
      const taskId = typeof update['task_id'] === 'string' ? update['task_id'] : undefined
      if (taskId === undefined) return undefined
      const command = typeof update['command'] === 'string' ? update['command'] : ''
      const description = typeof update['description'] === 'string' ? update['description'] : ''
      const normalized: Record<string, unknown> = {
        sessionUpdate: 'async_task_spawned',
        asyncTaskId: taskId,
        // The card's title is what the user saw when the task started; the
        // command follows it in the arguments so the row says what is running.
        name: oneLine(description !== '' ? description : command, 160) || taskId,
        taskType: 'bash',
        description: command,
      }
      if (typeof update['output_file'] === 'string') normalized['outputFilePath'] = update['output_file']
      return normalized
    }
    if (kind === 'task_completed') {
      const snapshot = record(update['task_snapshot'])
      const taskId = typeof snapshot['task_id'] === 'string' ? snapshot['task_id'] : undefined
      if (taskId === undefined) return undefined
      const killed = snapshot['explicitly_killed'] === true
      const completed = snapshot['completed'] === true
      const exitCode = typeof snapshot['exit_code'] === 'number' ? snapshot['exit_code'] : undefined
      const signal = typeof snapshot['signal'] === 'string' ? snapshot['signal'] : undefined
      const failed = !completed || signal !== undefined || (exitCode !== undefined && exitCode !== 0)
      const state = killed ? 'stopped' : failed ? 'failed' : 'completed'
      const head = state === 'completed'
        ? `后台任务完成${exitCode === undefined ? '' : `（退出码 ${String(exitCode)}）`}`
        : state === 'stopped'
          ? '后台任务已停止'
          : `后台任务失败${exitCode === undefined ? '' : `（退出码 ${String(exitCode)}）`}${signal === undefined ? '' : `（信号 ${signal}）`}`
      const output = typeof snapshot['output'] === 'string' ? snapshot['output'].trimEnd() : ''
      return {
        sessionUpdate: 'async_task_state_update',
        asyncTaskId: taskId,
        state,
        summary: output === '' ? head : `${head}\n${output}`,
      }
    }
    return undefined
  },
}