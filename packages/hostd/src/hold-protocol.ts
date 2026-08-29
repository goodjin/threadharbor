/** Private hostd ↔ detached hold-worker protocol. */

import type {
  JsonValue, RemoteAgentBackend, RemoteJournalPage, RemoteNativeAdmission,
} from '@threadharbor/protocol'

/** Immutable worker launch record written with owner-only permissions. */
export interface HoldWorkerConfig {
  readonly version: 1
  readonly holdId: string
  readonly generation: string
  readonly backend: Exclude<RemoteAgentBackend, 'claude'>
  readonly cwd: string
  readonly socketPath: string
  readonly journalPath: string
  readonly statePath: string
  readonly maxJournalEvents: number
  readonly maxJournalBytes: number
  readonly transport:
    | { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[] }
    | { readonly kind: 'websocket'; readonly url: string }
}

/** Mutable worker facts persisted for hostd recovery. */
export interface HoldWorkerState {
  readonly pid: number
  readonly backendPid?: number
  readonly ready: boolean
  readonly generation: string
  readonly latestSeq: number
  readonly droppedThrough: number
  readonly initialized: boolean
  readonly initializeResult?: JsonValue
  readonly nativeSessionId?: string
  readonly updatedAt: string
}

/** One request sent over the private local socket. */
export type HoldRequest =
  | { readonly operation: 'ping' }
  | { readonly operation: 'read'; readonly afterSeq: number; readonly generation?: string }
  | { readonly operation: 'send'; readonly admission: RemoteNativeAdmission }
  | { readonly operation: 'send-frame'; readonly frame: JsonValue }
  | { readonly operation: 'wait'; readonly rpcId: string; readonly afterSeq: number; readonly timeoutMs: number }
  | { readonly operation: 'set-native-session'; readonly nativeSessionId: string }
  | { readonly operation: 'shutdown' }

/** One response returned over the private local socket. */
export type HoldResponse =
  | { readonly ok: true; readonly result: JsonValue | RemoteJournalPage }
  | { readonly ok: false; readonly error: string }
