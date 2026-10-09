/**
 * Bridging ACP permission requests onto DSH's own approval service.
 *
 * Two measured facts shape this:
 *
 *   - DSH's `ApprovalService.request()` **throws when there is no open turn**
 *     (`packages/interaction/user-approval/src/index.ts:217-223`). So the bridge
 *     cannot be called from outside the turn it is approving — the caller has to
 *     be inside one.
 *   - Its outcome is a closed set — `allowed-once` / `rejected` / `cancelled` /
 *     `unavailable` — where `unavailable` is the fail-closed value covering
 *     "no answerer installed" and "the answerer itself threw".
 *
 * Anything other than an explicit allow is treated as a refusal here, including
 * an exception from the approval service. The alternative — letting an error
 * escape and leaving the request unanswered — reproduces the failure this whole
 * layer exists to prevent: an agent waiting forever for an answer that never
 * arrives.
 */

import type { AcpClient, PermissionDecision, PermissionRequest } from './client.ts'

/** The slice of DSH's `ApprovalService` this bridge needs. */
export type ApprovalRequester = (request: {
  readonly toolName: string
  readonly callId?: string | undefined
  readonly reason?: string | undefined
}) => Promise<string>

/** DSH's closed outcome vocabulary, as observed on `ApprovalOutcome`. */
export type DshApprovalOutcome =
  | 'allowed-once'
  | 'rejected'
  | 'cancelled'
  | 'unavailable'
  | (string & {})

const ALLOWED: DshApprovalOutcome = 'allowed-once'

/** Fold DSH's outcome vocabulary onto ACP's allow/refuse choice. */
export function toDecision(outcome: string): PermissionDecision {
  return outcome === ALLOWED ? { outcome: 'allow' } : { outcome: 'reject' }
}

/**
 * Route one permission request through an approval requester.
 *
 * Never rejects: an approval request the agent is blocking on must always be
 * answered one way or the other.
 */
export function bridgePermissions(
  request: PermissionRequest,
  askApproval: ApprovalRequester,
): Promise<PermissionDecision> {
  // An unnamed tool still has to reach the user as something, not as nothing.
  const toolName = request.toolName ?? request.title ?? 'tool'
  const callId = typeof request.requestId === 'string' ? request.requestId : undefined
  return askApproval({
    toolName,
    ...(callId === undefined ? {} : { callId }),
    ...(request.title === undefined ? {} : { reason: request.title }),
  })
    .then(toDecision)
    .catch((): PermissionDecision => {
      // Fail closed: a broken approval path must release the turn, not strand it.
      return { outcome: 'reject' }
    })
}

/** Wire a client's permission requests to an approval requester. */
export function connectPermissions(
  client: Pick<AcpClient, 'onPermissionRequest'>,
  askApproval: ApprovalRequester,
): void {
  client.onPermissionRequest = request => bridgePermissions(request, askApproval)
}
