/**
 * The roll-up, as something a view can draw.
 *
 * Kept apart from any rendering framework on purpose: the grouping and ordering
 * rules are where the mistakes live, and they are worth testing without a
 * browser in the loop. What comes out is a plain tree — hosts, then projects,
 * then sessions — which any host can hand to whatever it draws with.
 *
 * §8.3's display rule lives here: a project belongs to exactly one host, and
 * the same project name on two hosts is two projects. A base name shared by
 * more than one host is therefore qualified with the host's own name wherever
 * it appears, so the two never read as one.
 */

import type { RollUp } from './federation.ts'

export type SessionView = {
  readonly sessionId: string
  readonly projectId: string
  readonly title: string
  /** Which machine holds it — a click has to say where it is going. */
  readonly hostId: string
  /** Whether this tab is the one holding it. */
  readonly own: boolean
  /** Pinned sessions lead their project, the way the native list seats them. */
  readonly pinned?: boolean
  /** Archived rows render only under the tree's show-archived filters. */
  readonly archived?: boolean
  /** Last activity stamp; orders the tree's 最近更新 sort. */
  readonly updatedAt?: number
}

export type ProjectView = {
  readonly projectId: string
  /**
   * The name as it should be shown: the project's own title, suffixed with the
   * holding host's name when that same title exists on another host too.
   */
  readonly label: string
  /** The project title without the host qualifier, for callers that group by it. */
  readonly baseLabel: string
  /** True when `label` carries the host qualifier because the name is shared. */
  readonly sharedName: boolean
  readonly sessions: readonly SessionView[]
}

export type HostViewRow = {
  readonly hostId: string
  readonly label: string
  readonly self: boolean
  readonly lastSeen: number
  readonly projects: readonly ProjectView[]
  /** How many sessions this host holds in total, for the one-line host summary. */
  readonly sessionCount: number
  /** Nothing published yet, or nothing open. */
  readonly empty: boolean
  /** Registered but never deployed: no launch URL to fetch from. */
  readonly undeployed?: boolean
  /** Why a fetch produced nothing, verbatim, when the host has a launch URL. */
  readonly note?: string
}

export type RollUpView = {
  readonly hosts: readonly HostViewRow[]
  readonly totalSessions: number
  readonly empty: boolean
}

/**
 * Turn a roll-up into a drawable tree.
 *
 * This tab's own machine comes first: it is the one you are most likely to
 * want. Everything else is alphabetical, so the order does not shuffle as other
 * machines come and go. Session order inside a project is left exactly as
 * published — reordering a conversation list under the cursor is worse than no
 * order at all.
 */
export function rollUpView(rollUp: RollUp): RollUpView {
  const hosts = [...rollUp.hosts]
    .sort((a, b) => Number(b.self) - Number(a.self) || a.hostId.localeCompare(b.hostId))
    .map(toHostView)
  return {
    hosts: qualifySharedNames(hosts),
    totalSessions: hosts.reduce((sum, host) => sum + host.sessionCount, 0),
    empty: hosts.length === 0,
  }
}

function toHostView(host: RollUp['hosts'][number]): HostViewRow {
  const projects = host.projects.map(project => {
    const label = project.projectTitle === undefined || project.projectTitle === '' ? project.projectId : project.projectTitle
    return {
      projectId: project.projectId,
      label,
      baseLabel: label,
      sharedName: false,
      // Pinned rows lead; the rest keep their published order untouched.
      sessions: [...project.sessions].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map(entry => ({
        sessionId: entry.sessionId,
        projectId: entry.projectId,
        title: entry.title,
        hostId: host.hostId,
        own: host.self,
        ...(entry.pinned === true ? { pinned: true } : {}),
        ...(entry.archived === true ? { archived: true } : {}),
        ...(typeof entry.updatedAt === 'number' ? { updatedAt: entry.updatedAt } : {}),
      })),
    }
  })
  return {
    hostId: host.hostId,
    // An operator who never set a title still needs something to click.
    label: host.hostTitle === '' ? host.hostId : host.hostTitle,
    self: host.self,
    lastSeen: host.lastSeen,
    projects,
    sessionCount: projects.reduce((sum, project) => sum + project.sessions.length, 0),
    empty: projects.every(project => project.sessions.length === 0),
    ...(host.undeployed === undefined ? {} : { undeployed: host.undeployed }),
    ...(host.note === undefined ? {} : { note: host.note }),
  }
}

/**
 * Mark every project whose base name another host also uses.
 *
 * The qualifier is the host's own label, so the tree reads 「Web · Bench」 and
 * 「Web · Studio」 — same project name, visibly two projects on two machines.
 */
function qualifySharedNames(hosts: readonly HostViewRow[]): readonly HostViewRow[] {
  const uses = new Map<string, number>()
  for (const host of hosts) {
    for (const project of host.projects) {
      uses.set(project.baseLabel, (uses.get(project.baseLabel) ?? 0) + 1)
    }
  }
  return hosts.map(host => ({
    ...host,
    projects: host.projects.map(project => {
      if ((uses.get(project.baseLabel) ?? 0) <= 1) return project
      return { ...project, label: `${project.baseLabel} · ${host.label}`, sharedName: true }
    }),
  }))
}
