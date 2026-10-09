/**
 * Answering an agent's permission request through the host's approval service.
 *
 * The host has exactly one granting value, `'allowed-once'`; everything else —
 * `rejected`, `cancelled`, `unavailable`, anything unexpected, and anything
 * thrown — means no. That direction is deliberate: a bridge that guessed on an
 * unexpected value could hand a tool permission nobody approved.
 *
 * Facts verified against `reference/deepseek-harness` @ 5badb15009:
 * `interaction/user-approval/src/types.ts:32` (the four outcomes),
 * `index.ts:211` ("the only grant"), `index.ts:285-292` (the host itself
 * normalises an unknown value or a throw into `unavailable`, fail-closed).
 */

import type { PermissionDecision, PermissionRequest } from '@threadharbor/dsh-acp-agent'

/** The one value that means yes. */
export const ALLOWED_ONCE = 'allowed-once'

/** What the host's approval service is asked. */
export type ApprovalPort = (request: {
  agent: unknown
  toolName: string
  callId?: string
  reason?: string
  displayReason?: string
  signal?: AbortSignal
}) => Promise<unknown>

export type ApprovalBridge = (request: PermissionRequest) => Promise<PermissionDecision>

/**
 * Bridge ACP permission requests to the host.
 *
 * `permission` takes a decision and answers it; this only translates.
 */
export function makeApprovalBridge(
  ask: ApprovalPort,
  agent: unknown,
  describe: (request: PermissionRequest) => { toolName: string; callId?: string; reason?: string },
): ApprovalBridge {
  return async request => {
    const { toolName, callId, reason } = describe(request)
    let outcome: unknown
    try {
      outcome = await ask({
        agent,
        toolName,
        ...(callId === undefined ? {} : { callId }),
        ...(reason === undefined ? {} : { reason }),
      })
    } catch {
      // The host throws when there is no open turn to attach the request to.
      // Unanswered is not answered: refuse rather than hang, which is what the
      // agent-side client would do waiting for a reply that never comes.
      return { outcome: 'reject' }
    }
    // Only `allowed-once` means yes. Rejected, cancelled, unavailable, and any
    // value invented later all mean no — a bridge that guessed the other way
    // would hand out permission nobody granted.
    return outcome === ALLOWED_ONCE ? { outcome: 'allow' } : { outcome: 'reject' }
  }
}
