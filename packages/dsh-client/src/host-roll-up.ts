import type { HostRegistration, HostSession, RollUp } from '@threadharbor/dsh-host-federation'
import { rollUpView } from '@threadharbor/dsh-host-federation'
import type { RollUpView } from '@threadharbor/dsh-host-federation'

function groupByProject(sessions: readonly HostSession[]): RollUp['hosts'][number]['projects'] {
  const byProject = new Map<string, { projectTitle?: string; sessions: HostSession[] }>()
  for (const session of sessions) {
    const bucket = byProject.get(session.projectId) ?? { sessions: [] }
    if (session.projectTitle !== undefined && session.projectTitle !== '') {
      bucket.projectTitle = session.projectTitle
    }
    bucket.sessions.push(session)
    byProject.set(session.projectId, bucket)
  }
  return [...byProject.entries()].map(([projectId, group]) => ({
    projectId,
    ...(group.projectTitle === undefined ? {} : { projectTitle: group.projectTitle }),
    sessions: group.sessions,
  }))
}

/**
 * Merge registry-only hosts and server-fetched remote sessions into a roll-up view.
 */
type RemoteEntry = { readonly sessions: readonly HostSession[]; readonly note?: string }

/**
 * Merge registry-only hosts and server-fetched remote sessions into a roll-up view.
 * The remote map may carry a `note` (a failed fetch's raw reason); it rides the row.
 */
export function rollUpViewWithRegistry(
  rollUp: RollUp,
  registrations: readonly HostRegistration[],
  remoteSessions: ReadonlyMap<string, readonly HostSession[] | RemoteEntry>,
): RollUpView {
  const isEntry = (value: readonly HostSession[] | RemoteEntry): value is RemoteEntry =>
    !Array.isArray(value)
  const entryOf = (hostId: string): RemoteEntry => {
    const found: readonly HostSession[] | RemoteEntry | undefined = remoteSessions.get(hostId)
    if (found === undefined) return { sessions: [] }
    if (isEntry(found)) return found
    return { sessions: found }
  }
  const hosts = [...rollUp.hosts]
  const known = new Set(hosts.map(host => host.hostId))
  for (const registration of registrations) {
    const entry = entryOf(registration.hostId)
    const existing = hosts.find(host => host.hostId === registration.hostId)
    if (existing !== undefined) {
      if (entry.sessions.length > 0 && existing.sessions.length === 0) {
        const index = hosts.indexOf(existing)
        hosts[index] = {
          ...existing,
          sessions: entry.sessions,
          projects: groupByProject(entry.sessions),
        }
      }
      continue
    }
    if (known.has(registration.hostId)) continue
    hosts.push({
      hostId: registration.hostId,
      hostTitle: registration.hostTitle,
      lastSeen: 0,
      self: false,
      sessions: entry.sessions,
      projects: groupByProject(entry.sessions),
      ...(registration.launchUrl === undefined ? { undeployed: true } : {}),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    })
    known.add(registration.hostId)
  }
  return rollUpView({ hosts })
}
