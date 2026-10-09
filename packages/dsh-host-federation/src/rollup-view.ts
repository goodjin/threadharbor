/**
 * The roll-up, as something a view can draw.
 *
 * Kept apart from any rendering framework on purpose: the grouping and ordering
 * rules are where the mistakes live, and they are worth testing without a
 * browser in the loop. What comes out is a plain tree — hosts, then projects,
 * then sessions — which any host can hand to whatever it draws with.
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
}

export type ProjectView = {
  readonly projectId: string
  readonly label: string
  readonly sessions: readonly SessionView[]
}

export type HostViewRow = {
  readonly hostId: string
  readonly label: string
  readonly self: boolean
  readonly lastSeen: number
  readonly projects: readonly ProjectView[]
  /** Nothing published yet, or nothing open. */
  readonly empty: boolean
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
    hosts,
    totalSessions: hosts.reduce((sum, host) => sum + host.projects.reduce((n, p) => n + p.sessions.length, 0), 0),
    empty: hosts.length === 0,
  }
}

function toHostView(host: RollUp['hosts'][number]): HostViewRow {
  const projects = host.projects.map(project => ({
    projectId: project.projectId,
    label: project.projectTitle === undefined || project.projectTitle === '' ? project.projectId : project.projectTitle,
    sessions: project.sessions.map(entry => ({
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      title: entry.title,
      hostId: host.hostId,
      own: host.self,
    })),
  }))
  return {
    hostId: host.hostId,
    // An operator who never set a title still needs something to click.
    label: host.hostTitle === '' ? host.hostId : host.hostTitle,
    self: host.self,
    lastSeen: host.lastSeen,
    projects,
    empty: projects.every(project => project.sessions.length === 0),
  }
}
