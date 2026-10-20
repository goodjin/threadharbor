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
 */
function outputFrom(update: Record<string, unknown>): string {
  const raw = update['rawOutput']
  if (typeof raw === 'string') return raw
  const terminal = record(record(update['_meta'])['terminal_output'])
  return typeof terminal['data'] === 'string' ? terminal['data'] : ''
}
