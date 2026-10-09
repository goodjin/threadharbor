/** Wire-level types shared by every ACP agent. */

import type { AcpDialect } from './dialects/types.ts'

/** One JSON-RPC frame in either direction. */
export type AcpFrame = {
  readonly jsonrpc?: string
  readonly id?: number | string
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

/** One model an agent offers, as read off its `session/new` reply. */
export type AcpModel = {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** What an agent told us about itself at `session/new`. */
export type AcpSession = {
  readonly sessionId: string
  readonly models: readonly AcpModel[]
  /** The agent's permission mode, when it reports one (claude does, codex does not). */
  readonly modeId?: string | undefined
}

export type { AcpDialect }