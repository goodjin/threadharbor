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
import type { AcpClient, PermissionDecision, PermissionRequest } from './client.ts';
/** The slice of DSH's `ApprovalService` this bridge needs. */
export type ApprovalRequester = (request: {
    readonly toolName: string;
    readonly callId?: string | undefined;
    readonly reason?: string | undefined;
}) => Promise<string>;
/** DSH's closed outcome vocabulary, as observed on `ApprovalOutcome`. */
export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | (string & {});
/** Fold DSH's outcome vocabulary onto ACP's allow/refuse choice. */
export declare function toDecision(outcome: string): PermissionDecision;
/**
 * Route one permission request through an approval requester.
 *
 * Never rejects: an approval request the agent is blocking on must always be
 * answered one way or the other.
 */
export declare function bridgePermissions(request: PermissionRequest, askApproval: ApprovalRequester): Promise<PermissionDecision>;
/** Wire a client's permission requests to an approval requester. */
export declare function connectPermissions(client: Pick<AcpClient, 'onPermissionRequest'>, askApproval: ApprovalRequester): void;
//# sourceMappingURL=approval.d.ts.map