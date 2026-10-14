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

export async function fetchHostSessions(launchUrl: string, t: RuntimeT = fallbackT): Promise<HostSessionsResult> {
  try {
    const result = await fetchRemoteHostSessions(launchUrl, t)
    if (result.ok) return { sessions: result.value.sessions }
    return { failed: result.error }
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) }
  }
}
