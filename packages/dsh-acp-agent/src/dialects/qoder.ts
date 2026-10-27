/**
 * qoder dialect.
 *
 * Read off a live `qoder-cli-cn` 1.1.6 (`qoderclicn --acp`) on 2026-10-20, not
 * guessed. Qoder's CLI is closed source; this file encodes only what its ACP
 * server emitted.
 *
 *   - **Authentication is a refusal, not a step.** After `qoderclicn login`,
 *     `session/new` succeeds without `authenticate`. Before login it fails with
 *     `-32000 Authentication required`, and only then is `authenticate` needed.
 *     The agent advertises one method, `qoderclicn-login` on the CN build (the
 *     international build names its own), so the id is derived from
 *     `initialize.authMethods` instead of hard-coded.
 *   - **The tool name is in `_meta.qoder.toolName`** ("Bash", "Read", "Write",
 *     "Edit", "Grep", "Glob"), never in `title` — that is a human activity line
 *     ("Edit probe.txt") and changes between frames. The permission request
 *     repeats the name in the same `_meta` slot, not in `toolCall.name`.
 *   - **Output is only ever `rawOutput` or terminal data.** Completed frames
 *     carry `rawOutput` as a string; a Bash call's intermediate frame carries
 *     `_meta.terminal_output.data` and no status. The opening frame's `content`
 *     is the tool's INPUT echo (Read/Glob/Grep) or a preview diff (Write/Edit),
 *     so reading it as output would print the request back as the result.
 *   - **Tool frames are `two_frame`**: `tool_call` pending → optional terminal
 *     output update (no status) → `tool_call_update` completed.
 *   - **Usage is all zeros** in v1.1.6 (`inputTokens`, `outputTokens`,
 *     `totalTokens`). A zero is not a measurement here, so the dialect reports
 *     nothing instead of feeding DSH fabricated counts.
 *   - **Cancels are honored** (measured: `sleep 90` cancelled 3.7 s after the
 *     first tool frame, reply `stopReason: "cancelled"`), and image prompts are
 *     advertised (`promptCapabilities.image: true`).
 *
 * `initialized` is answered with -32601 by this build; the client sends it as a
 * notification, so the rejection is logged by the agent and changes nothing.
 */

import { randomUUID } from 'node:crypto'
import type { AcpDialect, ToolCall } from './types.ts'
import { replyUsageOf } from './usage.ts'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** The tool identity Qoder puts on both updates and permission requests. */
function toolNameOf(value: Record<string, unknown>): string | undefined {
  const qoder = record(record(value['_meta'])['qoder'])
  return typeof qoder['toolName'] === 'string' ? qoder['toolName'] : undefined
}

const CHATTER = new Set([
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
])

export const qoderDialect: AcpDialect = {
  id: 'qoder',

  // CN and international builds name their login method differently; the
  // agent's own list is the only stable source. Fall back to the first offered.
  authenticateMethodIdFrom(initializeResult) {
    const methods = record(initializeResult)['authMethods']
    if (!Array.isArray(methods)) return undefined
    const ids = methods
      .map(record)
      .map(method => method['id'])
      .filter((id): id is string => typeof id === 'string')
    return ids.find(id => /login/i.test(id)) ?? ids[0]
  },

  // Logged-in sessions need no authenticate round-trip, and calling it anyway
  // intermittently stalls (see types.ts). Ask only when session/new refuses.
  authenticateOnDemand: true,

  sessionNeedsAuthenticate(error) {
    const message = error instanceof Error ? error.message : String(error)
    // The wire error is `acp error: {"code":-32000,"message":"Authentication
    // required: Authentication is required."}`.
    return /authentication required/i.test(message)
  },

  // Permission requests reuse the update vocabulary for `toolCall`; the name is
  // in `_meta.qoder.toolName`, not `toolCall.name`.
  readPermissionToolName(toolCall) {
    return toolNameOf(toolCall)
  },

  capabilities: {
    cancelsTurns: true,
    acceptsImageContent: true,
    // Opening frame, optional terminal-output frame with no status, completed.
    toolFrameShape: 'two_frame',
    commandVia: 'tool_frame',
    // initialize advertised `loadSession: true` with the full
    // sessionCapabilities set (list/resume/fork/close/delete) — captured
    // 2026-10-20. `session/resume` reattaches that server-side conversation,
    // so a host restart need not rebuild context from a text replay.
    supportsSessionResume: true,
    // Measured on 2026-10-20. Values are DSH's own tool names (verified against
    // the reference client's classifyTool table / keyed toolview registry on
    // 2026-10-13); Qoder names not seen live stay unmapped and degrade to the
    // generic card instead of risking a wrong dedicated one.
    toolNameMap: {
      Bash: 'bash',
      Read: 'read',
      Edit: 'edit',
      Write: 'write',
      Grep: 'grep',
      Glob: 'glob',
    },
  },

  foldTool(carried, update) {
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
    // Latch the identity: the opening frame names the tool, later frames may
    // omit `_meta` and only carry status/output.
    const name = carried?.name || toolNameOf(update) || (typeof update['title'] === 'string' ? update['title'] : 'tool')
    const { output, outputStreaming } = outputFrom(update, carried)
    return {
      callId: toolCallId,
      name,
      arguments: update['rawInput'] ?? carried?.arguments ?? {},
      title: typeof update['title'] === 'string' ? update['title'] : carried?.title,
      status: typeof update['status'] === 'string' ? update['status'] : carried?.status,
      output,
      outputStreaming,
    } satisfies ToolCall
  },

  toolOutput(update) {
    return outputFrom(update).output
  },

  // The user's pick rides `session/set_config_option` — the protocol's write
  // path for the model selector Qoder publishes in session/new. Nothing
  // documents a modelId param on session/prompt; an undocumented param on a
  // closed-source server is one silent ignore away from a picker that lies.
  modelVia: 'config_option',

  modelConfigId(reply) {
    const options = record(reply)['configOptions']
    if (!Array.isArray(options)) return undefined
    const entry = options
      .map(record)
      .find(option => option['category'] === 'model' || option['id'] === 'model')
    const id = record(entry)['id']
    return typeof id === 'string' ? id : undefined
  },

  readModels(reply) {
    // The standard carrier first (config option with the model category — the
    // same place claude reads), `models.availableModels` as the fallback for a
    // build that omits the selector. Same 15 models either way, measured.
    const config = record(reply)['configOptions']
    if (Array.isArray(config)) {
      const entry = config
        .map(record)
        .find(option => option['category'] === 'model' || option['id'] === 'model')
      const choices = record(entry)['options']
      if (Array.isArray(choices)) {
        return choices.map(record).flatMap(choice => {
          const id = choice['value']
          if (typeof id !== 'string') return []
          const name = typeof choice['name'] === 'string' ? choice.name : id
          const description = typeof choice['description'] === 'string' ? choice['description'] : undefined
          return [{ id, name, ...(description === undefined ? {} : { description }) }]
        })
      }
    }
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

  readReplyUsage(result) {
    const usage = replyUsageOf(result)
    if (usage === undefined) return undefined
    // v1.1.6 sends a zeroed usage object on every reply. Reporting it would put
    // "0 in / 0 out" on screen for a turn that demonstrably used tokens.
    if (usage.inputTokens === 0 && usage.outputTokens === 0 && (usage.totalTokens ?? 0) === 0) return undefined
    return usage
  },

  isContent(update) {
    return typeof update['sessionUpdate'] === 'string' && !CHATTER.has(update['sessionUpdate'] as string)
  },
}

/**
 * Completed frames put the result in `rawOutput` (a plain string); an
 * intermediate Bash frame puts terminal bytes in `_meta.terminal_output.data`.
 * `content` is deliberately ignored: it holds the tool's input on the opening
 * frame, not its result.
 *
 * Streaming terminal bytes accumulate onto the carried output (each interim
 * frame is the next chunk, not the whole); a whole `rawOutput` result replaces
 * them and ends the accumulation. Returns the resolved output and whether it is
 * still streaming (so the next terminal chunk appends).
 */
function outputFrom(update: Record<string, unknown>, carried?: ToolCall): { output: string; outputStreaming: boolean } {
  const raw = update['rawOutput']
  if (typeof raw === 'string') return { output: raw, outputStreaming: false }
  const terminal = record(record(update['_meta'])['terminal_output'])
  const data = typeof terminal['data'] === 'string' ? terminal['data'] : ''
  if (data !== '') {
    const base = carried?.outputStreaming === true ? (carried?.output ?? '') : ''
    return { output: `${base}${data}`, outputStreaming: true }
  }
  return { output: carried?.output ?? '', outputStreaming: carried?.outputStreaming ?? false }
}
