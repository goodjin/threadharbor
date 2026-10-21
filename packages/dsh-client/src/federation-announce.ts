/**
 * The browser's half of host federation: tell this machine who it is.
 *
 * The host-side entry (`threadharbor-federation-sync`) knows the web server and
 * mints launch tokens, but the host's display name and id live in the browser
 * identity settings — so the browser posts them to FEDERATION_ANNOUNCE_PATH on
 * mount, on identity changes, and on a slow interval. The interval is not
 * redundant: a host restart mints new process tokens, and only a fresh announce
 * updates the self record peers copy. The host answers nothing the browser
 * needs; failure is a log line and a retry next interval, never a broken page.
 *
 * The request carries no token: same-origin cookies are the admission, exactly
 * like the panel's other host calls. And no launch URL ever enters this module —
 * the host mints it from the request's own origin, so a compromised page cannot
 * register a hostile address.
 */

import { FEDERATION_ANNOUNCE_PATH } from '@threadharbor/dsh-host-federation'

export type AnnounceIdentity = {
  readonly hostId: string
  readonly hostTitle: string
}

/** What one announce attempt needs; the real fetch satisfies this. */
export type AnnounceFetch = (
  path: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ readonly status: number; readonly ok: boolean }>

export type FederationAnnouncer = {
  /** Send one announce now; overlapping calls collapse into the one in flight. */
  announce(): void
  dispose(): void
}

export type FederationAnnounceParams = {
  identity: () => AnnounceIdentity
  /** Fires on identity saves and settings hydration; the announce follows. */
  subscribe?: (listener: () => void) => () => void
  fetchLike?: AnnounceFetch
  intervalMs?: number
  log?: (message: string) => void
}

/** Five minutes: a token refresh cadence, not a liveness heartbeat. */
export const ANNOUNCE_INTERVAL_MS = 5 * 60 * 1000

const defaultFetch: AnnounceFetch = (path, init) => fetch(path, init)

/**
 * Start announcing. `announce()` runs immediately: a page that only starts its
 * timer would leave the host unannounced for the first interval, which is
 * exactly when a freshly deployed host needs to be introduced.
 */
export function startFederationAnnounce(params: FederationAnnounceParams): FederationAnnouncer {
  const send = params.fetchLike ?? defaultFetch
  const log = params.log ?? (() => {})
  let disposed = false
  let inFlight = false
  let lastFailure: string | undefined

  const announce = (): void => {
    if (disposed || inFlight) return
    let identity: AnnounceIdentity
    try {
      identity = params.identity()
    } catch (error: unknown) {
      reportFailure(`identity unreadable: ${messageOf(error)}`)
      return
    }
    if (identity.hostId.trim() === '') return
    inFlight = true
    void send(FEDERATION_ANNOUNCE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: identity.hostId, hostTitle: identity.hostTitle }),
    }).then(
      reply => {
        if (disposed) return
        if (!reply.ok) {
          reportFailure(`HTTP ${reply.status}`)
          return
        }
        // Say it once when a failing host recovers; silence on the steady path.
        if (lastFailure !== undefined) {
          lastFailure = undefined
          log('federation announce recovered')
        }
      },
      (error: unknown) => {
        if (!disposed) reportFailure(messageOf(error))
      },
    ).finally(() => {
      inFlight = false
    })
  }

  // Same reason as the in-flight guard: one log line per distinct failure, not
  // one every five minutes for a host that simply lacks the entry.
  function reportFailure(message: string): void {
    if (message === lastFailure) return
    lastFailure = message
    log(`federation announce failed: ${message}`)
  }

  const timer = setInterval(announce, params.intervalMs ?? ANNOUNCE_INTERVAL_MS)
  const unsubscribe = params.subscribe?.(announce)
  announce()

  return {
    announce,
    dispose: () => {
      disposed = true
      clearInterval(timer)
      unsubscribe?.()
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
