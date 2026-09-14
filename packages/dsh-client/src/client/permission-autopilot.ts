import type { RemoteSessionId, RemoteSessionView, RemoteTranscriptEntry } from '@threadharbor/protocol'
import {
  autoApproveOptionId, configuredModeAutoApproves, isAutoApprovablePermission, parseChoicePrompt,
  pendingPermissionEntry, permissionRequestId, shouldAutoApprovePermissions,
} from './conversation-model.ts'

/** The two composer preferences that decide whether a session answers
 *  permission grants on its own; everything else in SessionPreferences is
 *  irrelevant here. */
export interface AutoApprovePreferences {
  readonly approvalChoice?: string
  readonly permissionMode?: string
}

/** Resolves the browser-local preferences for one session. Injected by the
 *  conversation surface, which owns localStorage + in-memory preference state;
 *  the store never reads preferences directly. */
export type AutoApprovePreferenceResolver = (
  session: RemoteSessionView,
  hostId: string | undefined,
) => AutoApprovePreferences | undefined

export interface AutoApproval {
  readonly sessionId: RemoteSessionId
  readonly requestId: string
  readonly optionId?: string
  /** Dedupe key — one answer per (session, request), shared with manual clicks. */
  readonly key: string
}

export interface AutoApprovalScan {
  /** Permission requests that should be answered right now. */
  readonly answers: readonly AutoApproval[]
  /** Auto-approving sessions that are waiting but whose local transcript is
   *  behind the gateway, so the pending card is not yet known here. */
  readonly needsTranscript: readonly RemoteSessionId[]
}

export function permissionActionKey(sessionId: string, requestId: string): string {
  return `permission:${sessionId}:${requestId}`
}

/** Whether this session answers permission grants without a click: either the
 *  browser preference says so, or the backend itself runs in a bypass mode. */
export function sessionAutoApproves(
  session: RemoteSessionView,
  preferences: AutoApprovePreferences | undefined,
): boolean {
  return shouldAutoApprovePermissions(preferences?.approvalChoice, preferences?.permissionMode)
    || configuredModeAutoApproves(session.configOptions)
}

/** Find every session — current or background — that is blocked on a permission
 *  grant it is configured to answer automatically. Runs over the whole catalog
 *  so a session the user is not looking at never waits for a click.
 *  @param sessions - catalog rows (all sessions, any turn state).
 *  @param transcript - in-memory transcript across sessions.
 *  @param resolve - preference lookup; `undefined` limits the decision to backend-advertised modes.
 */
export function scanAutoApprovals(
  sessions: readonly RemoteSessionView[],
  transcript: readonly RemoteTranscriptEntry[],
  resolve: (session: RemoteSessionView) => AutoApprovePreferences | undefined,
): AutoApprovalScan {
  const answers: AutoApproval[] = []
  const needsTranscript: RemoteSessionId[] = []
  for (const session of sessions) {
    if (session.turnState !== 'waiting-permission') continue
    if (!sessionAutoApproves(session, resolve(session))) continue
    const entries = transcript.filter(entry => entry.sessionId === session.sessionId)
    const localLast = entries.reduce((max, entry) => Math.max(max, entry.seq), -1)
    // Never answer from a stale transcript: the last permission card we hold
    // could be an earlier, already-answered request. Wait until the local
    // rows reach the seq the gateway reported with this waiting state.
    if (session.latestTranscriptSeq !== undefined && localLast < session.latestTranscriptSeq) {
      needsTranscript.push(session.sessionId)
      continue
    }
    const pending = pendingPermissionEntry(entries)
    if (pending === undefined) {
      needsTranscript.push(session.sessionId)
      continue
    }
    const requestId = permissionRequestId(pending)
    if (requestId === undefined || !isAutoApprovablePermission(pending)) continue
    const preferences = resolve(session)
    const optionId = autoApproveOptionId(parseChoicePrompt(pending), {
      ...(preferences?.approvalChoice === undefined ? {} : { approvalChoice: preferences.approvalChoice }),
      ...(preferences?.permissionMode === undefined ? {} : { permissionMode: preferences.permissionMode }),
    })
    answers.push({
      sessionId: session.sessionId,
      requestId,
      ...(optionId === undefined ? {} : { optionId }),
      key: permissionActionKey(session.sessionId, requestId),
    })
  }
  return { answers, needsTranscript }
}
