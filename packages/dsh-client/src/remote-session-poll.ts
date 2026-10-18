/**
 * One remote-host fetch, flattened for the tree.
 *
 * The route and the network both fail in ways a tree row must show verbatim;
 * this keeps the raw text instead of flattening it to a boolean.
 */
import { fetchRemoteHostSessions } from './ssh-deploy.ts'
import type { HostSession } from '@threadharbor/dsh-host-federation'
import type { RuntimeT } from './locales.ts'
import { fallbackT } from './locales.ts'

export type HostSessionsResult =
  | { readonly sessions: readonly HostSession[] }
  | { readonly failed: string }

/**
 * A failed pull must not erase a list we already showed. The note rides along
 * so the row can say why the refresh missed, while the last good sessions stay.
 */
export function settleHostFetch(
  previous: readonly HostSession[] | undefined,
  result: HostSessionsResult,
): { readonly sessions: readonly HostSession[]; readonly note?: string } {
  if ('sessions' in result) return { sessions: result.sessions }
  return { sessions: previous ?? [], ...(result.failed === '' ? {} : { note: result.failed }) }
}

export async function fetchHostSessions(launchUrl: string, t: RuntimeT = fallbackT): Promise<HostSessionsResult> {
  try {
    const result = await fetchRemoteHostSessions(launchUrl, t)
    if (result.ok) return { sessions: result.value.sessions }
    return { failed: result.error }
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
}
