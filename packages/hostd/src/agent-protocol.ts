/** Types shared between the in-process agent bridge and hostd.
 *
 * A "hold" is one remote session's slot inside a shared bridge. The name is
 * historical: it used to mean a detached worker process, and it is kept so the
 * on-disk layout (`holds/<holdId>/`), the session records and the recovery path
 * all continue to work unchanged.
 */

import type {
  JsonValue, RemoteAgentBackend, RemoteJournalPage, RemoteNativeAdmission,
} from '@threadharbor/protocol'

/** One session's durable configuration, created when a session opens. */
export interface AgentSessionConfig {
  readonly holdId: string
  readonly generation: string
  readonly backend: RemoteAgentBackend
  readonly cwd: string
  readonly journalPath: string
  readonly statePath: string
  readonly maxJournalEvents: number
  readonly maxJournalBytes: number
  readonly promptTimeoutMs: number
}

/** Mutable per-session facts persisted to `state.json` for hostd recovery. */
export interface AgentSessionState {
  readonly pid: number
  readonly backendPid?: number
  readonly ready: boolean
  readonly generation: string
  readonly latestSeq: number
  readonly droppedThrough: number
  readonly initialized: boolean
  readonly nativeSessionId?: string
  readonly updatedAt: string
}

/** How the bridge reaches one Agent backend. */
export type AgentTransport =
  | {
    readonly kind: 'stdio'
    readonly command: string
    readonly args: readonly string[]
    /** Extra environment for this Agent, on top of hostd's own.
     *  The ACP profile normally owns models and credentials through the host
     *  user's own `$DSH_HOME`; this is only for an explicit override. */
    readonly env?: Readonly<Record<string, string>>
  }
  | { readonly kind: 'websocket'; readonly url: string; readonly secret?: string }

/** Outcome of admitting one prompt. `duplicate` means this client request was
 *  already admitted for this session, so the prompt is not sent twice. */
export interface AgentSendResult {
  readonly accepted: boolean
  readonly duplicate: boolean
}

/** Result of waiting for one backend response. */
export type AgentWaitResult =
  | { readonly kind: 'frame'; readonly frame: JsonValue }
  | { readonly kind: 'timeout' }

/** Result of waiting for a session's journal to advance. */
export interface AgentSeqResult {
  readonly latestSeq: number
  readonly timedOut: boolean
}

/** One session-scoped request, kept in the shape the old control protocol used
 *  so the WS hub and every internal caller keep working. Only the transport
 *  changed — a direct call into the shared connection instead of a socket. */
export type HostdSessionRequest =
  | { readonly operation: 'ping' }
  | { readonly operation: 'read'; readonly afterSeq: number; readonly generation?: string }
  | { readonly operation: 'send'; readonly admission: RemoteNativeAdmission }
  | { readonly operation: 'send-frame'; readonly frame: JsonValue }
  | {
    readonly operation: 'wait'
    readonly rpcId: string
    readonly afterSeq: number
    readonly timeoutMs: number
  }
  | { readonly operation: 'wait-seq'; readonly afterSeq: number; readonly timeoutMs: number }
  | {
    readonly operation: 'wait-page'
    readonly afterSeq: number
    readonly timeoutMs: number
    readonly generation?: string
  }
  | { readonly operation: 'set-native-session'; readonly nativeSessionId: string }

/** One session-scoped response. */
export type HostdSessionResponse =
  | { readonly ok: true; result: JsonValue | RemoteJournalPage }
  | { readonly ok: false; error: string }
