import type { HostRegistration, HostSession, RollUp } from '@threadharbor/dsh-host-federation'
import { rollUpView } from '@threadharbor/dsh-host-federation/rollup-view'
import type { RollUpView } from '@threadharbor/dsh-host-federation/rollup-view'

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
export function rollUpViewWithRegistry(
  rollUp: RollUp,
  registrations: readonly HostRegistration[],
  remoteSessions: ReadonlyMap<string, readonly HostSession[]>,
): RollUpView {
  const hosts = [...rollUp.hosts]
  const known = new Set(hosts.map(host => host.hostId))
  for (const registration of registrations) {
    const remote = remoteSessions.get(registration.hostId) ?? []
    const existing = hosts.find(host => host.hostId === registration.hostId)
    if (existing !== undefined) {
      if (remote.length > 0 && existing.sessions.length === 0) {
        const index = hosts.indexOf(existing)
        hosts[index] = {
          ...existing,
          sessions: remote,
          projects: groupByProject(remote),
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
      sessions: remote,
      projects: groupByProject(remote),
    })
    known.add(registration.hostId)
  }
  return rollUpView({ hosts })
}
