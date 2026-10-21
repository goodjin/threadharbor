/**
 * cursor dialect.
 *
 * Read off a live `cursor-agent` build 2026.10.01 (2026-09-14), not guessed.
 * Cursor is the case that forces the authenticate step and carries two blocking
 * custom methods the other three do not. The frame-reading differences from
 * codex (the closest of the three):
 *
 *   - Commands return `rawOutput.stdout`/stderr; reads return rawOutput.content;
 *     edits return ACP diff blocks in content (measured 2026-10-18).
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

  capabilities: {
    cancelsTurns: true,
    acceptsImageContent: true,
    // cursor's tool frames carry a live in-progress status, like claude's.
    toolFrameShape: 'in_progress',
    commandVia: 'tool_frame',
    // foldTool names a call after `kind`, as codex does (`toolCall` carries no
    // `name`; the docs' 工具名 row and the 2026-09-14 capture both say `kind`).
    // The only kind observed is `execute` — a shell command — and DSH's bash
    // card is the matching view (value verified against the reference client's
    // `classifyTool`, 2026-10-13). Other kinds stay unmapped until measured.
    toolNameMap: {
      execute: 'bash',
    },
  },

  foldTool(carried, update) {
    const rawId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
    const toolCallId = singleLineId(rawId)
    const input = record(update['rawInput'])
    // cursor 的子代理派发是它自己的 `task` 工具：ACP 帧里 `kind` 叫 "other"，
    // 原工具名在 rawInput._toolName（2026-10-21 真机抓帧：design-work 派发）。
    // 不认它，投影就看不出这是一次子代理派发，界面上只剩一张叫 "other" 的卡片。
    const dispatch = subagentDispatchOf(input)
    // `kind` ("execute") is the only identity cursor offers, as with codex.
    const name = carried?.name
      || (dispatch === undefined ? undefined : 'subagent')
      || (typeof update['kind'] === 'string' ? update['kind'] : undefined)
      || (typeof update['title'] === 'string' ? update['title'] : 'tool')
    const output = outputFrom(update)
    return {
      callId: toolCallId,
      name,
      // 子代理卡片用草案的形状（prompt + agent），与 codex/grok 的那张一致。
      arguments: dispatch === undefined
        ? (update['rawInput'] ?? carried?.arguments ?? {})
        : { prompt: dispatch.prompt, agent: dispatch.agent },
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

/** cursor's subagent dispatch: the `task` tool (its own name, in rawInput). */
type SubagentDispatch = { readonly prompt: string; readonly agent: string }

/**
 * Read cursor's subagent dispatch out of a tool call's raw input.
 *
 * cursor names its own `task` tool; the ACP frame calls the tool "other" and
 * keeps the original name in `_toolName` (2026-10-21 capture: a design-work
 * dispatch). The description is the agent's name, the prompt is its task —
 * the same two fields the ACP subagent draft's card carries, so the card reads
 * the same as codex's and grok's.
 */
function subagentDispatchOf(input: Record<string, unknown>): SubagentDispatch | undefined {
  if (input['_toolName'] !== 'task') return undefined
  const prompt = typeof input['prompt'] === 'string' ? input['prompt'] : ''
  const description = typeof input['description'] === 'string' ? input['description'] : ''
  if (prompt === '' && description === '') return undefined
  return { prompt, agent: description === '' ? 'subagent' : description }
}

/** Commands return stdout; reads return rawOutput.content; edits return ACP diff content. */
function outputFrom(update: Record<string, unknown>): string {
  const raw = record(update['rawOutput'])
  if (typeof raw['stdout'] === 'string') {
    const stderr = typeof raw['stderr'] === 'string' ? raw['stderr'] : ''
    return [raw['stdout'], stderr].filter(Boolean).join('\n')
  }
  if (typeof raw['content'] === 'string') return raw['content']
  const content = update['content']
  if (Array.isArray(content)) {
    const text = content.map(record).map(part => {
      if (part['type'] === 'diff') {
        const path = typeof part['path'] === 'string' ? part['path'] : ''
        const before = typeof part['oldText'] === 'string' ? part['oldText'] : ''
        const after = typeof part['newText'] === 'string' ? part['newText'] : ''
        const lines = (value: string, prefix: string) => value.replace(/\n$/, '').split('\n').map(line => prefix + line).join('\n')
        return `--- ${path}\n+++ ${path}\n${lines(before, '-')}\n${lines(after, '+')}`
      }
      const block = part['type'] === 'content' ? record(part['content']) : part
      return typeof block['text'] === 'string' ? block['text'] : ''
    }).filter(Boolean).join('\n')
    if (text) return text
  }
  return Object.keys(raw).length > 0 ? JSON.stringify(raw) : ''
}
