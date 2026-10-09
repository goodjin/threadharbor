/**
 * Asking another host to take over a conversation.
 *
 * With one tab per host there is no connection from the roll-up to the machine
 * that holds a session — only the channel between tabs. So a cross-host switch
 * is a request to the owning tab: it runs the handover locally, where the
 * session actually lives, and reports what came of it.
 *
 * The reply carries refusals as refusals. A request that came back empty would
 * leave the roll-up showing a switch that never happened.
 */

import type { FederationBus, HostFederation } from './federation.ts'

export type HandoverRequest = {
  readonly kind: 'handover-request'
  /** Who asked, so the answer goes back to them. */
  readonly fromHostId: string
  readonly toHostId: string
  readonly sessionId: string
  readonly toPresetId: string
}

export type HandoverResult =
  | { readonly kind: 'switched'; readonly sessionId: string }
  | { readonly kind: 'too-long'; readonly shortBy?: number }
  | { readonly kind: 'locked' }
  | { readonly kind: 'unknown-session' }
  | { readonly kind: 'failed'; readonly message: string }

export type HandoverReply = {
  readonly kind: 'handover-reply'
  readonly toHostId: string
  readonly sessionId: string
  readonly result: HandoverResult
}

/**
 * Ask the host that holds a session to move it.
 *
 * A request to this tab's own host is not sent: this tab can do it locally, and
 * going through the channel would take a slower path to the same place while
 * hiding local refusals.
 */
export function requestHandover(
  bus: FederationBus,
  request: { fromHostId: string; sessionId: string; toHostId: string; toPresetId: string },
): { kind: 'ignored' } | { kind: 'sent' } {
  if (request.toHostId === '' || request.toPresetId === '') return { kind: 'ignored' }
  if (request.toHostId === request.fromHostId) return { kind: 'ignored' }
  const message: HandoverRequest = { kind: 'handover-request', ...request }
  bus.post(message)
  return { kind: 'sent' }
}

/**
 * Answer handover requests addressed to this host.
 *
 * `run` performs the switch locally and returns the session the conversation
 * ended up on. Whatever it throws is reported rather than swallowed: a refusal
 * that came back empty would leave the roll-up showing a switch that did not
 * happen.
 */
export function installHandoverResponder(
  federation: HostFederation,
  bus: FederationBus,
  run: (request: HandoverRequest) => Promise<{ sessionId: string }>,
): void {
  const hostId = federation.hosts().find(host => host.self)?.hostId
  if (hostId === undefined) return

  const original = federation.receive.bind(federation)
  federation.receive = (message: unknown) => {
    original(message)
    const request = parseRequest(message)
    // Every tab hears every message. Acting on one addressed elsewhere would
    // have two hosts claiming the same conversation.
    if (request === undefined || request.toHostId !== hostId) return
    if (federation.rollUp().hosts.some(h => h.hostId === hostId && h.sessions.some(s => s.sessionId === request.sessionId)) !== true) {
      // This host does not hold the session: it was closed, or the id is wrong.
      bus.post(reply(request, { kind: 'unknown-session' }))
      return
    }
    void run(request).then(
      result => { bus.post(reply(request, { kind: 'switched', sessionId: result.sessionId })) },
      (error: unknown) => { bus.post(reply(request, failureOf(error))) },
    )
  }
}

function reply(request: HandoverRequest, result: HandoverResult): HandoverReply {
  return { kind: 'handover-reply', toHostId: request.fromHostId, sessionId: request.sessionId, result }
}

/**
 * Read a thrown failure as a result.
 *
 * A refusal carries its own kind so the roll-up can say *why* the switch did
 * not happen; anything else is reported with its message rather than as a
 * generic failure.
 */
function failureOf(error: unknown): HandoverResult {
  const kind = (error as { kind?: unknown } | undefined)?.kind
  if (kind === 'too-long') {
    const shortBy = (error as { shortBy?: unknown }).shortBy
    return typeof shortBy === 'number' ? { kind: 'too-long', shortBy } : { kind: 'too-long' }
  }
  if (kind === 'locked') return { kind: 'locked' }
  return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
}

function parseRequest(message: unknown): HandoverRequest | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as Record<string, unknown>
  if (record['kind'] !== 'handover-request') return undefined
  const fromHostId = record['fromHostId']
  const toHostId = record['toHostId']
  const sessionId = record['sessionId']
  const toPresetId = record['toPresetId']
  if (typeof fromHostId !== 'string' || fromHostId === '') return undefined
  if (typeof toHostId !== 'string' || toHostId === '') return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof toPresetId !== 'string' || toPresetId === '') return undefined
  return { kind: 'handover-request', fromHostId, toHostId, sessionId, toPresetId }
}