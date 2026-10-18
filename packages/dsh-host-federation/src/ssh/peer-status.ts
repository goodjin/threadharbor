/**
 * What any peer can learn about another host by reading a file over SSH.
 *
 * The file is written when DSH Web starts on that machine. There is no
 * designated manager: whichever host can SSH in reads the same record.
 */

export type PeerListen = 'loopback' | 'tailscale' | 'host-ip'

export type PeerStatus = {
  /** ThreadHarbor's peer file exists and says the bundle was installed. */
  readonly pluginsInstalled: boolean
  /** `loopback` is an SSH tunnel. `host-ip` is a directly reachable address. `tailscale` is an older direct record. */
  readonly listen?: PeerListen
  readonly port?: number
  readonly bindHost?: string
  readonly launchUrl?: string
}

export function parsePeerStatus(raw: string): PeerStatus {
  const trimmed = raw.trim()
  if (trimmed === '') return { pluginsInstalled: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { pluginsInstalled: false }
  }
  if (typeof parsed !== 'object' || parsed === null) return { pluginsInstalled: false }
  const record = parsed as Record<string, unknown>
  const listen = record['listen'] === 'loopback' || record['listen'] === 'tailscale' || record['listen'] === 'host-ip'
    ? record['listen']
    : undefined
  const port = typeof record['port'] === 'number' && Number.isInteger(record['port']) ? record['port'] : undefined
  const bindHost = typeof record['bindHost'] === 'string' && record['bindHost'] !== '' ? record['bindHost'] : undefined
  const launchUrl = typeof record['launchUrl'] === 'string' && record['launchUrl'] !== '' ? record['launchUrl'] : undefined
  return {
    pluginsInstalled: record['pluginsInstalled'] === true,
    ...(listen === undefined ? {} : { listen }),
    ...(port === undefined ? {} : { port }),
    ...(bindHost === undefined ? {} : { bindHost }),
    ...(launchUrl === undefined ? {} : { launchUrl }),
  }
}
