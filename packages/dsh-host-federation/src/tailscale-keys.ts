/**
 * The Tailscale bridge's wire contract, shared by the host-side writer and the
 * browser-side reader.
 *
 * In its own module for the same reason {@link ./host-store-id.ts} is: the
 * browser bundle imports the package root, and the behavioral entry this
 * contract belongs to runs `node:child_process` — importing that into a
 * browser would break the build, so only these plain strings and types are
 * re-exported from the root.
 */

/** Host store data key: JSON `TailscalePeer[]`, this machine's tailnet as last seen. */
export const TAILSCALE_PEERS_KEY = 'dsh.tailscale.peers'

/** Host store data key: the panel writes a demand timestamp here to ask for a re-run. */
export const TAILSCALE_REFRESH_KEY = 'dsh.tailscale.refresh'

/**
 * Host store data key: the refresh demand this bridge last served. The panel
 * polls it to tell 「已重跑」 from 「没人应答」 — without it a re-run whose
 * peer list happens to be identical to the old one would be indistinguishable
 * from a bridge that never ran.
 */
export const TAILSCALE_REFRESHED_KEY = 'dsh.tailscale.refreshed'

/** Host store data key: why the last status run produced an empty list; absent on success. */
export const TAILSCALE_ERROR_KEY = 'dsh.tailscale.error'

/** One tailnet machine, as the picker lists it. */
export type TailscalePeer = {
  /** MagicDNS name without the trailing dot; falls back to HostName, then to the IP. */
  readonly name: string
  /** The first 100.x carrier address. */
  readonly ip: string
  readonly online: boolean
}
