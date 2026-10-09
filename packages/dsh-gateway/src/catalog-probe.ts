/**
 * When a catalog probe may be closed.
 *
 * A probe is a real Agent session held open on the remote purely so its model
 * list can be read (see `RemoteSessionView.probe`). Nothing is ever sent to it,
 * but it does hold the Agent's process — the bridge stays up as long as one
 * session is attached — so a probe the user walked away from is a process kept
 * for nobody.
 *
 * The policy lives here, apart from the gateway's request plumbing, because
 * "half an hour unread" is a judgement about cost rather than about plumbing,
 * and it needs to be checkable without standing up a remote, sockets and all.
 */

/** How long a catalog probe may sit unread before it is closed.
 *
 *  Long enough that reading models across several Agents in one sitting never
 *  restarts anything, and short enough that a menu the user closed does not
 *  hold a remote Agent process for the rest of the day. */
export const CATALOG_PROBE_IDLE_MS = 30 * 60 * 1000

/**
 * Has this probe been unread for long enough to reclaim?
 *
 *  An unparseable timestamp counts as expired. A probe we cannot date is a
 *  probe we cannot prove anyone still wants, and reclaiming it costs the user
 *  one re-open while keeping it costs the remote indefinitely.
 */
export function probeIsExpired(lastUsedAt: string, now: number = Date.now()): boolean {
  const usedAt = Date.parse(lastUsedAt)
  if (!Number.isFinite(usedAt)) return true
  return now - usedAt >= CATALOG_PROBE_IDLE_MS
}