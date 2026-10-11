/**
 * The roll-up, as something a view can draw.
 *
 * Kept apart from any rendering framework on purpose: the grouping and ordering
 * rules are where the mistakes live, and they are worth testing without a
 * browser in the loop. What comes out is a plain tree — hosts, then projects,
 * then sessions — which any host can hand to whatever it draws with.
 */

import { describe, expect, it } from 'vitest'
import { rollUpView } from '../src/rollup-view.ts'
import type { RollUp } from '../src/federation.ts'

const host = (hostId: string, extra: Record<string, unknown> = {}) => ({
  hostId,
  hostTitle: hostId.toUpperCase(),
  lastSeen: 0,
  self: false,
  projects: [],
  sessions: [],
  ...extra,
})

const rollUp = (hosts: readonly unknown[]): RollUp => ({ hosts }) as RollUp

const session = (sessionId: string, projectId = 'p1', title = sessionId) => ({ projectId, sessionId, title })

describe('rollUpView', () => {
  it('puts this host first, then the others by name', () => {
    // The machine you are on is the one you are most likely to want.
    const view = rollUpView(rollUp([
      host('delta'), host('alpha', { self: true }), host('charlie'),
    ]))
    expect(view.hosts.map(h => h.hostId)).toEqual(['alpha', 'charlie', 'delta'])
  })

  it('marks which host this tab is', () => {
    const view = rollUpView(rollUp([host('alpha', { self: true }), host('beta')]))
    expect(view.hosts.find(h => h.hostId === 'alpha')?.self).toBe(true)
    expect(view.hosts.find(h => h.hostId === 'beta')?.self).toBe(false)
  })

  it('names a host by its title and falls back to its id', () => {
    // An operator who never set a title still needs something to click.
    const view = rollUpView(rollUp([host('alpha', { hostTitle: '' }), host('beta')]))
    expect(view.hosts.map(h => h.label)).toEqual(['alpha', 'BETA'])
  })

  it('groups sessions under the project they belong to', () => {
    const view = rollUpView(rollUp([
      host('alpha', { projects: [{ projectId: 'p1', projectTitle: 'Web', sessions: [session('s1'), session('s2')] }] }),
    ]))
    const project = view.hosts[0]!.projects[0]!
    expect(project.label).toBe('Web')
    expect(project.sessions.map(s => s.sessionId)).toEqual(['s1', 's2'])
  })

  it('labels an unnamed project after its id', () => {
    const view = rollUpView(rollUp([host('alpha', { projects: [{ projectId: 'p9', sessions: [session('s1')] }] })]))
    expect(view.hosts[0]!.projects[0]!.label).toBe('p9')
  })

  it('shows a host that has said nothing yet', () => {
    // A machine that just opened is real even before it publishes its sessions.
    const view = rollUpView(rollUp([host('alpha')]))
    expect(view.hosts).toHaveLength(1)
    expect(view.hosts[0]!.empty).toBe(true)
  })

  it('counts sessions across every host', () => {
    const view = rollUpView(rollUp([
      host('alpha', { sessions: [session('s1')], projects: [{ projectId: 'p1', sessions: [session('s1')] }] }),
      host('beta', { sessions: [session('s2')], projects: [{ projectId: 'p1', sessions: [session('s2')] }] }),
    ]))
    expect(view.totalSessions).toBe(2)
  })

  it('says so when nothing is open anywhere', () => {
    const view = rollUpView(rollUp([]))
    expect(view.empty).toBe(true)
    expect(view.hosts).toEqual([])
  })

  it('keeps each project’s sessions in the order they arrived', () => {
    // Reordering a conversation list under the cursor is worse than no order.
    const view = rollUpView(rollUp([host('alpha', { projects: [{ projectId: 'p1', sessions: [session('b'), session('a')] }] })]))
    expect(view.hosts[0]!.projects[0]!.sessions.map(s => s.sessionId)).toEqual(['b', 'a'])
  })

  it('carries the ids a click needs', () => {
    // Without these a rendered row is not clickable, and the whole view is a list
    // of words.
    const view = rollUpView(rollUp([host('alpha', {
      self: true,
      sessions: [session('s1', 'p1')],
      projects: [{ projectId: 'p1', sessions: [session('s1', 'p1')] }],
    })]))
    expect(view.hosts[0]!.projects[0]!.sessions[0]).toMatchObject({
      sessionId: 's1', projectId: 'p1', hostId: 'alpha', own: true,
    })
  })

  it('marks another host’s session as not this tab’s', () => {
    const view = rollUpView(rollUp([host('alpha', { self: true }), host('beta', {
      projects: [{ projectId: 'p1', sessions: [session('s2', 'p1')] }],
    })]))
    expect(view.hosts[1]!.projects[0]!.sessions[0]!.own).toBe(false)
  })
  it('qualifies a project name shared by two hosts, on both sides', () => {
    // §8.3: the same basename on two machines is two projects; neither row
    // may read as the other one.
    const view = rollUpView(rollUp([
      host('alpha', { self: true, projects: [{ projectId: 'p1', projectTitle: 'Web', sessions: [session('s1')] }] }),
      host('beta', { projects: [{ projectId: 'p1', projectTitle: 'Web', sessions: [session('s2')] }] }),
    ]))
    const alphaProject = view.hosts.find(h => h.hostId === 'alpha')!.projects[0]!
    const betaProject = view.hosts.find(h => h.hostId === 'beta')!.projects[0]!
    expect(alphaProject.label).toBe('Web · ALPHA')
    expect(betaProject.label).toBe('Web · BETA')
    expect(alphaProject.sharedName).toBe(true)
    expect(alphaProject.baseLabel).toBe('Web')
  })

  it('leaves a unique project name unqualified', () => {
    const view = rollUpView(rollUp([
      host('alpha', { self: true, projects: [{ projectId: 'p1', projectTitle: 'Web', sessions: [session('s1')] }] }),
      host('beta', { projects: [{ projectId: 'p2', projectTitle: 'Bench', sessions: [] }] }),
    ]))
    const project = view.hosts.find(h => h.hostId === 'alpha')!.projects[0]!
    expect(project.label).toBe('Web')
    expect(project.sharedName).toBe(false)
  })

  it('counts each host’s sessions on the host row', () => {
    const view = rollUpView(rollUp([
      host('alpha', { self: true, projects: [{ projectId: 'p1', projectTitle: 'Web', sessions: [session('s1'), session('s2')] }] }),
      host('beta', { projects: [{ projectId: 'p1', projectTitle: 'Web', sessions: [session('s3')] }] }),
    ]))
    expect(view.hosts.find(h => h.hostId === 'alpha')!.sessionCount).toBe(2)
    expect(view.hosts.find(h => h.hostId === 'beta')!.sessionCount).toBe(1)
    expect(view.totalSessions).toBe(3)
  })
})
